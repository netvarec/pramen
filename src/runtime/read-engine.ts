// Read engine — compiles a structured query into parameterized SQL.
// This is the TS stand-in for the prior runtime's Rust ReadEngine. The "no hand-written SQL
// in handler code" property is preserved; the long-term plan (see DESIGN.md) is
// to compile this module to WASM so the hot path leaves JS entirely.
//
// A small boolean expression AST (SqlExpr) lets user-supplied predicates and
// ACL row-level scopes be AND/OR-merged before compilation.

function bind(v: unknown): unknown {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

export type SqlExpr =
  | { t: "true" }
  | { t: "false" }
  | { t: "eq"; col: string; value: unknown }
  | { t: "and"; parts: SqlExpr[] }
  | { t: "or"; parts: SqlExpr[] };

export const TRUE: SqlExpr = { t: "true" };
export const FALSE: SqlExpr = { t: "false" };
export const eq = (col: string, value: unknown): SqlExpr => ({ t: "eq", col, value });
export const and = (...parts: SqlExpr[]): SqlExpr => ({ t: "and", parts });
export const or = (...parts: SqlExpr[]): SqlExpr => ({ t: "or", parts });

/** column -> value equality map, AND-ed. Empty = TRUE. */
export function mapToExpr(map: Record<string, unknown>): SqlExpr {
  const keys = Object.keys(map);
  return keys.length === 0 ? TRUE : and(...keys.map((k) => eq(k, map[k])));
}

export interface CompiledSql {
  readonly sql: string;
  readonly params: unknown[];
}

/** Compile a boolean expression to a SQL fragment. "1"/"0" for trivial true/false. */
export function compileExpr(expr: SqlExpr, params: unknown[] = []): CompiledSql {
  switch (expr.t) {
    case "true":
      return { sql: "1", params };
    case "false":
      return { sql: "0", params };
    case "eq":
      if (expr.value === null || expr.value === undefined) {
        return { sql: `${expr.col} IS NULL`, params };
      }
      params.push(bind(expr.value));
      return { sql: `${expr.col} = ?`, params };
    case "and":
    case "or": {
      if (expr.parts.length === 0) return { sql: expr.t === "and" ? "1" : "0", params };
      const sep = expr.t === "and" ? " AND " : " OR ";
      const sql = expr.parts.map((p) => compileExpr(p, params).sql).join(sep);
      return { sql: expr.parts.length > 1 ? `(${sql})` : sql, params };
    }
  }
}

export interface QuerySpec {
  readonly from: string;
  readonly where?: SqlExpr;
  readonly orderBy?: { column: string; dir?: "asc" | "desc" };
  readonly limit?: number;
}

export function compileSelect(spec: QuerySpec): CompiledSql {
  const params: unknown[] = [];
  let sql = `SELECT * FROM ${spec.from}`;

  if (spec.where && spec.where.t !== "true") {
    const { sql: where } = compileExpr(spec.where, params);
    sql += ` WHERE ${where}`;
  }

  if (spec.orderBy) {
    sql += ` ORDER BY ${spec.orderBy.column} ${spec.orderBy.dir === "desc" ? "DESC" : "ASC"}`;
  }

  if (spec.limit != null) {
    sql += " LIMIT ?";
    params.push(spec.limit);
  }

  return { sql, params };
}
