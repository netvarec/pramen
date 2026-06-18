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
  projectRow,
  resolveRelationScope,
  resolveScope,
  resolveWriteRules,
  type AclContext,
  type Scope,
} from "./acl";
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
import type { FieldDef, RelationDef, SchemaDef } from "../sdk/schema";
import type { FieldsOf, InferInsert, InferRow, InferUpdate, RelationsOf, RelationsResult, WhereInput } from "../sdk/infer";

type Row = Record<string, unknown>;
type Action = "read" | "create" | "update" | "delete";
type Id = string | number | bigint;
type Selected = Partial<Record<string, true>> | undefined;

const DEFAULT_PAGE_SIZE = 50;

function bind(v: unknown): unknown {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
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

export interface AggregateSpec<S extends SchemaDef, T extends keyof S> {
  from: T;
  where?: WhereInput<FieldsOf<S[T]>>;
  groupBy?: (keyof FieldsOf<S[T]> & string) | (keyof FieldsOf<S[T]> & string)[];
  aggregations: Record<string, { fn: AggFn; column?: keyof FieldsOf<S[T]> & string }>;
}

/** One aggregate result row: group columns + the aggregated values. */
export type AggregateRow = Record<string, number | string | null>;

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

  constructor(
    private readonly sql: SqlStorage,
    private readonly acl: AclContext,
    private readonly schema: SchemaDef,
  ) {}

  /** Resolve the ACL scope for an operation, or grant everything in SYSTEM mode. */
  private scopeFor(entity: string, action: Action): Scope {
    if (this.acl.system) return { allowed: true, where: null, fields: null };
    return resolveScope(this.acl, entity, action);
  }

  /** Apply policy `set` (forced, server-controlled column values) and run `validate`
   * on the final values. Mutates `values`. Skipped in SYSTEM mode. */
  private applyWriteRules(entity: string, action: "create" | "update", values: Row): void {
    if (this.acl.system) return;
    const { set, validators } = resolveWriteRules(this.acl, entity, action);
    Object.assign(values, set); // forced values override client input
    for (const validate of validators) {
      try {
        validate({ identity: this.acl.identity, values });
      } catch (e) {
        // validators are authored for end users -> surface as a 400.
        throw new BadRequest(e instanceof Error ? e.message : "validation failed");
      }
    }
  }

  /** Structured read; ACL row-scope is AND-ed in, permitted fields projected.
   * Selected relations are eager-loaded, each independently ACL-checked. */
  find<T extends keyof S & string>(
    spec: FindSpec<S, T>,
  ): (InferRow<FieldsOf<S[T]>> & RelationsResult<S, T>)[] {
    const from = spec.from as string;
    this.touched.add(from);
    const scope = this.scopeFor(from, "read");
    if (!scope.allowed) throw new AclDenied(from, "read");

    const where = this.readWhere(spec.where, scope);
    const orderBy = normalizeOrder(spec.orderBy);
    const raw = this.selectRaw(from, where, orderBy, spec.limit, spec.offset);
    return this.finishRows(from, raw, scope.fields, spec.with as Selected) as (InferRow<FieldsOf<S[T]>> &
      RelationsResult<S, T>)[];
  }

  /** Cursor (keyset) pagination. Stable under inserts/deletes; the PK is appended
   * to `orderBy` as a tiebreaker so the keyset is unique. Returns the page plus an
   * opaque `cursor` (pass back as `after`) and whether more rows remain. */
  page<T extends keyof S & string>(
    spec: PageSpec<S, T>,
  ): Page<InferRow<FieldsOf<S[T]>> & RelationsResult<S, T>> {
    const from = spec.from as string;
    this.touched.add(from);
    const scope = this.scopeFor(from, "read");
    if (!scope.allowed) throw new AclDenied(from, "read");

    const order = this.orderWithPk(from, spec.orderBy);
    let where = this.readWhere(spec.where, scope);
    if (spec.after != null) where = and(where, keysetAfter(order, decodeCursor(spec.after)));

    const limit = spec.limit ?? DEFAULT_PAGE_SIZE;
    const raw = this.selectRaw(from, where, order, limit + 1); // +1 to detect a next page
    const hasMore = raw.length > limit;
    if (hasMore) raw.length = limit;

    const last = raw[raw.length - 1];
    const cursor = last ? encodeCursor(order, last) : null; // from raw row (has all order cols)
    const items = this.finishRows(from, raw, scope.fields, spec.with as Selected) as (InferRow<FieldsOf<S[T]>> &
      RelationsResult<S, T>)[];
    return { items, cursor, hasMore };
  }

  /** Count rows visible to the caller (ACL read scope applied). */
  count<T extends keyof S & string>(spec: { from: T; where?: WhereInput<FieldsOf<S[T]>> }): number {
    const from = spec.from as string;
    this.touched.add(from);
    const scope = this.scopeFor(from, "read");
    if (!scope.allowed) throw new AclDenied(from, "read");
    const where = this.readWhere(spec.where, scope);
    const { sql, params } = compileCount(from, where);
    const rows = this.sql.exec(sql, ...params).toArray() as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  }

  /** Grouped aggregation (count/sum/avg/min/max). ACL read scope is applied, and
   * every referenced column must be readable under field permissions. */
  aggregate<T extends keyof S & string>(spec: AggregateSpec<S, T>): AggregateRow[] {
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
    const { sql, params } = compileAggregate({ from, where, groupBy, aggregations: spec.aggregations });
    return this.sql.exec(sql, ...params).toArray() as AggregateRow[];
  }

  // --- read internals shared by find/page ---

  private readWhere(userWhere: unknown, scope: Scope): SqlExpr {
    const userExpr: SqlExpr = userWhere ? compileWhere(userWhere as Row) : TRUE;
    return scope.where ? and(userExpr, scope.where) : userExpr;
  }

  private selectRaw(from: string, where: SqlExpr, orderBy?: OrderBy[], limit?: number, offset?: number): Row[] {
    const { sql, params } = compileSelect({ from, where, orderBy, limit, offset });
    return this.sql.exec(sql, ...params).toArray() as Row[];
  }

  private finishRows(from: string, raw: Row[], fields: string[] | null, withSel: Selected): Row[] {
    const relNames = withSel ? Object.keys(withSel).filter((k) => withSel[k]) : [];
    for (const relName of relNames) this.loadRelation(from, raw, relName);
    if (!fields) return raw;
    return raw.map((r) => {
      const projected = projectRow(r, fields);
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
  private loadRelation(parentEntity: string, rows: Row[], relName: string): void {
    const rel = this.schema[parentEntity]?.relations?.[relName] as RelationDef | undefined;
    if (!rel) throw new Error(`unknown relation: ${parentEntity}.${relName}`);

    this.touched.add(rel.target);
    const scope = this.acl.system
      ? ({ allowed: true, where: null, fields: null } as Scope)
      : resolveRelationScope(this.acl, parentEntity, relName, rel.target);
    if (!scope.allowed) throw new AclDenied(rel.target, "read");

    const project = (row: Row): Row => (scope.fields ? projectRow(row, scope.fields) : row);
    // One IN query per relation (no N+1). Match column before projecting (which
    // may drop the join column).
    const fetchBy = (col: string, values: unknown[]): Array<{ key: unknown; row: Row }> => {
      if (values.length === 0) return [];
      const where = scope.where ? and(inList(col, values), scope.where) : inList(col, values);
      const { sql, params } = compileSelect({ from: rel.target, where });
      return (this.sql.exec(sql, ...params).toArray() as Row[]).map((row) => ({ key: row[col], row: project(row) }));
    };

    if (rel.kind === "belongsTo") {
      // parent[column] -> target.id
      const keys = [...new Set(rows.map((r) => r[rel.column]).filter((v) => v != null))];
      const byId = new Map<unknown, Row>();
      for (const { key, row } of fetchBy("id", keys)) byId.set(key, row);
      for (const r of rows) r[relName] = r[rel.column] != null ? (byId.get(r[rel.column]) ?? null) : null;
    } else {
      // hasMany: target[column] -> parent.id
      const ids = [...new Set(rows.map((r) => r.id).filter((v) => v != null))];
      const grouped = new Map<unknown, Row[]>();
      for (const { key, row } of fetchBy(rel.column, ids)) {
        const bucket = grouped.get(key) ?? grouped.set(key, []).get(key)!;
        bucket.push(row);
      }
      for (const r of rows) r[relName] = grouped.get(r.id) ?? [];
    }
  }

  /** Insert a single row, returning the persisted row. */
  insert<T extends keyof S & string>(table: T, values: InferInsert<FieldsOf<S[T]>>): InferRow<FieldsOf<S[T]>> {
    this.touched.add(table);
    const scope = this.scopeFor(table, "create");
    if (!scope.allowed) throw new AclDenied(table, "create");
    const vals = { ...(values as Row) };
    if (scope.fields) {
      for (const c of Object.keys(vals)) if (!scope.fields.includes(c)) throw new AclDenied(table, "create", c);
    }
    this.applyWriteRules(table, "create", vals); // forced `set` values + `validate`

    const cols = Object.keys(vals);
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`;
    const rows = this.sql.exec(sql, ...cols.map((c) => bind(vals[c]))).toArray() as Row[];
    return rows[0]! as InferRow<FieldsOf<S[T]>>;
  }

  /** Update a row by id. ACL row-scope is AND-ed into the WHERE, so a caller can
   * only update rows within scope; returns undefined if none matched. */
  update<T extends keyof S & string>(
    table: T,
    id: Id,
    patch: InferUpdate<FieldsOf<S[T]>>,
  ): InferRow<FieldsOf<S[T]>> | undefined {
    this.touched.add(table);
    const scope = this.scopeFor(table, "update");
    if (!scope.allowed) throw new AclDenied(table, "update");
    const p = { ...(patch as Row) };
    if (scope.fields) {
      for (const c of Object.keys(p)) if (!scope.fields.includes(c)) throw new AclDenied(table, "update", c);
    }
    this.applyWriteRules(table, "update", p); // forced `set` values + `validate`
    const cols = Object.keys(p);
    if (cols.length === 0) return undefined;

    const assignments = cols.map((c) => `${c} = ?`).join(", ");
    const params: unknown[] = [...cols.map((c) => bind(p[c])), bind(id)];
    let sql = `UPDATE ${table} SET ${assignments} WHERE id = ?`;
    sql += this.scopeClause(scope.where, params);
    sql += " RETURNING *";
    return this.sql.exec(sql, ...params).toArray()[0] as InferRow<FieldsOf<S[T]>> | undefined;
  }

  /** Delete a row by id within scope. Returns whether a row was deleted. */
  delete<T extends keyof S & string>(table: T, id: Id): boolean {
    this.touched.add(table);
    const scope = this.scopeFor(table, "delete");
    if (!scope.allowed) throw new AclDenied(table, "delete");
    const params: unknown[] = [bind(id)];
    let sql = `DELETE FROM ${table} WHERE id = ?`;
    sql += this.scopeClause(scope.where, params);
    sql += " RETURNING id";
    return this.sql.exec(sql, ...params).toArray().length > 0;
  }

  /** Escape hatch — raw SQL, NOT ACL-checked. For system/internal use only. */
  exec(sql: string, ...params: unknown[]): Row[] {
    return this.sql.exec(sql, ...params.map(bind)).toArray() as Row[];
  }

  private scopeClause(where: SqlExpr | null, params: unknown[]): string {
    if (!where) return "";
    const compiled = compileExpr(where, params);
    return compiled.sql === "1" ? "" : ` AND (${compiled.sql})`;
  }
}
