// Db — the repository surface handed to handlers, wrapping the DO's in-process
// SqlStorage. This is the single ACL chokepoint — all reads go through the read
// engine: every find/insert/update/delete resolves a scope for the
// caller's identity and is denied, row-filtered, or field-projected accordingly.
//
// Generic over the app's schema S: method inputs and results are typed against
// the entity definitions (sdk/infer.ts). Types are erased at runtime — the body
// works in terms of plain strings and Rows.
//
// Every Db also records the tables it touched during one handler run (`touched`),
// which the live-query layer uses to decide which subscriptions to re-check.
// Create a fresh Db per handler run so identity and `touched` are scoped.

import {
  AclDenied,
  ALLOW_ALL,
  compileScopedWhere,
  effectiveFields,
  projectRow,
  resolveRelationScope,
  resolveScope,
  resolveWriteRules,
  type AclContext,
  type Scope,
} from "./acl";
import type { Validator } from "../sdk/acl";
import {
  and,
  cmp,
  compileAggregate,
  compileCount,
  compileExpr,
  compileSelect,
  eq,
  inList,
  or,
  TRUE,
  type AggFn,
  type OrderBy,
  type SqlExpr,
} from "./read-engine";
import { BadRequest } from "./errors";
import { enqueueTask } from "./outbox";
import type { Dialect, Driver } from "./driver";
import { partitionOf, triggersOf, triggerFires, type EntityFields, type FieldDef, type RelationDef, type SchemaDef, type TriggerOp } from "../sdk/schema";
import { isValidUuid } from "../sdk/uuid";
import type { Cell, FieldsOf, InferInsert, InferRow, InferUpdate, RelationsOf, RelationsResult, WhereClause } from "../sdk/infer";

type Row = Record<string, unknown>;
type Action = "read" | "create" | "update" | "delete";
type Id = string | number | bigint;
type Selected = Partial<Record<string, true>> | undefined;

const DEFAULT_PAGE_SIZE = 50;

/** Compare two decoded cell values for trigger change-detection. Primitives by ===;
 * json/object cells (already parsed) by structural JSON equality. */
function cellEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function normalizeOrder(orderBy: unknown): OrderBy[] | undefined {
  if (!orderBy) return undefined;
  return (Array.isArray(orderBy) ? orderBy : [orderBy]) as OrderBy[];
}

type OrderSpec<S extends SchemaDef, T extends keyof S> = {
  column: keyof FieldsOf<S[T]> & string;
  dir?: "asc" | "desc";
};

export interface FindSpec<S extends SchemaDef, T extends keyof S> {
  from: T;
  where?: WhereClause<S, T>;
  orderBy?: OrderSpec<S, T> | OrderSpec<S, T>[];
  limit?: number;
  offset?: number;
  /** Eager-load relations. Each loaded relation is independently ACL-checked. */
  with?: Partial<Record<keyof RelationsOf<S[T]> & string, true>>;
}

/** Cursor (keyset) pagination input — `after` is an opaque cursor from a prior page. */
export interface PageSpec<S extends SchemaDef, T extends keyof S> {
  from: T;
  where?: WhereClause<S, T>;
  orderBy?: OrderSpec<S, T> | OrderSpec<S, T>[];
  limit?: number;
  after?: string;
  with?: Partial<Record<keyof RelationsOf<S[T]> & string, true>>;
}

export interface Page<R> {
  items: R[];
  /** Opaque cursor for the last item — pass as `after` to fetch the next page. */
  cursor: string | null;
  hasMore: boolean;
}

/** The aggregations map of an aggregate spec, keyed by output column name. */
type Aggregations<F extends EntityFields> = Record<string, { fn: AggFn; column?: keyof F & string }>;

export interface AggregateSpec<S extends SchemaDef, T extends keyof S> {
  from: T;
  where?: WhereClause<S, T>;
  groupBy?: (keyof FieldsOf<S[T]> & string) | (keyof FieldsOf<S[T]> & string)[];
  aggregations: Aggregations<FieldsOf<S[T]>>;
}

/** One aggregate result row: loosely typed (any output column -> value). */
export type AggregateRow = Record<string, number | string | null>;

// --- precise aggregate result inference (groupBy keys + per-aggregation values) ---

type GroupKeys<G> = G extends readonly (infer K)[] ? K : G;

/** The value type of a single aggregation: count -> number; min/max -> the column's
 * own type (nullable); sum/avg -> number | null. */
type AggValue<Fn extends AggFn, Col, F extends EntityFields> = Fn extends "count"
  ? number
  : Fn extends "min" | "max"
    ? Col extends keyof F
      ? Cell<F[Col]> | null
      : number | null
    : number | null;

/** A result row inferred from a (groupBy, aggregations) spec: group columns keep
 * their schema type, each aggregation gets its computed value type. */
export type AggregateResult<F extends EntityFields, G, A extends Aggregations<F>> = {
  [K in Extract<GroupKeys<G>, keyof F & string>]: Cell<F[K]>;
} & { [K in keyof A]: AggValue<A[K]["fn"], A[K]["column"], F> };

function encodeCursor(order: OrderBy[], row: Row): string {
  const vals = order.map((o) => row[o.column]);
  return btoa(JSON.stringify(vals)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(s: string): unknown[] {
  try {
    const arr = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    if (!Array.isArray(arr)) throw new Error("not an array");
    return arr;
  } catch {
    throw new BadRequest("invalid cursor");
  }
}

// Strictly-after predicate for a composite key: lexicographic comparison,
// e.g. (a,b) after (a0,b0) => a>a0 OR (a=a0 AND b>b0); DESC columns flip to <.
function keysetAfter(order: OrderBy[], values: unknown[]): SqlExpr {
  const ors: SqlExpr[] = [];
  for (let i = 0; i < order.length; i++) {
    const parts: SqlExpr[] = [];
    for (let j = 0; j < i; j++) parts.push(eq(order[j]!.column, values[j]));
    const o = order[i]!;
    parts.push(o.dir === "desc" ? cmp("<", o.column, values[i]) : cmp(">", o.column, values[i]));
    ors.push(parts.length === 1 ? parts[0]! : and(...parts));
  }
  return ors.length === 1 ? ors[0]! : or(...ors);
}

export class Db<S extends SchemaDef = SchemaDef> {
  /** Tables read or written during this Db's lifetime. */
  readonly touched = new Set<string>();
  /** Tasks enqueued by declarative triggers during this Db's lifetime — the DO adds
   * this to ctx.tasks enqueues to decide whether to arm its drain alarm. */
  private taskEnqueueCount = 0;
  get taskEnqueues(): number {
    return this.taskEnqueueCount;
  }
  private readonly dialect: Dialect;
  private readonly acl: AclContext;

  constructor(
    private readonly driver: Driver,
    acl: AclContext,
    private readonly schema: SchemaDef,
  ) {
    // The ACL context normally already carries the schema (set at the dispatch / DO
    // boundary). Inject it as a safety net so a context built without one can still
    // compile relation-aware `where` rules into subqueries rather than failing obscurely.
    this.acl = acl.schema ? acl : { ...acl, schema };
    this.dialect = driver.dialect;
  }

  /** Partition guard. When this Db's context carries an active partition (a
   * partition-DO knows which partition it serves), reject any access to a table
   * that lives in a different partition — a partition-DO only owns its own tables,
   * so touching another partition's table is a routing bug, not an empty result.
   * Unset partition (the D1/Worker shared-store path, or a single-partition app on
   * the default DO with no header) makes this a no-op. */
  private assertInPartition(table: string): void {
    const self = this.acl.partition;
    if (self === undefined) return;
    const tablePartition = partitionOf(this.schema, table);
    if (tablePartition !== self) {
      throw new BadRequest(`table '${table}' is in partition '${tablePartition}', not this partition '${self}'`);
    }
  }

  /** Resolve the ACL scope for an operation, or grant everything in SYSTEM mode. */
  private scopeFor(entity: string, action: Action): Scope {
    if (this.acl.system) return ALLOW_ALL;
    return resolveScope(this.acl, entity, action);
  }

  /** Forced `set` values + validators for a write (empty in SYSTEM mode). The two
   * halves are applied separately so the cell-level field check can run AFTER `set`
   * (so a conditional `when` sees forced columns) but BEFORE `validate`. */
  private writeRules(entity: string, action: "create" | "update"): { set: Row; validators: Validator[] } {
    if (this.acl.system) return { set: {}, validators: [] };
    return resolveWriteRules(this.acl, entity, action);
  }

  /** Run write validators against the final values; a throw surfaces as a 400. */
  private runValidators(validators: Validator[], values: Row): void {
    for (const validate of validators) {
      try {
        validate({ identity: this.acl.identity, values });
      } catch (e) {
        throw new BadRequest(e instanceof Error ? e.message : "validation failed");
      }
    }
  }

  /** Enforce field-level (incl. cell-level) write permission for one row. `setCols`
   * are server-forced values that bypass the restriction. `evalRow` is the row the
   * per-row grants are evaluated against (candidate on insert, post-merge on update). */
  private checkWriteFields(
    table: string,
    action: "create" | "update",
    scope: Scope,
    writtenCols: string[],
    evalRow: Row,
    setCols: Set<string>,
  ): void {
    const allowed = effectiveFields(scope, evalRow, this.acl.identity);
    if (!allowed) return; // all fields permitted for this row
    for (const c of writtenCols) {
      if (!setCols.has(c) && !allowed.includes(c)) throw new AclDenied(table, action, c);
    }
  }

  /** Reject ordering by a column the caller cannot read (closes an info-leak: order
   * and the keyset cursor would otherwise expose a hidden column's values). Columns
   * granted only conditionally are NOT orderable. */
  private assertReadableCols(from: string, scope: Scope, cols: string[]): void {
    if (scope.fields === null) return;
    for (const c of cols) if (!scope.fields.includes(c)) throw new AclDenied(from, "read", c);
  }

  /** Structured read; ACL row-scope is AND-ed in, permitted fields projected.
   * Selected relations are eager-loaded, each independently ACL-checked. */
  async find<T extends keyof S & string>(
    spec: FindSpec<S, T>,
  ): Promise<(InferRow<FieldsOf<S[T]>> & RelationsResult<S, T>)[]> {
    const from = spec.from as string;
    this.touched.add(from);
    this.assertInPartition(from);
    const scope = this.scopeFor(from, "read");
    if (!scope.allowed) throw new AclDenied(from, "read");

    const where = this.readWhere(from, spec.where, scope);
    const orderBy = normalizeOrder(spec.orderBy);
    if (orderBy) this.assertReadableCols(from, scope, orderBy.map((o) => o.column));
    const raw = await this.selectRaw(from, where, orderBy, spec.limit, spec.offset);
    return (await this.finishRows(from, raw, scope, spec.with as Selected)) as (InferRow<FieldsOf<S[T]>> &
      RelationsResult<S, T>)[];
  }

  /** Cursor (keyset) pagination. Stable under inserts/deletes; the PK is appended
   * to `orderBy` as a tiebreaker so the keyset is unique. Returns the page plus an
   * opaque `cursor` (pass back as `after`) and whether more rows remain. */
  async page<T extends keyof S & string>(
    spec: PageSpec<S, T>,
  ): Promise<Page<InferRow<FieldsOf<S[T]>> & RelationsResult<S, T>>> {
    const from = spec.from as string;
    this.touched.add(from);
    this.assertInPartition(from);
    const scope = this.scopeFor(from, "read");
    if (!scope.allowed) throw new AclDenied(from, "read");

    const order = this.orderWithPk(from, spec.orderBy);
    this.assertReadableCols(from, scope, order.map((o) => o.column)); // order + cursor must not leak hidden cols
    let where = this.readWhere(from, spec.where, scope);
    if (spec.after != null) where = and(where, keysetAfter(order, decodeCursor(spec.after)));

    const limit = spec.limit ?? DEFAULT_PAGE_SIZE;
    const raw = await this.selectRaw(from, where, order, limit + 1); // +1 to detect a next page
    const hasMore = raw.length > limit;
    if (hasMore) raw.length = limit;

    const last = raw[raw.length - 1];
    const cursor = last ? encodeCursor(order, last) : null; // from raw row (has all order cols)
    const items = (await this.finishRows(from, raw, scope, spec.with as Selected)) as (InferRow<FieldsOf<S[T]>> &
      RelationsResult<S, T>)[];
    return { items, cursor, hasMore };
  }

  /** Count rows visible to the caller (ACL read scope applied). */
  async count<T extends keyof S & string>(spec: { from: T; where?: WhereClause<S, T> }): Promise<number> {
    const from = spec.from as string;
    this.touched.add(from);
    this.assertInPartition(from);
    const scope = this.scopeFor(from, "read");
    if (!scope.allowed) throw new AclDenied(from, "read");
    const where = this.readWhere(from, spec.where, scope);
    const { sql, params } = compileCount(from, this.dialect, where);
    const rows = (await this.driver.exec(sql, params)) as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  }

  /** Grouped aggregation (count/sum/avg/min/max). ACL read scope is applied, and
   * every referenced column must be readable under field permissions. The result
   * row type is inferred from the spec: group columns keep their schema type and
   * each aggregation gets its computed value type. */
  async aggregate<
    T extends keyof S & string,
    A extends Aggregations<FieldsOf<S[T]>>,
    G extends (keyof FieldsOf<S[T]> & string) | (keyof FieldsOf<S[T]> & string)[] = never,
  >(spec: {
    from: T;
    where?: WhereClause<S, T>;
    groupBy?: G;
    aggregations: A;
  }): Promise<AggregateResult<FieldsOf<S[T]>, G, A>[]> {
    const from = spec.from as string;
    this.touched.add(from);
    this.assertInPartition(from);
    const scope = this.scopeFor(from, "read");
    if (!scope.allowed) throw new AclDenied(from, "read");

    const groupBy = (spec.groupBy ? (Array.isArray(spec.groupBy) ? spec.groupBy : [spec.groupBy]) : []) as string[];

    // A json/fileRef cell is JSON; grouping/min/max over it would return the raw
    // string (the codec only runs on row reads), so reject it rather than leak/lie.
    const jsonCols = new Set(this.jsonColsOf(from));
    for (const c of groupBy) if (jsonCols.has(c)) throw new BadRequest(`cannot group by a json column: ${c}`);
    for (const agg of Object.values(spec.aggregations)) {
      if (agg.column && jsonCols.has(agg.column as string)) {
        throw new BadRequest(`cannot aggregate a json column: ${agg.column as string}`);
      }
    }

    if (scope.fields) {
      const refs = new Set<string>(groupBy);
      for (const agg of Object.values(spec.aggregations)) if (agg.column) refs.add(agg.column as string);
      for (const c of refs) if (!scope.fields.includes(c)) throw new AclDenied(from, "read", c);
    }

    const where = this.readWhere(from, spec.where, scope);
    const { sql, params } = compileAggregate({ from, where, groupBy, aggregations: spec.aggregations }, this.dialect);
    return (await this.driver.exec(sql, params)) as AggregateResult<FieldsOf<S[T]>, G, A>[];
  }

  // --- read internals shared by find/page ---

  private readWhere(from: string, userWhere: unknown, scope: Scope): SqlExpr {
    // Compiles the user's where relation-aware (relation keys → security-scoped
    // subqueries), then AND-merges the entity's own ACL row scope.
    if (userWhere) this.assertReadableWhere(from, scope, userWhere);
    const userExpr: SqlExpr = userWhere ? compileScopedWhere(userWhere as Record<string, unknown>, from, this.acl) : TRUE;
    return scope.where ? and(userExpr, scope.where) : userExpr;
  }

  /** Reject a user `where` that filters on a column the caller cannot read (closes
   * the same info-leak as ordering by a hidden column: a filter is an oracle for a
   * hidden field's values). Mirrors `assertReadableCols`. Relation keys are skipped
   * here — they're filtered through the TARGET's read scope in acl.relationPredicate
   * — and AND/OR groups recurse. Operator objects (`{ gt: … }`) sit under the column
   * key, so checking the top-level keys is sufficient. */
  private assertReadableWhere(from: string, scope: Scope, where: unknown): void {
    if (scope.fields === null || where == null || typeof where !== "object") return;
    const relations = this.schema[from]?.relations ?? {};
    for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
      if (k === "AND" || k === "OR") {
        for (const g of v as unknown[]) this.assertReadableWhere(from, scope, g);
      } else if (relations[k]) {
        continue; // relation traversal: enforced against the target's scope downstream
      } else if (!scope.fields.includes(k)) {
        throw new AclDenied(from, "read", k);
      }
    }
  }

  private async selectRaw(from: string, where: SqlExpr, orderBy?: OrderBy[], limit?: number, offset?: number): Promise<Row[]> {
    const { sql, params } = compileSelect({ from, where, orderBy, limit, offset }, this.dialect);
    return this.decodeRows(from, await this.driver.exec(sql, params));
  }

  // --- JSON codec: a `json` or `fileRef` column is stored as a JSON TEXT cell but
  // handlers see/write the parsed value. Decode on read, encode (stringify) on write. ---

  private jsonColsOf(table: string): string[] {
    const fields = this.schema[table]?.fields;
    if (!fields) return [];
    return Object.entries(fields)
      .filter(([, f]) => (f as FieldDef).type === "json" || (f as FieldDef).type === "fileRef")
      .map(([n]) => n);
  }

  /** Columns marked `hidden()` — never projected on an ORM read (even SYSTEM/full). */
  private hiddenColsOf(table: string): string[] {
    const fields = this.schema[table]?.fields;
    if (!fields) return [];
    return Object.entries(fields)
      .filter(([, f]) => (f as FieldDef).hidden)
      .map(([n]) => n);
  }

  /** Drop hidden columns from a row (copying only if any are present). */
  private stripHidden(table: string, row: Row): Row {
    const hidden = this.hiddenColsOf(table);
    if (hidden.length === 0) return row;
    const out = { ...row };
    for (const c of hidden) delete out[c];
    return out;
  }

  /** Fire declarative write-triggers for `op` on `entity`: enqueue a task per matching
   * trigger into the outbox, in THIS mutation's transaction (atomic with the write).
   * `row` is the affected row (decoded — new values for create/update, the removed row
   * for delete); `writtenCols` are the columns the write touched; `before` is the prior
   * row (update only) for value-change detection on a field-filtered trigger.
   *
   * - Hidden columns are STRIPPED from the payload row — `hidden()` ("never readable via
   *   the ORM, even under SYSTEM") must hold here too, or a secret like passwordHash
   *   would leak to a task handler / webhook.
   * - A field-filtered update trigger fires only when a watched column's value actually
   *   CHANGED (not merely was written to the same value).
   * - Suppressed in the task-drain context, so a task's own writes don't re-fire
   *   triggers (preventing a trigger→task→write→trigger cascade). */
  private async fireTriggers(
    entity: string,
    op: TriggerOp,
    row: Row,
    writtenCols: string[],
    before?: Row,
  ): Promise<void> {
    if (this.acl.suppressTriggers) return;
    const triggers = triggersOf(this.schema, entity);
    if (triggers.length === 0) return;
    const id = row[this.pkOf(entity)];
    let safeRow: Row | undefined;
    for (const t of triggers) {
      if (!triggerFires(t, op, writtenCols)) continue;
      if (op === "update" && Array.isArray(t.on.update) && before) {
        const changed = t.on.update.some((c) => writtenCols.includes(c) && !cellEqual(before[c], row[c]));
        if (!changed) continue; // watched column(s) written, but value unchanged
      }
      if (!safeRow) safeRow = this.stripHidden(entity, row); // never leak hidden columns
      await enqueueTask(this.driver, Date.now(), { kind: t.task, payload: { entity, op, id, row: safeRow } });
      this.taskEnqueueCount++;
    }
  }

  /** Mint a UUID for every `generated()` uuid column the caller omitted, mutating
   * `vals`. Returns the columns it filled — server-minted, so the insert path treats
   * them like forced `set` values (bypassing the writable-field ACL check). */
  private fillGeneratedUuids(table: string, vals: Row): string[] {
    const fields = this.schema[table]?.fields;
    if (!fields) return [];
    const minted: string[] = [];
    for (const [name, f] of Object.entries(fields)) {
      const fd = f as FieldDef;
      if (fd.type === "uuid" && fd.generated && vals[name] == null) {
        vals[name] = crypto.randomUUID();
        minted.push(name);
      }
    }
    return minted;
  }

  /** Reject a malformed value on any uuid column present in `row` (mirrors kvalt's
   * write-time isValidUuid). Absent columns are not checked. */
  private assertValidUuids(table: string, row: Row): void {
    const fields = this.schema[table]?.fields;
    if (!fields) return;
    for (const [name, f] of Object.entries(fields)) {
      if ((f as FieldDef).type !== "uuid") continue;
      const v = row[name];
      if (v != null && !isValidUuid(v)) throw new BadRequest(`invalid UUID for '${name}'`);
    }
  }

  private decodeRows(table: string, rows: Row[]): Row[] {
    const cols = this.jsonColsOf(table);
    if (cols.length === 0) return rows;
    for (const row of rows) {
      for (const c of cols) {
        const v = row[c];
        if (typeof v === "string") {
          try {
            row[c] = JSON.parse(v);
          } catch {
            /* leave a non-JSON value as-is */
          }
        }
      }
    }
    return rows;
  }

  private decodeRow(table: string, row: Row | undefined): Row | undefined {
    return row ? this.decodeRows(table, [row])[0] : row;
  }

  /** Encode one write cell: JSON-stringify a json/fileRef value, then dialect-encode. */
  private encodeCell(jsonCols: Set<string>, col: string, v: unknown): unknown {
    if (v != null && jsonCols.has(col)) return this.dialect.encode(JSON.stringify(v));
    return this.dialect.encode(v);
  }

  /** Fetch one row by id within an ACL row-scope (for per-row write evaluation). */
  private async fetchOne(from: string, id: Id, scopeWhere: SqlExpr | null): Promise<Row | undefined> {
    const pk = this.pkOf(from);
    const where = scopeWhere ? and(eq(pk, id), scopeWhere) : eq(pk, id);
    const { sql, params } = compileSelect({ from, where, limit: 1 }, this.dialect);
    return this.decodeRow(from, (await this.driver.exec(sql, params))[0] as Row | undefined);
  }

  private async finishRows(from: string, raw: Row[], scope: Scope, withSel: Selected): Promise<Row[]> {
    const relNames = withSel ? Object.keys(withSel).filter((k) => withSel[k]) : [];
    for (const relName of relNames) await this.loadRelation(from, raw, relName);
    // Hidden columns are stripped even under an unrestricted/SYSTEM scope (never readable).
    if (scope.fields === null) return raw.map((r) => this.stripHidden(from, r));
    return raw.map((r) => {
      const projected = this.stripHidden(from, projectRow(r, effectiveFields(scope, r, this.acl.identity)));
      for (const relName of relNames) projected[relName] = r[relName]; // relations survive projection
      return projected;
    });
  }

  private orderWithPk(from: string, orderBy: unknown): OrderBy[] {
    const out = (normalizeOrder(orderBy) ?? []).map((o) => ({ column: o.column, dir: o.dir }));
    const pk = this.pkOf(from);
    if (!out.some((o) => o.column === pk)) out.push({ column: pk, dir: out[out.length - 1]?.dir ?? "asc" });
    return out;
  }

  private pkOf(from: string): string {
    const fields = this.schema[from]?.fields;
    if (fields) for (const [name, f] of Object.entries(fields)) if ((f as FieldDef).primaryKey) return name;
    return "id";
  }

  /** Eager-load one relation onto `rows` (mutates them). Traversal is ACL-checked
   * via resolveRelationScope: the related read scope OR a parent directAccess grant. */
  private async loadRelation(parentEntity: string, rows: Row[], relName: string): Promise<void> {
    const rel = this.schema[parentEntity]?.relations?.[relName] as RelationDef | undefined;
    if (!rel) throw new Error(`unknown relation: ${parentEntity}.${relName}`);

    this.touched.add(rel.target);
    const scope = this.acl.system ? ALLOW_ALL : resolveRelationScope(this.acl, parentEntity, relName, rel.target);
    if (!scope.allowed) throw new AclDenied(rel.target, "read");

    const project = (row: Row): Row => projectRow(row, effectiveFields(scope, row, this.acl.identity));
    // One IN query per relation (no N+1). Match column before projecting (which
    // may drop the join column).
    const fetchBy = async (col: string, values: unknown[]): Promise<Array<{ key: unknown; row: Row }>> => {
      if (values.length === 0) return [];
      const where = scope.where ? and(inList(col, values), scope.where) : inList(col, values);
      const { sql, params } = compileSelect({ from: rel.target, where }, this.dialect);
      const rows = this.decodeRows(rel.target, await this.driver.exec(sql, params));
      return rows.map((row) => ({ key: row[col], row: project(row) }));
    };

    if (rel.kind === "belongsTo") {
      // parent[column] -> target.id
      const keys = [...new Set(rows.map((r) => r[rel.column]).filter((v) => v != null))];
      const byId = new Map<unknown, Row>();
      for (const { key, row } of await fetchBy(this.pkOf(rel.target), keys)) byId.set(key, row);
      for (const r of rows) r[relName] = r[rel.column] != null ? (byId.get(r[rel.column]) ?? null) : null;
    } else {
      // hasMany: target[column] -> parent.id
      const ids = [...new Set(rows.map((r) => r.id).filter((v) => v != null))];
      const grouped = new Map<unknown, Row[]>();
      for (const { key, row } of await fetchBy(rel.column, ids)) {
        const bucket = grouped.get(key) ?? grouped.set(key, []).get(key)!;
        bucket.push(row);
      }
      for (const r of rows) r[relName] = grouped.get(r.id) ?? [];
    }
  }

  /** Insert a single row, returning the persisted row. */
  async insert<T extends keyof S & string>(
    table: T,
    values: InferInsert<FieldsOf<S[T]>>,
  ): Promise<InferRow<FieldsOf<S[T]>>> {
    this.touched.add(table);
    this.assertInPartition(table);
    const scope = this.scopeFor(table, "create");
    if (!scope.allowed) throw new AclDenied(table, "create");
    const vals = { ...(values as Row) };
    const { set, validators } = this.writeRules(table, "create");
    Object.assign(vals, set); // forced server values first, so a conditional `when` can see them
    // Auto-mint generated() uuid columns the caller omitted; server-minted, so they
    // join `set` in the bypass-list for the writable-field check.
    const generatedCols = this.fillGeneratedUuids(table, vals);
    this.checkWriteFields(table, "create", scope, Object.keys(vals), vals, new Set([...Object.keys(set), ...generatedCols]));
    this.runValidators(validators, vals);
    this.assertValidUuids(table, vals);

    const cols = Object.keys(vals);
    const jsonCols = new Set(this.jsonColsOf(table));
    const colList = cols.map((c) => this.dialect.id(c)).join(", ");
    const phs = cols.map((_, i) => this.dialect.placeholder(i + 1)).join(", ");
    const params = cols.map((c) => this.encodeCell(jsonCols, c, vals[c]));
    const sql = `INSERT INTO ${this.dialect.id(table)} (${colList}) VALUES (${phs})${this.returningClause("*")}`;
    const rows = await this.driver.exec(sql, params);
    const persisted = this.decodeRow(table, rows[0])!;
    await this.fireTriggers(table, "create", persisted, cols);
    return this.projectWrite(table, persisted, cols) as InferRow<FieldsOf<S[T]>>;
  }

  /** Project a mutation's RETURNING row so the echo never reveals more than a read
   * would: the caller's readable fields for this row, PLUS the columns they just
   * wrote (which they already know) and the primary key (so a write-only caller
   * still gets the generated id). Full read access -> the whole row; SYSTEM -> as-is.
   * This makes create/update echoes field-ACL-safe without ever collapsing to {}.
   * Hidden columns are never echoed, even when written or under SYSTEM. */
  private projectWrite(table: string, row: Row, writtenCols: string[]): Row {
    if (this.acl.system) return this.stripHidden(table, row);
    const visible = new Set<string>([this.pkOf(table), ...writtenCols]);
    const readScope = this.scopeFor(table, "read");
    if (readScope.allowed) {
      const readable = effectiveFields(readScope, row, this.acl.identity);
      if (readable === null) return this.stripHidden(table, row); // unrestricted read -> echo everything (minus hidden)
      for (const f of readable) visible.add(f);
    }
    for (const c of this.hiddenColsOf(table)) visible.delete(c);
    return projectRow(row, [...visible]);
  }

  /** Update a row by id. ACL row-scope is AND-ed into the WHERE, so a caller can
   * only update rows within scope; returns undefined if none matched. */
  async update<T extends keyof S & string>(
    table: T,
    id: Id,
    patch: InferUpdate<FieldsOf<S[T]>>,
  ): Promise<InferRow<FieldsOf<S[T]>> | undefined> {
    this.touched.add(table);
    this.assertInPartition(table);
    const scope = this.scopeFor(table, "update");
    if (!scope.allowed) throw new AclDenied(table, "update");
    const p = { ...(patch as Row) };
    const { set, validators } = this.writeRules(table, "update");
    Object.assign(p, set); // forced server values first
    const cols = Object.keys(p);
    if (cols.length === 0) return undefined;

    // Fetch the existing row when we need it: for per-row field permission (evaluated
    // against the FINAL post-merge row) OR for a field-filtered update trigger's
    // value-change detection (so it fires only on an actual change, not a same-value write).
    const needCellEval = scope.fields !== null && (scope.conditional.length > 0 || scope.fieldsFns.length > 0);
    const needBefore = !this.acl.suppressTriggers && triggersOf(this.schema, table).some((t) => Array.isArray(t.on.update));
    let evalRow: Row = p;
    let before: Row | undefined;
    if (needCellEval || needBefore) {
      const existing = await this.fetchOne(table, id, scope.where);
      if (!existing) return undefined; // out of update scope -> no-op
      before = existing;
      if (needCellEval) evalRow = { ...existing, ...p };
    }
    this.checkWriteFields(table, "update", scope, cols, evalRow, new Set(Object.keys(set)));
    this.runValidators(validators, p);
    this.assertValidUuids(table, p);

    const params: unknown[] = [];
    const jsonCols = new Set(this.jsonColsOf(table));
    const assignments = cols
      .map((c) => {
        params.push(this.encodeCell(jsonCols, c, p[c]));
        return `${this.dialect.id(c)} = ${this.dialect.placeholder(params.length)}`;
      })
      .join(", ");
    params.push(this.dialect.encode(id));
    let sql = `UPDATE ${this.dialect.id(table)} SET ${assignments} WHERE ${this.dialect.id(this.pkOf(table))} = ${this.dialect.placeholder(params.length)}`;
    sql += this.scopeClause(scope.where, params);
    sql += this.returningClause("*");
    const updated = this.decodeRow(table, (await this.driver.exec(sql, params))[0]);
    if (updated) await this.fireTriggers(table, "update", updated, cols, before);
    return (updated ? this.projectWrite(table, updated, cols) : undefined) as InferRow<FieldsOf<S[T]>> | undefined;
  }

  /** Delete a row by id within scope. Returns whether a row was deleted. */
  async delete<T extends keyof S & string>(table: T, id: Id): Promise<boolean> {
    this.touched.add(table);
    this.assertInPartition(table);
    const scope = this.scopeFor(table, "delete");
    if (!scope.allowed) throw new AclDenied(table, "delete");
    const params: unknown[] = [this.dialect.encode(id)];
    let sql = `DELETE FROM ${this.dialect.id(table)} WHERE ${this.dialect.id(this.pkOf(table))} = ${this.dialect.placeholder(1)}`;
    sql += this.scopeClause(scope.where, params);
    sql += this.returningClause("*");
    const deleted = this.decodeRow(table, (await this.driver.exec(sql, params))[0]);
    if (deleted) await this.fireTriggers(table, "delete", deleted, []);
    return deleted != null;
  }

  /** Escape hatch — raw SQL, NOT ACL-checked. For system/internal use only. */
  async exec(sql: string, ...params: unknown[]): Promise<Row[]> {
    return this.driver.exec(sql, params.map((p) => this.dialect.encode(p)));
  }

  // RETURNING is supported on SQLite/Postgres; a dialect without it (MySQL) would
  // need an insert-then-select-back path — not implemented in this spike.
  private returningClause(cols: string): string {
    return this.dialect.returning ? ` RETURNING ${cols}` : "";
  }

  private scopeClause(where: SqlExpr | null, params: unknown[]): string {
    if (!where) return "";
    const compiled = compileExpr(where, this.dialect, params);
    return compiled.sql === "1" ? "" : ` AND (${compiled.sql})`;
  }
}
