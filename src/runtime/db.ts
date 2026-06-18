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
  compileExpr,
  compileSelect,
  compileWhere,
  eq,
  TRUE,
  type OrderBy,
  type SqlExpr,
} from "./read-engine";
import type { RelationDef, SchemaDef } from "../sdk/schema";
import type { FieldsOf, InferInsert, InferRow, InferUpdate, RelationsOf, RelationsResult, WhereInput } from "../sdk/infer";

type Row = Record<string, unknown>;
type Action = "read" | "create" | "update" | "delete";
type Id = string | number | bigint;

function bind(v: unknown): unknown {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
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
    for (const validate of validators) validate({ identity: this.acl.identity, values });
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

    const userExpr: SqlExpr = spec.where ? compileWhere(spec.where as Row) : TRUE;
    const where = scope.where ? and(userExpr, scope.where) : userExpr;
    const orderBy: OrderBy[] | undefined = spec.orderBy
      ? Array.isArray(spec.orderBy)
        ? spec.orderBy
        : [spec.orderBy]
      : undefined;
    const { sql, params } = compileSelect({ from, where, orderBy, limit: spec.limit, offset: spec.offset });
    // Keep raw rows (with all columns) for relation FKs; project for the result.
    const raw = this.sql.exec(sql, ...params).toArray() as Row[];

    const relNames = spec.with ? Object.keys(spec.with).filter((k) => (spec.with as Row)[k]) : [];
    for (const relName of relNames) this.loadRelation(from, raw, relName);

    if (!scope.fields) return raw as (InferRow<FieldsOf<S[T]>> & RelationsResult<S, T>)[];
    return raw.map((r) => {
      const projected = projectRow(r, scope.fields);
      for (const relName of relNames) projected[relName] = r[relName]; // relations survive projection
      return projected;
    }) as (InferRow<FieldsOf<S[T]>> & RelationsResult<S, T>)[];
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

    const project = (row: Row | undefined) => (row && scope.fields ? projectRow(row, scope.fields) : row);
    const query = (col: string, value: unknown): Row[] => {
      const where = scope.where ? and(eq(col, value), scope.where) : eq(col, value);
      const { sql, params } = compileSelect({ from: rel.target, where });
      return this.sql.exec(sql, ...params).toArray() as Row[];
    };

    if (rel.kind === "belongsTo") {
      // parent[column] -> target.id
      const byKey = new Map<unknown, Row | null>();
      for (const r of rows) {
        const key = r[rel.column];
        if (key == null) {
          r[relName] = null;
          continue;
        }
        if (!byKey.has(key)) byKey.set(key, (project(query("id", key)[0]) as Row) ?? null);
        r[relName] = byKey.get(key) ?? null;
      }
    } else {
      // hasMany: target[column] -> parent.id
      for (const r of rows) {
        r[relName] = query(rel.column, r.id).map((x) => project(x) as Row);
      }
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
