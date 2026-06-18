// Read engine — compiles a structured query into parameterized SQL.
// This is the TS stand-in for the prior runtime's Rust ReadEngine. The "no hand-written SQL
// in handler code" property is preserved; the long-term plan (see DESIGN.md) is
// to compile this module to WASM so the hot path leaves JS entirely.
//
// A small boolean expression AST (SqlExpr) lets user predicates (with operators,
// AND/OR groups) and ACL row-level scopes be merged before compilation. Column
// names come from developer code (schema keys); values are always parameterized.

function bind(v: unknown): unknown {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

// Column identifiers are interpolated, so guard against anything but a plain name
// (handlers may forward user input as `where` keys).
function ident(col: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) throw new Error(`invalid column name: ${col}`);
  return col;
}

export type CmpOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "LIKE";

export type SqlExpr =
  | { t: "true" }
  | { t: "false" }
  | { t: "cmp"; op: CmpOp; col: string; value: unknown }
  | { t: "in"; col: string; values: unknown[]; negate: boolean }
  | { t: "null"; col: string; negate: boolean }
  | { t: "and"; parts: SqlExpr[] }
  | { t: "or"; parts: SqlExpr[] };

export const TRUE: SqlExpr = { t: "true" };
export const FALSE: SqlExpr = { t: "false" };
export const cmp = (op: CmpOp, col: string, value: unknown): SqlExpr => ({ t: "cmp", op, col, value });
export const isNull = (col: string, negate = false): SqlExpr => ({ t: "null", col, negate });
export const inList = (col: string, values: unknown[], negate = false): SqlExpr => ({ t: "in", col, values, negate });
export const and = (...parts: SqlExpr[]): SqlExpr => ({ t: "and", parts });
export const or = (...parts: SqlExpr[]): SqlExpr => ({ t: "or", parts });

/** Equality (null -> IS NULL). Used by ACL scope building and relation loads. */
export const eq = (col: string, value: unknown): SqlExpr => (value === null ? isNull(col) : cmp("=", col, value));

/** Compile a structured user predicate into a SqlExpr.
 * Shapes: { col: value } (eq) | { col: { gt, lt, in, like, isNull, … } } | { AND: [...] } | { OR: [...] } */
export function compileWhere(input: Record<string, unknown>): SqlExpr {
  const parts: SqlExpr[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (k === "AND") {
      parts.push(and(...(v as Record<string, unknown>[]).map(compileWhere)));
    } else if (k === "OR") {
      parts.push(or(...(v as Record<string, unknown>[]).map(compileWhere)));
    } else {
      parts.push(columnPredicate(k, v));
    }
  }
  return parts.length ? and(...parts) : TRUE;
}

function columnPredicate(col: string, v: unknown): SqlExpr {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const ops: SqlExpr[] = [];
    for (const [op, val] of Object.entries(v as Record<string, unknown>)) {
      switch (op) {
        case "eq": ops.push(eq(col, val)); break;
        case "ne": ops.push(val === null ? isNull(col, true) : cmp("!=", col, val)); break;
        case "gt": ops.push(cmp(">", col, val)); break;
        case "gte": ops.push(cmp(">=", col, val)); break;
        case "lt": ops.push(cmp("<", col, val)); break;
        case "lte": ops.push(cmp("<=", col, val)); break;
        case "like": ops.push(cmp("LIKE", col, val)); break;
        case "in": ops.push(inList(col, val as unknown[])); break;
        case "notIn": ops.push(inList(col, val as unknown[], true)); break;
        case "isNull": ops.push(isNull(col, !val)); break; // isNull:true => IS NULL
        default: throw new Error(`unknown operator: ${op}`);
      }
    }
    return ops.length ? and(...ops) : TRUE;
  }
  return eq(col, v);
}

export interface CompiledSql {
  readonly sql: string;
  readonly params: unknown[];
}

export function compileExpr(expr: SqlExpr, params: unknown[] = []): CompiledSql {
  switch (expr.t) {
    case "true":
      return { sql: "1", params };
    case "false":
      return { sql: "0", params };
    case "cmp":
      if (expr.value === null) return { sql: `${ident(expr.col)} IS NULL`, params };
      params.push(bind(expr.value));
      return { sql: `${ident(expr.col)} ${expr.op} ?`, params };
    case "null":
      return { sql: `${ident(expr.col)} IS ${expr.negate ? "NOT " : ""}NULL`, params };
    case "in": {
      if (expr.values.length === 0) return { sql: expr.negate ? "1" : "0", params }; // empty: notIn=>all, in=>none
      const ph = expr.values.map((v) => (params.push(bind(v)), "?")).join(", ");
      return { sql: `${ident(expr.col)} ${expr.negate ? "NOT IN" : "IN"} (${ph})`, params };
    }
    case "and":
    case "or": {
      if (expr.parts.length === 0) return { sql: expr.t === "and" ? "1" : "0", params };
      const sep = expr.t === "and" ? " AND " : " OR ";
      const sql = expr.parts.map((p) => compileExpr(p, params).sql).join(sep);
      return { sql: expr.parts.length > 1 ? `(${sql})` : sql, params };
    }
  }
}

export interface OrderBy {
  column: string;
  dir?: "asc" | "desc";
}

export interface QuerySpec {
  readonly from: string;
  readonly where?: SqlExpr;
  readonly orderBy?: OrderBy[];
  readonly limit?: number;
  readonly offset?: number;
}

export function compileSelect(spec: QuerySpec): CompiledSql {
  const params: unknown[] = [];
  let sql = `SELECT * FROM ${ident(spec.from)}`;

  if (spec.where && spec.where.t !== "true") {
    const { sql: where } = compileExpr(spec.where, params);
    sql += ` WHERE ${where}`;
  }

  if (spec.orderBy && spec.orderBy.length > 0) {
    const cols = spec.orderBy.map((o) => `${ident(o.column)} ${o.dir === "desc" ? "DESC" : "ASC"}`);
    sql += ` ORDER BY ${cols.join(", ")}`;
  }

  if (spec.limit != null) {
    sql += " LIMIT ?";
    params.push(spec.limit);
  } else if (spec.offset != null) {
    sql += " LIMIT -1"; // SQLite requires a LIMIT before OFFSET
  }
  if (spec.offset != null) {
    sql += " OFFSET ?";
    params.push(spec.offset);
  }

  return { sql, params };
}
