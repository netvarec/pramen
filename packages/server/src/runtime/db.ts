// Db: the repository surface handed to handlers, wrapping the DO's in-process
// SqlStorage. This is the single ACL chokepoint: all reads go through the read
// engine: every find/insert/update/delete resolves a scope for the
// caller's identity and is denied, row-filtered, or field-projected accordingly.
//
// Generic over the app's schema S: method inputs and results are typed against
// the entity definitions (sdk/infer.ts). Types are erased at runtime, so the body
// works in terms of plain strings and Rows.
//
// Every Db also records the tables it touched during one handler run (`touched`),
// which the live-query layer uses to decide which subscriptions to re-check.
// Create a fresh Db per handler run so identity and `touched` are scoped.

import {
  ACL_FLAG_PREFIX,
  AclDenied,
  ALLOW_ALL,
  anyGrantApplies,
  assertReadableWhereKeys,
  checkFlagPredicates,
  compileScopedWhere,
  effectiveFields,
  flagColumns,
  hasCheck,
  hasFieldsFn,
  possibleFields,
  predicateHolds,
  projectRow,
  resolveRelationScope,
  resolveScope,
  resolveWriteRules,
  scopeInputColumns,
  type AclContext,
  type Scope,
} from "./acl";
import type { Validator } from "../sdk/acl";
import type { CellValue, Row as SharedRow } from "../sdk/infer";
import type { WhereRule } from "../sdk/acl";
import {
  and,
  cmp,
  columnsInExpr,
  compileAggregate,
  compileCount,
  compileExpr,
  compileFlags,
  compileSelect,
  eq,
  evalExpr,
  FALSE,
  hasSub,
  inList,
  isNull,
  or,
  TRUE,
  type AggFn,
  type OrderBy,
  type SqlExpr,
} from "./read-engine";
import { BadRequest, Conflict } from "./errors";
import { enqueueTask } from "./outbox";
import type { Dialect, Driver } from "./driver";
import { partitionOf, triggersOf, triggerFires, type EntityFields, type FieldDef, type RelationDef, type SchemaDef, type TriggerOp } from "../sdk/schema";
import { isValidUuid } from "../sdk/uuid";
import type { Cell, FieldsOf, InferInsert, InferRow, InferUpdate, RelationsOf, RelationsResult, WhereClause } from "../sdk/infer";

type Row = SharedRow;
type Action = "read" | "create" | "update" | "delete";
type Id = string | number | bigint;
type Selected = Partial<Record<string, true>> | undefined;

const DEFAULT_PAGE_SIZE = 50;

/** How many times an update authorized on a pre-image is re-evaluated after losing a race
 * (the row changed between the pre-image read and the UPDATE) before it is a 409. */
const UPDATE_ATTEMPTS = 3;

/** Flag alias for a scope's own `where` evaluated on a row that isn't stored yet (the
 * create candidate, the write echo), when that `where` traverses a relation. */
const SCOPE_WHERE_FLAG = `${ACL_FLAG_PREFIX}where`;

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
  /** Fetch only these columns (a projection). Each must be readable: a hidden or
   * unreadable column is a 403, like ordering by one. This narrows the SQL SELECT so a
   * wide `json`/`text` column the handler doesn't need never crosses RPC on the D1 path;
   * the PK, order, and relation-join columns are always fetched internally regardless.
   * (Unselected columns are absent at runtime; the return type is not yet narrowed.) */
  select?: readonly (keyof FieldsOf<S[T]> & string)[];
}

/** Cursor (keyset) pagination input. `after` is an opaque cursor from a prior page. */
export interface PageSpec<S extends SchemaDef, T extends keyof S> {
  from: T;
  where?: WhereClause<S, T>;
  orderBy?: OrderSpec<S, T> | OrderSpec<S, T>[];
  limit?: number;
  after?: string;
  with?: Partial<Record<keyof RelationsOf<S[T]> & string, true>>;
  /** Fetch only these columns (see FindSpec.select). Order/cursor columns are always
   * fetched regardless, so a projection never breaks keyset pagination. */
  select?: readonly (keyof FieldsOf<S[T]> & string)[];
}

export interface Page<R> {
  items: R[];
  /** Opaque cursor for the last item; pass as `after` to fetch the next page. */
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

function decodeCursor(s: string): CellValue[] {
  try {
    const arr = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    if (!Array.isArray(arr)) throw new Error("not an array");
    return arr;
  } catch {
    throw new BadRequest("invalid cursor");
  }
}

// Strictly-after predicate for a single order column, NULL-aware. SQLite sorts
// NULLs FIRST for ASC and LAST for DESC, so a naive `col > v` (which is NULL, never
// TRUE, when col or v is NULL) would re-match already-seen NULL rows forever.
//   ASC:  v null    -> any non-null row is after it        (col IS NOT NULL)
//         v non-null-> col > v (NULL cols excluded, they sort before)
//   DESC: v null    -> nothing is strictly after a null    (FALSE; PK tiebreak advances)
//         v non-null-> col < v OR col IS NULL (nulls sort after all non-nulls)
function keysetCmp(o: OrderBy, value: CellValue): SqlExpr {
  const desc = o.dir === "desc";
  if (value === null) return desc ? FALSE : isNull(o.column, true);
  return desc ? or(cmp("<", o.column, value), isNull(o.column)) : cmp(">", o.column, value);
}

// Strictly-after predicate for a composite key: lexicographic comparison,
// e.g. (a,b) after (a0,b0) => a>a0 OR (a=a0 AND b>b0); DESC columns flip to <. Each
// column's comparison and the eq-tiebreaker are NULL-aware (eq() maps null→IS NULL).
function keysetAfter(order: OrderBy[], values: CellValue[]): SqlExpr {
  const ors: SqlExpr[] = [];
  for (let i = 0; i < order.length; i++) {
    const parts: SqlExpr[] = [];
    for (let j = 0; j < i; j++) parts.push(eq(order[j]!.column, values[j]));
    parts.push(keysetCmp(order[i]!, values[i]));
    ors.push(parts.length === 1 ? parts[0]! : and(...parts));
  }
  return ors.length === 1 ? ors[0]! : or(...ors);
}

export class Db<S extends SchemaDef = SchemaDef> {
  /** Tables read or written during this Db's lifetime. */
  readonly touched = new Set<string>();
  /** Tasks enqueued by declarative triggers during this Db's lifetime. The DO adds
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
   * that lives in a different partition: a partition-DO only owns its own tables,
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
   * per-row grants are evaluated against (candidate on insert, post-merge on update);
   * `stored` is the row each policy's own `where` admits (the pre-image on update). */
  private checkWriteFields(
    table: string,
    action: "create" | "update",
    scope: Scope,
    writtenCols: string[],
    evalRow: Row,
    setCols: Set<string>,
    stored: Row = evalRow,
  ): void {
    const allowed = effectiveFields(scope, evalRow, this.acl.identity, stored);
    if (!allowed) return; // all fields permitted for this row
    for (const c of writtenCols) {
      if (!setCols.has(c) && !allowed.includes(c)) throw new AclDenied(table, action, c);
    }
  }

  /** Reject ordering by a column the caller cannot read (closes an info-leak: order
   * and the keyset cursor would otherwise expose a hidden column's values). Columns
   * granted only conditionally are NOT orderable. */
  private assertReadableCols(from: string, scope: Scope, cols: string[]): void {
    // Hidden columns are never readable through the ORM, and not orderable either,
    // regardless of scope (else the order/keyset cursor leaks the hidden value).
    const hidden = new Set(this.hiddenColsOf(from));
    for (const c of cols) if (hidden.has(c)) throw new AclDenied(from, "read", c);
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
    const select = spec.select && spec.select.length > 0 ? [...new Set(spec.select as readonly string[])] : undefined;
    if (select) this.assertSelectable(from, scope, select);
    const columns = this.projectionColumns(from, scope, { select, orderBy, withSel: spec.with as Selected });
    const raw = await this.selectRaw(from, where, orderBy, spec.limit, spec.offset, columns, flagColumns(scope));
    return (await this.finishRows(from, raw, scope, spec.with as Selected, select)) as (InferRow<FieldsOf<S[T]>> &
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

    const select = spec.select && spec.select.length > 0 ? [...new Set(spec.select as readonly string[])] : undefined;
    if (select) this.assertSelectable(from, scope, select);
    // `order` (incl. the PK tiebreaker) is threaded into the projection, so the cursor
    // can always be encoded from the raw row even when the caller narrowed `select`.
    const columns = this.projectionColumns(from, scope, { select, orderBy: order, withSel: spec.with as Selected });

    const limit = spec.limit ?? DEFAULT_PAGE_SIZE;
    const raw = await this.selectRaw(from, where, order, limit + 1, undefined, columns, flagColumns(scope)); // +1 to detect a next page
    const hasMore = raw.length > limit;
    if (hasMore) raw.length = limit;

    const last = raw[raw.length - 1];
    const cursor = last ? encodeCursor(order, last) : null; // from raw row (has all order cols)
    const items = (await this.finishRows(from, raw, scope, spec.with as Selected, select)) as (InferRow<FieldsOf<S[T]>> &
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

    // Hidden columns are never readable through the ORM, so reject group-by / aggregating
    // them UNCONDITIONALLY (independent of scope.fields, which is null under full/SYSTEM
    // read), else min/max/groupBy over a hidden column exposes its values.
    const hiddenCols = new Set(this.hiddenColsOf(from));
    for (const c of groupBy) if (hiddenCols.has(c)) throw new AclDenied(from, "read", c);
    for (const agg of Object.values(spec.aggregations)) {
      if (agg.column && hiddenCols.has(agg.column as string)) throw new AclDenied(from, "read", agg.column as string);
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
    const userExpr: SqlExpr = userWhere ? compileScopedWhere(userWhere as WhereRule, from, this.acl, { untrusted: true }) : TRUE;
    const where = scope.where ? and(userExpr, scope.where) : userExpr;
    // A relation-traversal `where` (or a relation-traversing ACL scope) compiles to a
    // `sub` node over another table. Record those tables in `touched` so the live-query
    // layer re-checks the subscription when the traversed table changes, since otherwise a write
    // there never intersects the sub's read-set and the client stays stale.
    this.addTouchedTables(where);
    return where;
  }

  /** Walk a compiled predicate and add every relation-subquery target table to
   * `touched` (the live-query read-set). Recurses into nested subqueries. */
  private addTouchedTables(expr: SqlExpr | null | undefined): void {
    if (!expr) return;
    switch (expr.t) {
      case "sub":
        this.touched.add(expr.from);
        this.addTouchedTables(expr.where);
        break;
      case "and":
      case "or":
        for (const p of expr.parts) this.addTouchedTables(p);
        break;
      case "not":
        this.addTouchedTables(expr.expr);
        break;
    }
  }

  /** Reject a user `where` that filters on a column the caller cannot read (closes
   * the same info-leak as ordering by a hidden column: a filter is an oracle for a
   * hidden field's values). Mirrors `assertReadableCols`: a `hidden()` column is
   * rejected whatever the scope (allow() and SYSTEM included), an unknown key is a 400,
   * and a belongsTo/oneHasOne key needs its FK readable here, since the join filters on
   * it. The rest of a relation filter is checked against the TARGET's read scope in
   * acl.relationPredicate. AND/OR/NOT groups recurse; operator objects (`{ gt: … }`) sit
   * under the column key, so checking the keys is sufficient. */
  private assertReadableWhere(from: string, scope: Scope, where: unknown): void {
    assertReadableWhereKeys(where, from, scope.fields, this.schema);
  }

  private async selectRaw(
    from: string,
    where: SqlExpr,
    orderBy?: OrderBy[],
    limit?: number,
    offset?: number,
    columns?: readonly string[],
    flags?: { alias: string; expr: SqlExpr }[],
  ): Promise<Row[]> {
    const { sql, params } = compileSelect({ from, where, orderBy, limit, offset, columns, flags }, this.dialect);
    return this.decodeRows(from, await this.driver.exec(sql, params));
  }

  /** Drop the SQL-computed ACL flag columns from a row (copying only if any are present). */
  private stripFlags(row: Row): Row {
    let out: Row | undefined;
    for (const k of Object.keys(row)) {
      if (!k.startsWith(ACL_FLAG_PREFIX)) continue;
      out ??= { ...row };
      delete out[k];
    }
    return out ?? row;
  }

  /** Evaluate relation-traversing ACL predicates against a row that is NOT stored (an
   * insert candidate, an update post-image, a write echo), which a projected flag column
   * can't reach. One probe over a one-row derived table aliased with the entity's own
   * name, so the predicate's bare column names bind to the row's values (a `sub` node
   * qualifies its own inner columns, so they bind to the traversed table). Returns a
   * copy of `row` carrying each predicate's 0/1 flag. */
  private async withFlags(table: string, row: Row, preds: { alias: string; expr: SqlExpr }[]): Promise<Row> {
    if (preds.length === 0) return row;
    const out: Row = { ...row };
    const cols = this.allColsOf(table);
    const names = cols.length > 0 ? cols : Object.keys(row).filter((k) => !k.startsWith(ACL_FLAG_PREFIX));
    if (names.length === 0) {
      for (const p of preds) out[p.alias] = 0;
      return out;
    }
    const jsonCols = new Set(this.jsonColsOf(table));
    const params: CellValue[] = [];
    const flags = compileFlags(preds, this.dialect, params); // the SELECT list's params come first
    const values = names.map((c) => {
      params.push(this.encodeCell(jsonCols, c, (row[c] ?? null) as CellValue));
      return `${this.dialect.placeholder(params.length)} AS ${this.dialect.id(c)}`;
    });
    const sql = `SELECT ${flags.join(", ")} FROM (SELECT ${values.join(", ")}) AS ${this.dialect.id(table)}`;
    const res = ((await this.driver.exec(sql, params))[0] ?? {}) as Row;
    for (const p of preds) out[p.alias] = res[p.alias] ?? 0;
    return out;
  }

  /** Judge a scope's `where` on a row that is NOT stored (the create candidate, the write
   * echo), computing `extra` flag predicates in the same one-row probe. A `where` that
   * traverses a relation can't run in `evalExpr`, so it rides along as a flag; a single-table
   * one is evaluated in memory. `holds` is true when there is no `where`. The ONE place this
   * is decided, so the insert gate and the echo cannot drift apart. */
  private async whereOnUnstored(table: string, row: Row, where: SqlExpr | null, extra: { alias: string; expr: SqlExpr }[]): Promise<{ row: Row; holds: boolean }> {
    const whereFlag = where && hasSub(where) ? [{ alias: SCOPE_WHERE_FLAG, expr: where }] : [];
    const flagged = await this.withFlags(table, row, [...extra, ...whereFlag]);
    if (!where) return { row: flagged, holds: true };
    const holds = whereFlag.length > 0 ? predicateHolds({ expr: where, flag: SCOPE_WHERE_FLAG }, flagged) : evalExpr(where, flagged);
    return { row: flagged, holds };
  }

  /** The insert candidate as the DB would store it, for evaluating the create policy:
   * omitted columns take their literal `default` (an expression default can't be known
   * before the INSERT, so such a column reads as NULL and a predicate on it fails closed). */
  private withDefaults(table: string, vals: Row): Row {
    const fields = this.schema[table]?.fields;
    if (!fields) return vals;
    const out: Row = { ...vals };
    for (const [name, f] of Object.entries(fields)) {
      const fd = f as FieldDef;
      if (out[name] === undefined && fd.default !== undefined) out[name] = fd.default;
    }
    return out;
  }

  /** A target row may be joined to a parent only through a join column the caller can
   * read ON THAT ROW: a join on a column is an oracle for its value, exactly like a
   * filter. A `hidden()` join column never joins, even under SYSTEM, matching how
   * orderBy/select reject hidden columns regardless of scope. */
  private joinVisible(entity: string, scope: Scope, row: Row, col: string): boolean {
    if (this.hiddenColsOf(entity).includes(col)) return false;
    const fields = effectiveFields(scope, row, this.acl.identity);
    return fields === null || fields.includes(col);
  }

  /** All column names of a table (schema order). */
  private allColsOf(table: string): string[] {
    const fields = this.schema[table]?.fields;
    return fields ? Object.keys(fields) : [];
  }

  /** The parent-side join column an eager-load of `relName` reads off each parent row:
   * belongsTo/oneHasOne carry the FK on this row; the others group by this row's PK
   * (which the projection adds separately). Null for an unknown relation. */
  private joinColOf(from: string, relName: string): string | null {
    const rel = this.schema[from]?.relations?.[relName] as RelationDef | undefined;
    if (!rel) return null;
    return rel.kind === "belongsTo" || rel.kind === "oneHasOne" ? rel.column : this.pkOf(from);
  }

  /** Validate a `select` projection: every column must be readable. Hidden columns are
   * never selectable (as with ordering); a base or conditionally-granted column is fine,
   * but a column outside the caller's read grant is a 403. Skipped when the scope is
   * unrestricted or a field-resolver may grant anything. */
  private assertSelectable(from: string, scope: Scope, cols: readonly string[]): void {
    const hidden = new Set(this.hiddenColsOf(from));
    for (const c of cols) if (hidden.has(c)) throw new AclDenied(from, "read", c);
    const possible = possibleFields(scope);
    if (possible === null) return;
    const allowed = new Set(possible);
    for (const c of cols) if (!allowed.has(c)) throw new AclDenied(from, "read", c);
  }

  /** The columns to SELECT for a read over `from` under `scope`, replacing `SELECT *`,
   * which fetches every column (wide `json`/`text` + `hidden()`) and drops them in JS,
   * paying full RPC cost on the D1 path. Names exactly what can surface:
   *   - the visible field set: an explicit `select`, else the base readable fields ∪ every
   *     conditional-`when` field, else all non-hidden columns when the scope is
   *     unrestricted (fields === null) or a field-resolver (fieldsFn) may expose anything;
   *   - PLUS the columns the machinery needs regardless of visibility: the PK (identity /
   *     relation grouping / cursor), the order-by columns, each eager-loaded relation's
   *     parent-side join column, and the inputs of the per-row grants (cell-`when`s and
   *     each policy's in-memory admission), some of which the caller can't read; they're
   *     fetched, used, then stripped by projectRow/stripHidden before return. A
   *     relation-traversing admission is computed in SQL instead (`flagColumns`).
   * Returns undefined (→ `SELECT *`) only for a schemaless/unknown table. */
  private projectionColumns(
    from: string,
    scope: Scope,
    opts: { select?: readonly string[]; orderBy?: OrderBy[]; withSel?: Selected } = {},
  ): readonly string[] | undefined {
    const all = this.allColsOf(from);
    if (all.length === 0) return undefined; // unknown schema, so leave as SELECT *
    const hidden = new Set(this.hiddenColsOf(from));

    let visible: string[];
    const possible = possibleFields(scope);
    if (opts.select && !hasFieldsFn(scope)) {
      visible = opts.select.filter((c) => !hidden.has(c));
    } else if (possible === null) {
      visible = all.filter((c) => !hidden.has(c)); // unrestricted / resolver may expose anything
    } else {
      visible = possible.filter((c) => !hidden.has(c));
    }

    const cols = new Set<string>(visible);
    cols.add(this.pkOf(from));
    for (const o of opts.orderBy ?? []) cols.add(o.column);
    for (const c of scopeInputColumns(scope)) cols.add(c); // per-row grant inputs
    if (opts.withSel) {
      for (const relName of Object.keys(opts.withSel)) {
        if (!opts.withSel[relName]) continue;
        const jc = this.joinColOf(from, relName);
        if (jc) cols.add(jc);
      }
    }
    const allSet = new Set(all);
    return [...cols].filter((c) => allSet.has(c)); // only ever name real columns
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

  /** Boolean columns, stored as INTEGER 0/1 (SQLite has no boolean), decoded back to
   * true/false on read so handlers see the `boolean` the InferRow type promises. */
  private boolColsOf(table: string): string[] {
    const fields = this.schema[table]?.fields;
    if (!fields) return [];
    return Object.entries(fields)
      .filter(([, f]) => (f as FieldDef).type === "boolean")
      .map(([n]) => n);
  }

  /** Columns marked `hidden()`, never projected on an ORM read (even SYSTEM/full). */
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
   * `row` is the affected row (decoded: new values for create/update, the removed row
   * for delete); `writtenCols` are the columns the write touched; `before` is the prior
   * row (update only) for value-change detection on a field-filtered trigger.
   *
   * - Hidden columns are STRIPPED from the payload row. `hidden()` ("never readable via
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
   * `vals`. Returns the columns it filled: server-minted, so the insert path treats
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
    const boolCols = this.boolColsOf(table);
    if (cols.length === 0 && boolCols.length === 0) return rows;
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
      // INTEGER 0/1 -> boolean (leave NULL as null for a nullable bool column).
      for (const c of boolCols) {
        const v = row[c];
        if (typeof v === "number") row[c] = v !== 0;
        else if (typeof v === "bigint") row[c] = v !== 0n;
      }
    }
    return rows;
  }

  private decodeRow(table: string, row: Row | undefined): Row | undefined {
    return row ? this.decodeRows(table, [row])[0] : row;
  }

  /** Encode one write cell: JSON-stringify a json/fileRef value, then dialect-encode. */
  private encodeCell(jsonCols: Set<string>, col: string, v: CellValue): CellValue {
    if (v != null && jsonCols.has(col)) return this.dialect.encode(JSON.stringify(v));
    return this.dialect.encode(v);
  }

  /** Fetch one row by id within an ACL row-scope (for per-row write evaluation), with the
   * SQL-computed admission flags of `flagScope` (if given). `raw` is the row exactly as
   * stored (undecoded), for the optimistic compare that re-asserts it in the UPDATE. */
  private async fetchOne(from: string, id: Id, scopeWhere: SqlExpr | null, flagScope?: Scope): Promise<{ row: Row; raw: Row } | undefined> {
    const pk = this.pkOf(from);
    const where = scopeWhere ? and(eq(pk, id), scopeWhere) : eq(pk, id);
    const flags = flagScope ? flagColumns(flagScope) : [];
    const { sql, params } = compileSelect({ from, where, limit: 1, flags }, this.dialect);
    const found = (await this.driver.exec(sql, params))[0] as Row | undefined;
    if (!found) return undefined;
    const raw = { ...found };
    return { row: this.decodeRow(from, found)!, raw };
  }

  private async finishRows(from: string, raw: Row[], scope: Scope, withSel: Selected, select?: readonly string[]): Promise<Row[]> {
    const relNames = withSel ? Object.keys(withSel).filter((k) => withSel[k]) : [];
    for (const relName of relNames) await this.loadRelation(from, raw, relName, scope);
    const sel = select && select.length > 0 ? new Set(select) : undefined;
    const flagged = flagColumns(scope).length > 0;
    return raw.map((r) => {
      // Per-row visible fields = ACL effective set (null = all), then narrowed to the
      // caller's `select`. Hidden columns are stripped even under unrestricted/SYSTEM.
      const eff = effectiveFields(scope, r, this.acl.identity);
      let base: Row;
      if (eff === null && !sel) base = r;
      else {
        const fields = eff === null ? [...sel!] : sel ? eff.filter((f) => sel.has(f)) : eff;
        base = projectRow(r, fields);
      }
      if (flagged) base = this.stripFlags(base);
      const projected = this.stripHidden(from, base);
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
   * via resolveRelationScope: the related read scope OR a parent directAccess grant.
   * `parentScope` is the read scope the parent rows were fetched under: a belongsTo/
   * oneHasOne attaches only where the caller can read the parent's FK on that row. */
  private async loadRelation(parentEntity: string, rows: Row[], relName: string, parentScope: Scope = ALLOW_ALL): Promise<void> {
    const rel = this.schema[parentEntity]?.relations?.[relName] as RelationDef | undefined;
    if (!rel) throw new Error(`unknown relation: ${parentEntity}.${relName}`);

    this.touched.add(rel.target);
    const scope = this.acl.system ? ALLOW_ALL : resolveRelationScope(this.acl, parentEntity, relName, rel.target);
    if (!scope.allowed) throw new AclDenied(rel.target, "read");

    // Strip hidden() columns from the relation load, like every other read path:
    // projectRow alone keeps them under a full/allow()/SYSTEM scope (fields === null).
    const project = (row: Row): Row =>
      this.stripHidden(rel.target, this.stripFlags(projectRow(row, effectiveFields(scope, row, this.acl.identity))));
    // One IN query per relation (no N+1). Match column before projecting (which
    // may drop the join column). `targetFk`: the join column is the TARGET's FK
    // (hasMany/oneHasOneInverse), so a target row joins only if the caller can read it
    // there. For belongsTo/manyToMany the column is the target's PK, which a read grant
    // may legitimately omit, so it isn't checked.
    const fetchBy = async (col: string, values: CellValue[], targetFk: boolean): Promise<Array<{ key: CellValue; row: Row }>> => {
      if (values.length === 0) return [];
      const where = scope.where ? and(inList(col, values), scope.where) : inList(col, values);
      // Project the target to its readable columns (+ the join `col`, matched before
      // projecting) so a wide relation target isn't shipped whole over RPC either.
      const cols = this.projectionColumns(rel.target, scope);
      const columns = cols ? [...new Set([...cols, col])] : undefined;
      const { sql, params } = compileSelect({ from: rel.target, where, columns, flags: flagColumns(scope) }, this.dialect);
      const rows = this.decodeRows(rel.target, await this.driver.exec(sql, params));
      const out: Array<{ key: CellValue; row: Row }> = [];
      for (const row of rows) {
        if (targetFk && !this.joinVisible(rel.target, scope, row, col)) continue;
        out.push({ key: row[col], row: project(row) });
      }
      return out;
    };

    if (rel.kind === "belongsTo" || rel.kind === "oneHasOne") {
      // parent[column] -> target.id (single-valued; oneHasOne is belongsTo + a 1:1 unique).
      // Only through an FK the caller can read on that parent row: attaching the target
      // would otherwise disclose the very value the field ACL withholds.
      const joins = (r: Row) => r[rel.column] != null && this.joinVisible(parentEntity, parentScope, r, rel.column);
      const keys = [...new Set(rows.filter(joins).map((r) => r[rel.column]))];
      const byId = new Map<unknown, Row>();
      for (const { key, row } of await fetchBy(this.pkOf(rel.target), keys, false)) byId.set(key, row);
      for (const r of rows) r[relName] = joins(r) ? (byId.get(r[rel.column]) ?? null) : null;
    } else if (rel.kind === "oneHasOneInverse") {
      // inverse 1:1: target[column] -> parent.<pk>, single object (or null)
      const pk = this.pkOf(parentEntity);
      const ids = [...new Set(rows.map((r) => r[pk]).filter((v) => v != null))];
      const byParent = new Map<unknown, Row>();
      for (const { key, row } of await fetchBy(rel.column, ids, true)) if (!byParent.has(key)) byParent.set(key, row);
      for (const r of rows) r[relName] = byParent.get(r[pk]) ?? null;
    } else if (rel.kind === "manyToMany") {
      // parent.<pk> -> junction(sourceColumn -> targetColumn) -> target.<pk>. The junction
      // is an ordinary entity with its own policies, read under ITS read scope: a link the
      // caller can't read directly is not observable here either, and both link columns
      // must be readable on each link row. The target rows are scope-filtered by fetchBy,
      // so an unreadable target simply drops out of the list.
      const pk = this.pkOf(parentEntity);
      const parentIds = [...new Set(rows.map((r) => r[pk]).filter((v) => v != null))];
      this.touched.add(rel.through);
      const jScope = this.acl.system ? ALLOW_ALL : resolveScope(this.acl, rel.through, "read");
      const hiddenLink = this.hiddenColsOf(rel.through).some((c) => c === rel.sourceColumn || c === rel.targetColumn);
      if (parentIds.length === 0 || !jScope.allowed || hiddenLink) {
        for (const r of rows) r[relName] = [];
        return;
      }
      // The junction is read for its two link columns (plus whatever its per-row grants
      // need); its other columns are irrelevant to the join and needn't cross RPC.
      const jCols = this.projectionColumns(rel.through, jScope);
      const linkSel = compileSelect(
        {
          from: rel.through,
          where: jScope.where ? and(inList(rel.sourceColumn, parentIds), jScope.where) : inList(rel.sourceColumn, parentIds),
          columns: jCols ? [...new Set([...jCols, rel.sourceColumn, rel.targetColumn])] : undefined,
          flags: flagColumns(jScope),
        },
        this.dialect,
      );
      const links = this.decodeRows(rel.through, await this.driver.exec(linkSel.sql, linkSel.params)).filter(
        (l) => this.joinVisible(rel.through, jScope, l, rel.sourceColumn) && this.joinVisible(rel.through, jScope, l, rel.targetColumn),
      );
      const targetIds = [...new Set(links.map((l) => l[rel.targetColumn]).filter((v) => v != null))];
      const byTarget = new Map<unknown, Row>();
      for (const { key, row } of await fetchBy(this.pkOf(rel.target), targetIds, false)) byTarget.set(key, row);
      const grouped = new Map<unknown, Row[]>();
      for (const l of links) {
        const t = byTarget.get(l[rel.targetColumn]);
        if (!t) continue; // target unreadable or missing -> excluded from the list
        const src = l[rel.sourceColumn];
        (grouped.get(src) ?? grouped.set(src, []).get(src)!).push(t);
      }
      for (const r of rows) r[relName] = grouped.get(r[pk]) ?? [];
    } else {
      // hasMany: target[column] -> parent.<pk> (NOT hardcoded `id`, since a parent keyed by
      // slug/username would otherwise join on an undefined `r.id` and get []).
      const pk = this.pkOf(parentEntity);
      const ids = [...new Set(rows.map((r) => r[pk]).filter((v) => v != null))];
      const grouped = new Map<unknown, Row[]>();
      for (const { key, row } of await fetchBy(rel.column, ids, true)) {
        const bucket = grouped.get(key) ?? grouped.set(key, []).get(key)!;
        bucket.push(row);
      }
      for (const r of rows) r[relName] = grouped.get(r[pk]) ?? [];
    }
  }

  /** Insert a single row, returning the persisted row. The create policy's `where` (and
   * `check`) must hold on the candidate row after `set`, else the insert is a 403: a
   * where-only create policy is a real constraint, not decoration. It is evaluated BEFORE
   * the INSERT, so it holds on D1 too, which cannot roll a statement back. */
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
    let evalRow: Row = vals;
    if (scope.where || scope.grants.length > 0) {
      const judged = await this.whereOnUnstored(table, this.withDefaults(table, vals), scope.where, flagColumns(scope));
      evalRow = judged.row;
      if (!judged.holds) throw new AclDenied(table, "create");
    }
    this.checkWriteFields(table, "create", scope, Object.keys(vals), evalRow, new Set([...Object.keys(set), ...generatedCols]));
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
    return (await this.projectWrite(table, persisted, cols)) as InferRow<FieldsOf<S[T]>>;
  }

  /** Project a mutation's RETURNING row so the echo never reveals more than a read
   * would: the caller's readable fields for this row, PLUS the columns they just
   * wrote (which they already know) and the primary key (so a write-only caller
   * still gets the generated id). Full read access -> the whole row; SYSTEM -> as-is.
   * This makes create/update echoes field-ACL-safe without ever collapsing to {}.
   * Hidden columns are never echoed, even when written or under SYSTEM.
   *
   * "Readable for this row" includes the read scope's `where`, judged on the persisted
   * row (the post-image): a caller who may update or create rows it cannot read gets only
   * the PK and what it wrote, not every readable column of a row a find would not return. */
  private async projectWrite(table: string, row: Row, writtenCols: string[]): Promise<Row> {
    if (this.acl.system) return this.stripHidden(table, row);
    const visible = new Set<string>([this.pkOf(table), ...writtenCols]);
    const readScope = this.scopeFor(table, "read");
    const judged = readScope.allowed ? await this.whereOnUnstored(table, row, readScope.where, flagColumns(readScope)) : null;
    if (judged?.holds) {
      const readable = effectiveFields(readScope, judged.row, this.acl.identity);
      if (readable === null) return this.stripHidden(table, row); // unrestricted read -> echo everything (minus hidden)
      for (const f of readable) visible.add(f);
    }
    for (const c of this.hiddenColsOf(table)) visible.delete(c);
    return projectRow(row, [...visible]);
  }

  /** Update a row by id. ACL row-scope is AND-ed into the WHERE, so a caller can
   * only update rows within scope; returns undefined if none matched.
   *
   * When the write is authorized per row (cell-level grants, a policy that admits only
   * some rows, or a `check` on the post-image), it is authorized against a pre-image read
   * first. On D1 that read and the UPDATE are separate autocommitting statements, so a
   * concurrent write could change the row in between and land this one on a row the
   * grant no longer covers. The UPDATE therefore re-asserts what the decision read (an
   * optimistic compare); a lost race re-evaluates against the fresh row, and keeps
   * losing only under sustained contention, which is a 409. */
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
    const setCols = new Set(Object.keys(set));

    // Fetch the existing row when we need it: for per-row field permission (evaluated
    // against the FINAL post-merge row, with each policy's `where` on the pre-image) OR
    // for a field-filtered update trigger's value-change detection (so it fires only on
    // an actual change, not a same-value write).
    const checked = hasCheck(scope);
    const needCellEval = checked || (scope.fields !== null && scope.grants.length > 0);
    const needBefore = !this.acl.suppressTriggers && triggersOf(this.schema, table).some((t) => Array.isArray(t.on.update));

    for (let attempt = 1; ; attempt++) {
      let evalRow: Row = p;
      let stored: Row = p;
      let before: Row | undefined;
      let raw: Row | undefined;
      if (needCellEval || needBefore) {
        const existing = await this.fetchOne(table, id, scope.where, needCellEval ? scope : undefined);
        if (!existing) return undefined; // out of update scope -> no-op
        stored = existing.row;
        raw = existing.raw;
        before = this.stripFlags(existing.row);
        if (needCellEval) {
          evalRow = await this.withFlags(table, { ...before, ...p }, checkFlagPredicates(scope));
          // A policy's `check` must hold on the post-image: a grant whose check fails
          // contributes nothing, and a write no grant still applies to is refused.
          if (checked && !anyGrantApplies(scope, evalRow, stored)) throw new AclDenied(table, "update");
        }
      }
      this.checkWriteFields(table, "update", scope, cols, evalRow, setCols, stored);
      this.runValidators(validators, p);
      this.assertValidUuids(table, p);

      const params: CellValue[] = [];
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
      if (needCellEval && raw) sql += this.preimageGuard(scope, raw, stored, params);
      sql += this.returningClause("*");
      const updated = this.decodeRow(table, (await this.driver.exec(sql, params))[0]);
      if (!updated && needCellEval) {
        // The row changed under the decision (or left the scope): decide again.
        if (attempt < UPDATE_ATTEMPTS) continue;
        throw new Conflict(`${table} ${String(id)} was modified concurrently; retry the update`);
      }
      if (updated) await this.fireTriggers(table, "update", updated, cols, before);
      return (updated ? await this.projectWrite(table, updated, cols) : undefined) as InferRow<FieldsOf<S[T]>> | undefined;
    }
  }

  /** The optimistic compare for a per-row-authorized update: AND the stored values of every
   * column the decision read (the inputs of cell `when`s, admissions and checks; every
   * column when a field-resolver function, which can read anything, was involved), plus
   * each relation-traversing admission that held, since it reads OTHER tables the compare
   * can't see. Values are compared exactly as stored (`raw`), null-safely. */
  private preimageGuard(scope: Scope, raw: Row, stored: Row, params: CellValue[]): string {
    const deps = new Set<string>();
    if (hasFieldsFn(scope)) {
      for (const c of Object.keys(raw)) deps.add(c);
    } else {
      for (const c of scopeInputColumns(scope)) deps.add(c);
      for (const g of scope.grants) {
        if (g.check) columnsInExpr(g.check.expr, deps);
        if (g.admit) columnsInExpr(g.admit.expr, deps);
      }
    }
    let sql = "";
    for (const c of deps) {
      if (c.startsWith(ACL_FLAG_PREFIX) || !(c in raw)) continue;
      const v = raw[c] as CellValue;
      if (v === null || v === undefined) {
        sql += ` AND ${this.dialect.id(c)} IS NULL`;
      } else {
        params.push(v);
        sql += ` AND ${this.dialect.id(c)} = ${this.dialect.placeholder(params.length)}`;
      }
    }
    for (const g of scope.grants) {
      if (g.admit?.flag !== undefined && predicateHolds(g.admit, stored)) sql += this.scopeClause(g.admit.expr, params);
    }
    return sql;
  }

  /** Delete a row by id within scope. Returns whether a row was deleted. */
  async delete<T extends keyof S & string>(table: T, id: Id): Promise<boolean> {
    this.touched.add(table);
    this.assertInPartition(table);
    const scope = this.scopeFor(table, "delete");
    if (!scope.allowed) throw new AclDenied(table, "delete");
    const params: CellValue[] = [this.dialect.encode(id)];
    let sql = `DELETE FROM ${this.dialect.id(table)} WHERE ${this.dialect.id(this.pkOf(table))} = ${this.dialect.placeholder(1)}`;
    sql += this.scopeClause(scope.where, params);
    sql += this.returningClause("*");
    const deleted = this.decodeRow(table, (await this.driver.exec(sql, params))[0]);
    if (deleted) await this.fireTriggers(table, "delete", deleted, []);
    return deleted != null;
  }

  /** Escape hatch: raw SQL, NOT ACL-checked. For system/internal use only. */
  async exec(sql: string, ...params: CellValue[]): Promise<Row[]> {
    return this.driver.exec(sql, params.map((p) => this.dialect.encode(p)));
  }

  // RETURNING is supported on SQLite/Postgres; a dialect without it (MySQL) would
  // need an insert-then-select-back path, not implemented in this spike.
  private returningClause(cols: string): string {
    return this.dialect.returning ? ` RETURNING ${cols}` : "";
  }

  private scopeClause(where: SqlExpr | null, params: CellValue[]): string {
    if (!where) return "";
    const compiled = compileExpr(where, this.dialect, params);
    return compiled.sql === "1" ? "" : ` AND (${compiled.sql})`;
  }
}
