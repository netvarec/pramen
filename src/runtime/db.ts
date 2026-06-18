// Db — the thin repository surface handed to handlers. Wraps the DO's in-process
// SqlStorage. The the prior runtime analog is the ORM's repositories over Turso.
//
// Every Db records the set of tables it touched during one handler run (`touched`).
// Queries use it to declare their read dependencies; mutations use it to declare
// what they invalidated. The live-query layer intersects the two to decide which
// subscriptions to re-run. Create a fresh Db per handler run so `touched` is scoped.

import { compileSelect, type QuerySpec } from "./read-engine";

type Row = Record<string, unknown>;

function bind(v: unknown): unknown {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

// Best-effort table extraction for raw exec(): FROM / INTO / UPDATE <table>.
const TABLE_RE = /\b(?:from|into|update)\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi;

export class Db {
  /** Tables read or written during this Db's lifetime. */
  readonly touched = new Set<string>();

  constructor(private readonly sql: SqlStorage) {}

  /** Structured read; SQL is compiled by the read engine. */
  find(spec: QuerySpec): Row[] {
    this.touched.add(spec.from);
    const { sql, params } = compileSelect(spec);
    return this.sql.exec(sql, ...params).toArray() as Row[];
  }

  /** Insert a single row, returning the persisted row (with generated id). */
  insert(table: string, values: Row): Row {
    this.touched.add(table);
    const cols = Object.keys(values);
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`;
    const rows = this.sql.exec(sql, ...cols.map((c) => bind(values[c]))).toArray() as Row[];
    return rows[0]!;
  }

  /** Update a row by id, returning the persisted row. Empty patch is a no-op read. */
  update(table: string, id: unknown, patch: Row): Row {
    this.touched.add(table);
    const cols = Object.keys(patch);
    if (cols.length === 0) {
      return this.find({ from: table, where: { id }, limit: 1 })[0]!;
    }
    const assignments = cols.map((c) => `${c} = ?`).join(", ");
    const sql = `UPDATE ${table} SET ${assignments} WHERE id = ? RETURNING *`;
    const rows = this.sql.exec(sql, ...cols.map((c) => bind(patch[c])), bind(id)).toArray() as Row[];
    return rows[0]!;
  }

  /** Escape hatch for raw SQL. Tables are inferred best-effort for invalidation. */
  exec(sql: string, ...params: unknown[]): Row[] {
    for (const m of sql.matchAll(TABLE_RE)) this.touched.add(m[1]!);
    return this.sql.exec(sql, ...params.map(bind)).toArray() as Row[];
  }
}
