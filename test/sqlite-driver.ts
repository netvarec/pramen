// A Driver backed by bun:sqlite — an async, non-DO substrate used to prove the
// engine (migrate, Db, ACL) runs unchanged over the Driver seam. Behaves like D1
// (async, SQLite dialect); the only thing it doesn't model is real transactions.

import type { Database } from "bun:sqlite";
import { sqliteDialect, type Driver, type Row } from "../packages/server/src/runtime/driver";

export function bunSqliteDriver(db: Database): Driver {
  return {
    dialect: sqliteDialect,
    async exec(sql: string, params: unknown[]): Promise<Row[]> {
      // SELECT/PRAGMA and any ...RETURNING write produce rows; everything else (DDL,
      // plain writes) goes through run().
      if (/^\s*(select|pragma)/i.test(sql) || /\breturning\b/i.test(sql)) {
        return db.query(sql).all(...(params as never[])) as Row[];
      }
      db.run(sql, ...(params as never[]));
      return [];
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      return fn(); // bun:sqlite autocommits each statement; good enough for these tests
    },
  };
}
