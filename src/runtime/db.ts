// Db — the thin repository surface handed to handlers. Wraps the DO's in-process
// SqlStorage. The the prior runtime analog is the ORM's repositories over Turso.

import { compileSelect, type QuerySpec } from "./read-engine";

type Row = Record<string, unknown>;

function bind(v: unknown): unknown {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

export class Db {
  constructor(private readonly sql: SqlStorage) {}

  /** Structured read; SQL is compiled by the read engine. */
  find(spec: QuerySpec): Row[] {
    const { sql, params } = compileSelect(spec);
    return this.sql.exec(sql, ...params).toArray() as Row[];
  }

  /** Insert a single row, returning the persisted row (with generated id). */
  insert(table: string, values: Row): Row {
    const cols = Object.keys(values);
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`;
    const rows = this.sql.exec(sql, ...cols.map((c) => bind(values[c]))).toArray() as Row[];
    return rows[0]!;
  }

  /** Escape hatch for raw SQL. */
  exec(sql: string, ...params: unknown[]): Row[] {
    return this.sql.exec(sql, ...params.map(bind)).toArray() as Row[];
  }
}
