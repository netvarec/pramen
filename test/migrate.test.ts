// Unit test for the additive migrator against real SQLite (bun:sqlite). DO SQLite
// uses its own engine, but ALTER TABLE ADD COLUMN is standard; the e2e suite
// separately exercises the create + PRAGMA path on the real DO at boot.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema } from "../src/sdk/schema";
import { migrate } from "../src/runtime/migrate";

// Adapt bun:sqlite to the SqlStorage shape migrate() expects: exec(sql, ...params)
// returning a cursor with toArray().
function adapt(db: Database): any {
  return {
    exec(sql: string, ...params: unknown[]) {
      if (/^\s*(select|pragma)/i.test(sql)) {
        return { toArray: () => db.query(sql).all(...(params as any[])) };
      }
      db.run(sql, ...(params as any[]));
      return { toArray: () => [] };
    },
  };
}

const v1 = defineSchema({
  notes: Entity((t) => ({ id: t.id(), title: t.text() })),
});

const v2 = defineSchema({
  notes: Entity((t) => ({ id: t.id(), title: t.text(), body: t.text(), views: t.int() })),
  tags: Entity((t) => ({ id: t.id(), name: t.text() })),
});

describe("migrate", () => {
  test("creates tables on first run", () => {
    const db = new Database(":memory:");
    const r = migrate(adapt(db), v1);
    expect(r.changed).toBe(true);
    expect(r.created).toContain("notes");
    db.run("INSERT INTO notes (title) VALUES ('hi')");
    expect(db.query("SELECT title FROM notes").all()).toEqual([{ title: "hi" }]);
  });

  test("is a no-op when the schema is unchanged (hash short-circuit)", () => {
    const db = new Database(":memory:");
    const sql = adapt(db);
    migrate(sql, v1);
    const r = migrate(sql, v1);
    expect(r.changed).toBe(false);
    expect(r.created).toEqual([]);
    expect(r.added).toEqual([]);
  });

  test("adds new columns and tables without losing data", () => {
    const db = new Database(":memory:");
    const sql = adapt(db);
    migrate(sql, v1);
    db.run("INSERT INTO notes (title) VALUES ('keep me')");

    const r = migrate(sql, v2);
    expect(r.changed).toBe(true);
    expect(r.added).toContain("notes.body");
    expect(r.added).toContain("notes.views");
    expect(r.created).toContain("tags");

    // existing row preserved; new columns default to NULL
    expect(db.query("SELECT title, body, views FROM notes").all()).toEqual([
      { title: "keep me", body: null, views: null },
    ]);
    // new table usable
    expect(db.query("SELECT count(*) AS n FROM tags").all()).toEqual([{ n: 0 }]);
  });

  test("upgrade is idempotent", () => {
    const db = new Database(":memory:");
    const sql = adapt(db);
    migrate(sql, v1);
    migrate(sql, v2);
    const again = migrate(sql, v2);
    expect(again.changed).toBe(false);
  });
});
