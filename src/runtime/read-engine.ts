// Read engine — compiles a structured query spec into parameterized SQL.
// This is the TS stand-in for the prior runtime's Rust ReadEngine. The "no hand-written SQL
// in handler code" property is preserved; the long-term plan (see DESIGN.md) is
// to compile this module to WASM so the hot path leaves JS entirely.

export interface QuerySpec {
  readonly from: string;
  readonly where?: Record<string, unknown>;
  readonly orderBy?: { column: string; dir?: "asc" | "desc" };
  readonly limit?: number;
}

export interface CompiledSql {
  readonly sql: string;
  readonly params: unknown[];
}

function bind(v: unknown): unknown {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

export function compileSelect(spec: QuerySpec): CompiledSql {
  const params: unknown[] = [];
  let sql = `SELECT * FROM ${spec.from}`;

  if (spec.where && Object.keys(spec.where).length > 0) {
    const clauses = Object.entries(spec.where).map(([col, val]) => {
      params.push(bind(val));
      return `${col} = ?`;
    });
    sql += ` WHERE ${clauses.join(" AND ")}`;
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
