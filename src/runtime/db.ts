// Db — the repository surface handed to handlers, wrapping the DO's in-process
// SqlStorage. This is the single ACL chokepoint (the prior runtime's "all reads go through
// the ReadEngine"): every find/insert/update/delete resolves a scope for the
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
  compileWhere,
  eq,
  inList,
  or,
  TRUE,
  type AggFn,
  type OrderBy,
  type SqlExpr,
} from "./read-engine";
import { BadRequest } from "./errors";
import type { Dialect, Driver } from "./driver";
import type { EntityFields, FieldDef, RelationDef, SchemaDef } from "../sdk/schema";
import type { Cell, FieldsOf, InferInsert, InferRow, InferUpdate, RelationsOf, RelationsResult, WhereInput } from "../sdk/infer";

type Row = Record<string, unknown>;
type Action = "read" | "create" | "update" | "delete";
type Id = string | number | bigint;
type Selected = Partial<Record<string, true>> | undefined;

const DEFAULT_PAGE_SIZE = 50;

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
  where?: WhereInput<FieldsOf<S[T]>>;
  orderBy?: OrderSpec<S, T> | OrderSpec<S, T>[];
  limit?: number;
  offset?: number;
  /** Eager-load relations. Each loaded relation is independently ACL-checked. */
  with?: Partial<Record<keyof RelationsOf<S[T]> & string, true>>;
}

/** Cursor (keyset) pagination input — `after` is an opaque cursor from a prior page. */
export interface PageSpec<S extends SchemaDef, T extends keyof S> {
  from: T;
  where?: WhereInput<FieldsOf<S[T]>>;
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
  where?: WhereInput<FieldsOf<S[T]>>;
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
  private readonly dialect: Dialect;

  constructor(
    private readonly driver: Driver,
    private readonly acl: AclContext,
    private readonly schema: SchemaDef,
  ) {
    this.dialect = driver.dialect;
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
    const scope = this.scopeFor(from, "read");
    if (!scope.allowed) throw new AclDenied(from, "read");

    const where = this.readWhere(spec.where, scope);
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
    const scope = this.scopeFor(from, "read");
    if (!scope.allowed) throw new AclDenied(from, "read");

    const order = this.orderWithPk(from, spec.orderBy);
    this.assertReadableCols(from, scope, order.map((o) => o.column)); // order + cursor must not leak hidden cols
    let where = this.readWhere(spec.where, scope);
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
  async count<T extends keyof S & string>(spec: { from: T; where?: WhereInput<FieldsOf<S[T]>> }): Promise<number> {
    const from = spec.from as string;
    this.touched.add(from);
    const scope = this.scopeFor(from, "read");
    if (!scope.allowed) throw new AclDenied(from, "read");
    const where = this.readWhere(spec.where, scope);
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
    where?: WhereInput<FieldsOf<S[T]>>;
    groupBy?: G;
    aggregations: A;
  }): Promise<AggregateResult<FieldsOf<S[T]>, G, A>[]> {
    const from = spec.from as string;
    this.touched.add(from);
    const scope = this.scopeFor(from, "read");
    if (!scope.allowed) throw new AclDenied(from, "read");

    const groupBy = (spec.groupBy ? (Array.isArray(spec.groupBy) ? spec.groupBy : [spec.groupBy]) : []) as string[];
    if (scope.fields) {
      const refs = new Set<string>(groupBy);
      for (const agg of Object.values(spec.aggregations)) if (agg.column) refs.add(agg.column as string);
      for (const c of refs) if (!scope.fields.includes(c)) throw new AclDenied(from, "read", c);
    }

    const where = this.readWhere(spec.where, scope);
    const { sql, params } = compileAggregate({ from, where, groupBy, aggregations: spec.aggregations }, this.dialect);
    return (await this.driver.exec(sql, params)) as AggregateResult<FieldsOf<S[T]>, G, A>[];
  }

  // --- read internals shared by find/page ---

  private readWhere(userWhere: unknown, scope: Scope): SqlExpr {
    const userExpr: SqlExpr = userWhere ? compileWhere(userWhere as Row) : TRUE;
    return scope.where ? and(userExpr, scope.where) : userExpr;
  }

  private async selectRaw(from: string, where: SqlExpr, orderBy?: OrderBy[], limit?: number, offset?: number): Promise<Row[]> {
    const { sql, params } = compileSelect({ from, where, orderBy, limit, offset }, this.dialect);
    return this.driver.exec(sql, params);
  }

  /** Fetch one row by id within an ACL row-scope (for per-row write evaluation). */
  private async fetchOne(from: string, id: Id, scopeWhere: SqlExpr | null): Promise<Row | undefined> {
    const where = scopeWhere ? and(eq("id", id), scopeWhere) : eq("id", id);
    const { sql, params } = compileSelect({ from, where, limit: 1 }, this.dialect);
    return (await this.driver.exec(sql, params))[0] as Row | undefined;
  }

  private async finishRows(from: string, raw: Row[], scope: Scope, withSel: Selected): Promise<Row[]> {
    const relNames = withSel ? Object.keys(withSel).filter((k) => withSel[k]) : [];
    for (const relName of relNames) await this.loadRelation(from, raw, relName);
    if (scope.fields === null) return raw; // base unrestricted -> no per-row narrowing possible
    return raw.map((r) => {
      const projected = projectRow(r, effectiveFields(scope, r, this.acl.identity));
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
      return (await this.driver.exec(sql, params)).map((row) => ({ key: row[col], row: project(row) }));
    };

    if (rel.kind === "belongsTo") {
      // parent[column] -> target.id
      const keys = [...new Set(rows.map((r) => r[rel.column]).filter((v) => v != null))];
      const byId = new Map<unknown, Row>();
      for (const { key, row } of await fetchBy("id", keys)) byId.set(key, row);
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
    const scope = this.scopeFor(table, "create");
    if (!scope.allowed) throw new AclDenied(table, "create");
    const vals = { ...(values as Row) };
    const { set, validators } = this.writeRules(table, "create");
    Object.assign(vals, set); // forced server values first, so a conditional `when` can see them
    this.checkWriteFields(table, "create", scope, Object.keys(vals), vals, new Set(Object.keys(set)));
    this.runValidators(validators, vals);

    const cols = Object.keys(vals);
    const colList = cols.map((c) => this.dialect.id(c)).join(", ");
    const phs = cols.map((_, i) => this.dialect.placeholder(i + 1)).join(", ");
    const params = cols.map((c) => this.dialect.encode(vals[c]));
    const sql = `INSERT INTO ${this.dialect.id(table)} (${colList}) VALUES (${phs})${this.returningClause("*")}`;
    const rows = await this.driver.exec(sql, params);
    return rows[0]! as InferRow<FieldsOf<S[T]>>;
  }

  /** Update a row by id. ACL row-scope is AND-ed into the WHERE, so a caller can
   * only update rows within scope; returns undefined if none matched. */
  async update<T extends keyof S & string>(
    table: T,
    id: Id,
    patch: InferUpdate<FieldsOf<S[T]>>,
  ): Promise<InferRow<FieldsOf<S[T]>> | undefined> {
    this.touched.add(table);
    const scope = this.scopeFor(table, "update");
    if (!scope.allowed) throw new AclDenied(table, "update");
    const p = { ...(patch as Row) };
    const { set, validators } = this.writeRules(table, "update");
    Object.assign(p, set); // forced server values first
    const cols = Object.keys(p);
    if (cols.length === 0) return undefined;

    // Per-row field permission is evaluated against the FINAL (post-merge) row, so
    // fetch the existing row within update scope when any cell-level rule applies.
    let evalRow: Row = p;
    if (scope.fields !== null && (scope.conditional.length > 0 || scope.fieldsFns.length > 0)) {
      const existing = await this.fetchOne(table, id, scope.where);
      if (!existing) return undefined; // out of update scope -> no-op
      evalRow = { ...existing, ...p };
    }
    this.checkWriteFields(table, "update", scope, cols, evalRow, new Set(Object.keys(set)));
    this.runValidators(validators, p);

    const params: unknown[] = [];
    const assignments = cols
      .map((c) => {
        params.push(this.dialect.encode(p[c]));
        return `${this.dialect.id(c)} = ${this.dialect.placeholder(params.length)}`;
      })
      .join(", ");
    params.push(this.dialect.encode(id));
    let sql = `UPDATE ${this.dialect.id(table)} SET ${assignments} WHERE ${this.dialect.id("id")} = ${this.dialect.placeholder(params.length)}`;
    sql += this.scopeClause(scope.where, params);
    sql += this.returningClause("*");
    return (await this.driver.exec(sql, params))[0] as InferRow<FieldsOf<S[T]>> | undefined;
  }

  /** Delete a row by id within scope. Returns whether a row was deleted. */
  async delete<T extends keyof S & string>(table: T, id: Id): Promise<boolean> {
    this.touched.add(table);
    const scope = this.scopeFor(table, "delete");
    if (!scope.allowed) throw new AclDenied(table, "delete");
    const params: unknown[] = [this.dialect.encode(id)];
    let sql = `DELETE FROM ${this.dialect.id(table)} WHERE ${this.dialect.id("id")} = ${this.dialect.placeholder(1)}`;
    sql += this.scopeClause(scope.where, params);
    sql += this.returningClause("id");
    return (await this.driver.exec(sql, params)).length > 0;
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
