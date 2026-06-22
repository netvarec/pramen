// Unit test for the migrator against real SQLite (bun:sqlite), driven through the
// async Driver seam (the same path D1 uses). ALTER TABLE ADD COLUMN and the
// table-rebuild are standard SQLite; the e2e suite separately exercises the boot
// path on the real DO.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, renamedFrom } from "../packages/server/src/sdk/schema";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

const v1 = defineSchema({
  notes: Entity((t) => ({ id: t.id(), title: t.text() })),
});

const v2 = defineSchema({
  notes: Entity((t) => ({ id: t.id(), title: t.text(), body: t.text(), views: t.int() })),
  tags: Entity((t) => ({ id: t.id(), name: t.text() })),
});

// v3: drop `views`, rename `body` -> `content`, drop the `tags` table.
const v3 = defineSchema({
  notes: Entity((t) => ({ id: t.id(), title: t.text(), content: renamedFrom(t.text(), "body") })),
});

describe("migrate", () => {
  test("creates tables on first run", async () => {
    const db = new Database(":memory:");
    const r = await migrate(bunSqliteDriver(db), v1);
    expect(r.changed).toBe(true);
    expect(r.created).toContain("notes");
    db.run("INSERT INTO notes (title) VALUES ('hi')");
    expect(db.query("SELECT title FROM notes").all()).toEqual([{ title: "hi" }]);
  });

  test("is a no-op when the schema is unchanged (hash short-circuit)", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, v1);
    const r = await migrate(d, v1);
    expect(r.changed).toBe(false);
    expect(r.created).toEqual([]);
    expect(r.added).toEqual([]);
  });

  test("adds new columns and tables without losing data", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, v1);
    db.run("INSERT INTO notes (title) VALUES ('keep me')");

    const r = await migrate(d, v2);
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

  test("upgrade is idempotent", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, v1);
    await migrate(d, v2);
    const again = await migrate(d, v2);
    expect(again.changed).toBe(false);
  });

  test("drops columns, renames, and drops tables (rebuild preserves rows + ids)", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, v2);
    db.run("INSERT INTO notes (title, body, views) VALUES ('keep', 'mybody', 7)");
    db.run("INSERT INTO tags (name) VALUES ('x')");
    const id = (db.query("SELECT id FROM notes").all() as { id: number }[])[0]!.id;

    const r = await migrate(d, v3, { allowDestructive: true });
    expect(r.changed).toBe(true);
    expect(r.rebuilt).toContain("notes");
    expect(r.droppedTables).toContain("tags");

    // `views` dropped, `body` renamed to `content` with data intact, id preserved.
    expect(db.query("SELECT id, title, content FROM notes").all()).toEqual([{ id, title: "keep", content: "mybody" }]);
    expect(() => db.query("SELECT views FROM notes").all()).toThrow();
    expect(() => db.query("SELECT 1 FROM tags").all()).toThrow();

    // re-running is a no-op (the rename source no longer exists).
    expect((await migrate(d, v3)).changed).toBe(false);
  });

  test("skips destructive changes by default (data-loss gate)", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, v2);
    db.run("INSERT INTO notes (title, body, views) VALUES ('keep', 'mybody', 7)");
    db.run("INSERT INTO tags (name) VALUES ('x')");

    // Default (no allowDestructive): additive-only — the drop/rename/table-drop is skipped.
    const r = await migrate(d, v3);
    expect(r.rebuilt).toEqual([]);
    expect(r.droppedTables).toEqual([]);
    expect(r.skipped.length).toBeGreaterThan(0);
    // data untouched: the old columns + table are still there
    expect(db.query("SELECT title, body, views FROM notes").all()).toEqual([{ title: "keep", body: "mybody", views: 7 }]);
    expect(db.query("SELECT count(*) AS n FROM tags").all()).toEqual([{ n: 1 }]);
    // hash NOT written, so a later opt-in deploy still applies it
    const applied = await migrate(d, v3, { allowDestructive: true });
    expect(applied.rebuilt).toContain("notes");
    expect(applied.droppedTables).toContain("tags");
  });

  test("applies a column type change with a CAST", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, defineSchema({ items: Entity((t) => ({ id: t.id(), qty: t.text() })) }));
    db.run("INSERT INTO items (qty) VALUES ('42')");

    const r = await migrate(d, defineSchema({ items: Entity((t) => ({ id: t.id(), qty: t.int() })) }), {
      allowDestructive: true,
    });
    expect(r.rebuilt).toContain("items");
    // text "42" CAST to INTEGER affinity -> numeric 42.
    expect(db.query("SELECT qty FROM items").all()).toEqual([{ qty: 42 }]);
  });

  test("rejects a cross-partition schema before touching the store", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    const bad = defineSchema({
      users: Entity((t) => ({ id: t.id(), name: t.text() }), undefined, { partition: "audit" }),
      notes: Entity(
        (t) => ({ id: t.id(), authorId: t.int() }),
        (r) => ({ author: r.belongsTo("users", "authorId") }),
      ),
    });
    await expect(migrate(d, bad)).rejects.toThrow(
      "relation 'notes.author' crosses a partition boundary: 'notes' is in partition " +
        "'default' but target 'users' is in 'audit'.",
    );
    // failed fast — no tables created (not even the bookkeeping meta table).
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });

  test("preserves ids across a rebuild and keeps numbering from the max", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, v2);
    db.run("INSERT INTO notes (title) VALUES ('a')"); // id 1
    db.run("INSERT INTO notes (title) VALUES ('b')"); // id 2
    await migrate(d, v3, { allowDestructive: true }); // rebuild (drop views, body -> content)
    db.run("INSERT INTO notes (title, content) VALUES ('c', 'cc')");
    const ids = (db.query("SELECT id FROM notes ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(ids).toEqual([1, 2, 3]); // existing ids kept; new row continues from the max
  });
});
