// Read engine — compiles a structured query into parameterized SQL. The "no
// hand-written SQL in handler code" property is preserved; the long-term plan is
// to compile this module to WASM so the hot path leaves JS entirely.
//
// A small boolean expression AST (SqlExpr) lets user predicates (with operators,
// AND/OR groups) and ACL row-level scopes be merged before compilation. Column
// names come from developer code (schema keys); values are always parameterized.

import type { Dialect } from "./driver";

// In-process value coercion for evalExpr (SQLite-style booleans). SQL-side encoding
// goes through the active Dialect; this mirrors it for the cell-ACL `when` evaluator.
function bind(v: unknown): unknown {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

export type CmpOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "LIKE";

/** Substring match mode for the structured string operators (auto-escaping, so the
 * needle's `%`/`_` are literal). Case-insensitive, matching SQLite's default LIKE. */
export type StrMode = "contains" | "prefix" | "suffix";

export type SqlExpr =
  | { t: "true" }
  | { t: "false" }
  | { t: "cmp"; op: CmpOp; col: string; value: unknown }
  | { t: "in"; col: string; values: unknown[]; negate: boolean }
  | { t: "null"; col: string; negate: boolean }
  // Structured substring match — the needle is escaped and wrapped, so `%`/`_` in the
  // input match literally (unlike raw `like`, where the caller controls wildcards).
  | { t: "strmatch"; col: string; needle: string; mode: StrMode }
  | { t: "and"; parts: SqlExpr[] }
  | { t: "or"; parts: SqlExpr[] }
  | { t: "not"; expr: SqlExpr }
  // Relation traversal: `outerCol IN (SELECT selectCol FROM from WHERE where)`.
  // Built by the ACL layer (which knows schema + the target's read scope); the
  // inner predicate compiles inline so placeholders share the outer param sequence.
  | { t: "sub"; outerCol: string; from: string; selectCol: string; where: SqlExpr; negate: boolean };

export const TRUE: SqlExpr = { t: "true" };
export const FALSE: SqlExpr = { t: "false" };
export const cmp = (op: CmpOp, col: string, value: unknown): SqlExpr => ({ t: "cmp", op, col, value });
export const isNull = (col: string, negate = false): SqlExpr => ({ t: "null", col, negate });
export const inList = (col: string, values: unknown[], negate = false): SqlExpr => ({ t: "in", col, values, negate });
export const strMatch = (col: string, needle: string, mode: StrMode): SqlExpr => ({ t: "strmatch", col, needle, mode });
export const and = (...parts: SqlExpr[]): SqlExpr => ({ t: "and", parts });
export const or = (...parts: SqlExpr[]): SqlExpr => ({ t: "or", parts });
export const not = (expr: SqlExpr): SqlExpr => ({ t: "not", expr });

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
    } else if (k === "NOT") {
      parts.push(not(compileWhere(v as Record<string, unknown>)));
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
        case "contains": ops.push(strMatch(col, String(val), "contains")); break;
        case "startsWith": ops.push(strMatch(col, String(val), "prefix")); break;
        case "endsWith": ops.push(strMatch(col, String(val), "suffix")); break;
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

export function compileExpr(expr: SqlExpr, dialect: Dialect, params: unknown[] = []): CompiledSql {
  switch (expr.t) {
    case "true":
      return { sql: "1", params };
    case "false":
      return { sql: "0", params };
    case "cmp":
      // A comparison against NULL is never TRUE in SQL (=, !=, <, > all yield NULL).
      // Only the dedicated `null` node produces `IS NULL`; a `cmp` with a null operand
      // matches nothing. (`eq()` already routes an equality-to-null to the `null` node,
      // and the keyset comparator handles null order-keys explicitly — so no legitimate
      // caller reaches here with a null value.)
      if (expr.value === null) return { sql: "0", params };
      params.push(dialect.encode(expr.value));
      return { sql: `${dialect.id(expr.col)} ${expr.op} ${dialect.placeholder(params.length)}`, params };
    case "null":
      return { sql: `${dialect.id(expr.col)} IS ${expr.negate ? "NOT " : ""}NULL`, params };
    case "strmatch": {
      // Escape the LIKE metacharacters in the needle (\, %, _) so they match literally,
      // then wrap with wildcards per mode. ESCAPE '\' declares the escape char (SQLite +
      // Postgres both support it). LIKE is ASCII-case-insensitive by default.
      const esc = expr.needle.replace(/[\\%_]/g, "\\$&");
      const pattern = expr.mode === "contains" ? `%${esc}%` : expr.mode === "prefix" ? `${esc}%` : `%${esc}`;
      params.push(dialect.encode(pattern));
      return { sql: `${dialect.id(expr.col)} LIKE ${dialect.placeholder(params.length)} ESCAPE '\\'`, params };
    }
    case "in": {
      if (expr.values.length === 0) return { sql: expr.negate ? "1" : "0", params }; // empty: notIn=>all, in=>none
      const ph = expr.values.map((v) => (params.push(dialect.encode(v)), dialect.placeholder(params.length))).join(", ");
      return { sql: `${dialect.id(expr.col)} ${expr.negate ? "NOT IN" : "IN"} (${ph})`, params };
    }
    case "and":
    case "or": {
      if (expr.parts.length === 0) return { sql: expr.t === "and" ? "1" : "0", params };
      const sep = expr.t === "and" ? " AND " : " OR ";
      const sql = expr.parts.map((p) => compileExpr(p, dialect, params).sql).join(sep);
      return { sql: expr.parts.length > 1 ? `(${sql})` : sql, params };
    }
    case "not":
      return { sql: `NOT (${compileExpr(expr.expr, dialect, params).sql})`, params };
    case "sub": {
      // Inner predicate shares `params`, so placeholder numbering stays correct
      // across dialects (? and $n alike).
      const inner = compileExpr(expr.where, dialect, params).sql;
      const op = expr.negate ? "NOT IN" : "IN";
      return {
        sql: `${dialect.id(expr.outerCol)} ${op} (SELECT ${dialect.id(expr.selectCol)} FROM ${dialect.id(expr.from)} WHERE ${inner})`,
        params,
      };
    }
  }
}

// SQL LIKE -> RegExp. `%` is any run, `_` is any single char; SQLite LIKE is
// case-insensitive for ASCII, so the regex is too. Other chars are escaped.
function likeToRegex(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "%") re += ".*";
    else if (ch === "_") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is");
}

/** Evaluate a compiled predicate against an in-memory row. Mirrors compileExpr's
 * semantics (bound-boolean coercion, NULL compares false, empty-IN, LIKE) so the
 * declarative cell-ACL `when` path can decide per-row field visibility without a
 * round-trip to SQLite. */
export function evalExpr(expr: SqlExpr, row: Record<string, unknown>): boolean {
  switch (expr.t) {
    case "true":
      return true;
    case "false":
      return false;
    case "cmp": {
      const left = bind(row[expr.col]);
      if (expr.value === null) return false; // comparison against NULL is never true (use the `null` node for IS NULL)
      if (left === null || left === undefined) return false; // NULL compared to a value -> false
      const right = bind(expr.value);
      switch (expr.op) {
        case "=": return left === right;
        case "!=": return left !== right;
        case ">": return (left as never) > (right as never);
        case ">=": return (left as never) >= (right as never);
        case "<": return (left as never) < (right as never);
        case "<=": return (left as never) <= (right as never);
        case "LIKE": return typeof left === "string" && likeToRegex(String(right)).test(left);
      }
      return false;
    }
    case "null": {
      const v = row[expr.col];
      const isNullVal = v === null || v === undefined;
      return expr.negate ? !isNullVal : isNullVal;
    }
    case "strmatch": {
      const left = row[expr.col];
      if (typeof left !== "string") return false;
      const s = left.toLowerCase();
      const n = expr.needle.toLowerCase(); // CI, mirroring SQLite's default LIKE
      return expr.mode === "contains" ? s.includes(n) : expr.mode === "prefix" ? s.startsWith(n) : s.endsWith(n);
    }
    case "in": {
      const left = bind(row[expr.col]);
      if (left === null || left === undefined) return false; // can't demonstrate membership
      if (expr.values.length === 0) return expr.negate; // empty: notIn=>all, in=>none
      const found = expr.values.some((v) => bind(v) === left);
      return expr.negate ? !found : found;
    }
    case "and":
      return expr.parts.every((p) => evalExpr(p, row));
    case "or":
      return expr.parts.some((p) => evalExpr(p, row));
    case "not":
      return !evalExpr(expr.expr, row);
    case "sub":
      // Relation traversal needs a SQL round-trip; it isn't supported in the
      // in-memory cell-ACL `when` evaluator (those predicates must be single-table).
      throw new Error("relation predicates are not supported in cell-level `when`");
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

export type AggFn = "count" | "sum" | "avg" | "min" | "max";
const AGG_SQL: Record<AggFn, string> = { count: "COUNT", sum: "SUM", avg: "AVG", min: "MIN", max: "MAX" };

export function compileCount(from: string, dialect: Dialect, where?: SqlExpr): CompiledSql {
  const params: unknown[] = [];
  let sql = `SELECT COUNT(*) AS n FROM ${dialect.id(from)}`;
  if (where && where.t !== "true") sql += ` WHERE ${compileExpr(where, dialect, params).sql}`;
  return { sql, params };
}

export interface Aggregation {
  fn: AggFn;
  column?: string;
}

export function compileAggregate(
  spec: {
    from: string;
    where?: SqlExpr;
    groupBy?: string[];
    aggregations: Record<string, Aggregation>;
  },
  dialect: Dialect,
): CompiledSql {
  const params: unknown[] = [];
  const cols: string[] = [];
  for (const g of spec.groupBy ?? []) cols.push(dialect.id(g));
  for (const [key, agg] of Object.entries(spec.aggregations)) {
    const target = agg.column != null ? dialect.id(agg.column) : "*";
    cols.push(`${AGG_SQL[agg.fn]}(${target}) AS ${dialect.id(key)}`);
  }
  let sql = `SELECT ${cols.join(", ")} FROM ${dialect.id(spec.from)}`;
  if (spec.where && spec.where.t !== "true") sql += ` WHERE ${compileExpr(spec.where, dialect, params).sql}`;
  if (spec.groupBy && spec.groupBy.length > 0) sql += ` GROUP BY ${spec.groupBy.map((g) => dialect.id(g)).join(", ")}`;
  return { sql, params };
}

export function compileSelect(spec: QuerySpec, dialect: Dialect): CompiledSql {
  const params: unknown[] = [];
  let sql = `SELECT * FROM ${dialect.id(spec.from)}`;

  if (spec.where && spec.where.t !== "true") {
    const { sql: where } = compileExpr(spec.where, dialect, params);
    sql += ` WHERE ${where}`;
  }

  if (spec.orderBy && spec.orderBy.length > 0) {
    const cols = spec.orderBy.map((o) => `${dialect.id(o.column)} ${o.dir === "desc" ? "DESC" : "ASC"}`);
    sql += ` ORDER BY ${cols.join(", ")}`;
  }

  if (spec.limit != null) {
    params.push(spec.limit);
    sql += ` LIMIT ${dialect.placeholder(params.length)}`;
  } else if (spec.offset != null) {
    sql += " LIMIT -1"; // SQLite requires a LIMIT before OFFSET (offset-only is a SQLite-ism)
  }
  if (spec.offset != null) {
    params.push(spec.offset);
    sql += ` OFFSET ${dialect.placeholder(params.length)}`;
  }

  return { sql, params };
}
