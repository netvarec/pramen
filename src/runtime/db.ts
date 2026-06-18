// Db — the repository surface handed to handlers, wrapping the DO's in-process
// SqlStorage. This is the single ACL chokepoint (the prior runtime's "all reads go through
// the ReadEngine"): every find/insert/update/delete resolves a scope for the
// caller's identity and is denied, row-filtered, or field-projected accordingly.
//
// Every Db also records the tables it touched during one handler run (`touched`),
// which the live-query layer uses to decide which subscriptions to re-check.
// Create a fresh Db per handler run so identity and `touched` are scoped.

import {
  AclDenied,
  projectRow,
  resolveScope,
  type AclContext,
} from "./acl";
import {
  and,
  compileExpr,
  compileSelect,
  mapToExpr,
  TRUE,
  type SqlExpr,
} from "./read-engine";

type Row = Record<string, unknown>;

function bind(v: unknown): unknown {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

export interface FindSpec {
  from: string;
  where?: Record<string, unknown>;
  orderBy?: { column: string; dir?: "asc" | "desc" };
  limit?: number;
}

export class Db {
  /** Tables read or written during this Db's lifetime. */
  readonly touched = new Set<string>();

  constructor(
    private readonly sql: SqlStorage,
    private readonly acl: AclContext,
  ) {}

  /** Structured read; ACL row-scope is AND-ed in, permitted fields projected. */
  find(spec: FindSpec): Row[] {
    this.touched.add(spec.from);
    const scope = resolveScope(this.acl.acl, this.acl.identity, spec.from, "read");
    if (!scope.allowed) throw new AclDenied(spec.from, "read");

    const userExpr: SqlExpr = spec.where ? mapToExpr(spec.where) : TRUE;
    const where = scope.where ? and(userExpr, scope.where) : userExpr;
    const { sql, params } = compileSelect({ from: spec.from, where, orderBy: spec.orderBy, limit: spec.limit });
    const rows = this.sql.exec(sql, ...params).toArray() as Row[];
    return scope.fields ? rows.map((r) => projectRow(r, scope.fields)) : rows;
  }

  /** Insert a single row, returning the persisted row. */
  insert(table: string, values: Row): Row {
    this.touched.add(table);
    const scope = resolveScope(this.acl.acl, this.acl.identity, table, "create");
    if (!scope.allowed) throw new AclDenied(table, "create");
    if (scope.fields) {
      for (const c of Object.keys(values)) if (!scope.fields.includes(c)) throw new AclDenied(table, "create", c);
    }

    const cols = Object.keys(values);
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`;
    const rows = this.sql.exec(sql, ...cols.map((c) => bind(values[c]))).toArray() as Row[];
    return rows[0]!;
  }

  /** Update a row by id. ACL row-scope is AND-ed into the WHERE, so a caller can
   * only update rows within scope; returns undefined if none matched. */
  update(table: string, id: unknown, patch: Row): Row | undefined {
    this.touched.add(table);
    const scope = resolveScope(this.acl.acl, this.acl.identity, table, "update");
    if (!scope.allowed) throw new AclDenied(table, "update");
    const cols = Object.keys(patch);
    if (scope.fields) {
      for (const c of cols) if (!scope.fields.includes(c)) throw new AclDenied(table, "update", c);
    }
    if (cols.length === 0) return undefined;

    const assignments = cols.map((c) => `${c} = ?`).join(", ");
    const params: unknown[] = [...cols.map((c) => bind(patch[c])), bind(id)];
    let sql = `UPDATE ${table} SET ${assignments} WHERE id = ?`;
    sql += this.scopeClause(scope.where, params);
    sql += " RETURNING *";
    return this.sql.exec(sql, ...params).toArray()[0] as Row | undefined;
  }

  /** Delete a row by id within scope. Returns whether a row was deleted. */
  delete(table: string, id: unknown): boolean {
    this.touched.add(table);
    const scope = resolveScope(this.acl.acl, this.acl.identity, table, "delete");
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
