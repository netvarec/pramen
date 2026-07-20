// A Driver backed by bun:sqlite — an async, non-DO substrate used to prove the
// engine (migrate, Db, ACL) runs unchanged over the Driver seam. Behaves like D1
// (async, SQLite dialect, no interactive transaction); `batch()` models D1's atomic
// db.batch(). Foreign keys are enabled to mirror DO/D1's default enforcement.

import type { Database } from "bun:sqlite";
import { sqliteDialect, type Driver, type Row } from "../packages/server/src/runtime/driver";

export function bunSqliteDriver(db: Database): Driver {
  db.run("PRAGMA foreign_keys = ON"); // DO + D1 enforce FKs by default; match them here
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
      return fn(); // bun:sqlite autocommits each statement; matches D1's non-atomic transaction()
    },
    async batch(statements: ReadonlyArray<{ sql: string; params: unknown[] }>): Promise<void> {
      // A real transaction with deferred FK checks — mirrors D1's atomic db.batch(): a
      // rebuild's transient FK violations are validated only at the batch commit.
      db.run("BEGIN");
      try {
        db.run("PRAGMA defer_foreign_keys = ON");
        for (const s of statements) db.run(s.sql, ...(s.params as never[]));
        db.run("COMMIT");
      } catch (e) {
        try {
          db.run("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        throw e;
      }
    },
  };
}
