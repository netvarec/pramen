// Real foreign keys on a belongsTo that declares onDelete: runtime enforcement
// (CASCADE / SET NULL / RESTRICT, insert integrity) and migration (add/remove an FK via
// a rebuild, and the orphaned-data skip). Driven over bun:sqlite with FKs enabled — the
// test driver mirrors DO/D1's default enforcement and models D1's atomic batch().

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defaultTo, defineSchema, Entity, expr } from "../packages/server/src/sdk/schema";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

const withOnDelete = (action: "cascade" | "setNull" | "restrict") =>
  defineSchema({
    authors: Entity((t) => ({ id: t.id(), name: t.text() })),
    posts: Entity(
      (t) => ({ id: t.id(), title: t.text(), authorId: t.int() }),
      (r) => ({ author: r.belongsTo("authors", "authorId", { onDelete: action }) }),
    ),
  });
const noFk = defineSchema({
  authors: Entity((t) => ({ id: t.id(), name: t.text() })),
  posts: Entity(
    (t) => ({ id: t.id(), title: t.text(), authorId: t.int() }),
    (r) => ({ author: r.belongsTo("authors", "authorId") }),
  ),
});

const fkList = (db: Database) => db.query("PRAGMA foreign_key_list(posts)").all() as { table: string; from: string; on_delete: string }[];
const count = (db: Database, sql: string) => (db.query(sql).get() as { n: number }).n;

describe("foreign keys — runtime enforcement", () => {
  test("a new table emits the FK with its ON DELETE action", async () => {
    const db = new Database(":memory:");
    await migrate(bunSqliteDriver(db), withOnDelete("cascade"));
    const fks = fkList(db);
    expect(fks).toHaveLength(1);
    expect(fks[0].table).toBe("authors");
    expect(fks[0].from).toBe("authorId");
    expect(fks[0].on_delete.toUpperCase()).toBe("CASCADE");
  });

  test("insert integrity: a reference to a missing row is rejected", async () => {
    const db = new Database(":memory:");
    await migrate(bunSqliteDriver(db), withOnDelete("cascade"));
    expect(() => db.run("INSERT INTO posts (title, authorId) VALUES ('x', 999)")).toThrow();
  });

  test("ON DELETE CASCADE removes the referencing rows", async () => {
    const db = new Database(":memory:");
    await migrate(bunSqliteDriver(db), withOnDelete("cascade"));
    db.run("INSERT INTO authors (id, name) VALUES (1, 'A')");
    db.run("INSERT INTO posts (title, authorId) VALUES ('p1', 1), ('p2', 1)");
    db.run("DELETE FROM authors WHERE id = 1");
    expect(count(db, "SELECT count(*) AS n FROM posts")).toBe(0);
  });

  test("ON DELETE SET NULL nulls the FK column", async () => {
    const db = new Database(":memory:");
    await migrate(bunSqliteDriver(db), withOnDelete("setNull"));
    db.run("INSERT INTO authors (id, name) VALUES (1, 'A')");
    db.run("INSERT INTO posts (title, authorId) VALUES ('p1', 1)");
    db.run("DELETE FROM authors WHERE id = 1");
    expect((db.query("SELECT authorId FROM posts").get() as { authorId: number | null }).authorId).toBe(null);
  });

  test("ON DELETE RESTRICT blocks deleting a referenced row", async () => {
    const db = new Database(":memory:");
    await migrate(bunSqliteDriver(db), withOnDelete("restrict"));
    db.run("INSERT INTO authors (id, name) VALUES (1, 'A')");
    db.run("INSERT INTO posts (title, authorId) VALUES ('p1', 1)");
    expect(() => db.run("DELETE FROM authors WHERE id = 1")).toThrow();
  });
});

describe("foreign keys — migration", () => {
  test("declaring onDelete rebuilds the table and installs the FK", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, noFk);
    expect(fkList(db)).toHaveLength(0);
    const r = await migrate(d, withOnDelete("cascade"));
    expect(r.changed).toBe(true);
    expect(r.rebuilt).toContain("posts");
    expect(fkList(db)).toHaveLength(1);
    // cascade now works end-to-end
    db.run("INSERT INTO authors (id, name) VALUES (1, 'A')");
    db.run("INSERT INTO posts (title, authorId) VALUES ('p', 1)");
    db.run("DELETE FROM authors WHERE id = 1");
    expect(count(db, "SELECT count(*) AS n FROM posts")).toBe(0);
  });

  test("the rebuild preserves existing rows", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, noFk);
    db.run("INSERT INTO authors (id, name) VALUES (1, 'A')");
    db.run("INSERT INTO posts (title, authorId) VALUES ('kept', 1)");
    await migrate(d, withOnDelete("cascade")); // rebuild with valid data -> FK installs
    expect(count(db, "SELECT count(*) AS n FROM posts")).toBe(1);
    expect(fkList(db)).toHaveLength(1);
  });

  test("adding an FK over orphaned data is skipped (reported), not a failure", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, noFk);
    db.run("INSERT INTO posts (title, authorId) VALUES ('orphan', 999)"); // no such author
    const r = await migrate(d, withOnDelete("cascade"));
    expect(r.skipped.some((s) => s.includes("add FK posts.authorId"))).toBe(true);
    expect(fkList(db)).toHaveLength(0); // FK not installed
    expect(count(db, "SELECT count(*) AS n FROM posts")).toBe(1); // orphan preserved
  });

  test("removing onDelete drops the FK on the next rebuild", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, withOnDelete("cascade"));
    expect(fkList(db)).toHaveLength(1);
    await migrate(d, noFk);
    expect(fkList(db)).toHaveLength(0);
  });
});

// Rebuilding a table that live FKs REFERENCE (the parent side) must not fire the
// children's ON DELETE actions: `DROP TABLE parent` implicit-DELETEs its rows, and
// defer_foreign_keys defers only checks, not actions — so without the holder
// quarantine, CASCADE wipes the children, SET NULL corrupts them, and RESTRICT
// aborts the migration. The parent rebuild is triggered by an expr-default column
// (a safe, ungated rebuild).
describe("foreign keys — rebuilding the referenced (parent) table", () => {
  const parentV2 = (action: "cascade" | "setNull" | "restrict") =>
    defineSchema({
      authors: Entity((t) => ({ id: t.id(), name: t.text(), createdAt: defaultTo(t.text(), expr.now()) })),
      posts: Entity(
        (t) => ({ id: t.id(), title: t.text(), authorId: t.int() }),
        (r) => ({ author: r.belongsTo("authors", "authorId", { onDelete: action }) }),
      ),
    });

  for (const action of ["cascade", "setNull", "restrict"] as const) {
    test(`children with ${action} survive a parent rebuild, FK + index intact`, async () => {
      const db = new Database(":memory:");
      const d = bunSqliteDriver(db);
      await migrate(d, withOnDelete(action));
      db.run("INSERT INTO authors (id, name) VALUES (1, 'A'), (2, 'B')");
      db.run("INSERT INTO posts (title, authorId) VALUES ('p1', 1), ('p2', 2)");
      const r = await migrate(d, parentV2(action)); // authors gains an expr-default column -> rebuild
      expect(r.rebuilt).toContain("authors");
      expect(r.skipped).toHaveLength(0);
      const posts = db.query("SELECT title, authorId FROM posts ORDER BY title").all() as { title: string; authorId: number | null }[];
      expect(posts).toEqual([
        { title: "p1", authorId: 1 },
        { title: "p2", authorId: 2 },
      ]);
      // the new column backfilled existing parent rows
      expect(count(db, "SELECT count(*) AS n FROM authors WHERE createdAt IS NOT NULL")).toBe(2);
      // the children's FK survived and still enforces
      expect(fkList(db)).toHaveLength(1);
      expect(() => db.run("INSERT INTO posts (title, authorId) VALUES ('bad', 999)")).toThrow();
    });
  }

  test("DO-shaped path (no batch, ambient transaction) preserves children too", async () => {
    const db = new Database(":memory:");
    const { batch: _batch, ...noBatch } = bunSqliteDriver(db);
    await migrate(noBatch, withOnDelete("cascade"));
    db.run("INSERT INTO authors (id, name) VALUES (1, 'A')");
    db.run("INSERT INTO posts (title, authorId) VALUES ('kept', 1)");
    db.run("BEGIN"); // the DO wraps boot migration in storage.transaction()
    const r = await migrate(noBatch, parentV2("cascade"));
    db.run("COMMIT");
    expect(r.rebuilt).toContain("authors");
    expect(count(db, "SELECT count(*) AS n FROM posts")).toBe(1);
    expect(fkList(db)).toHaveLength(1);
  });

  test("self-referential FK: the table rebuilds through a bare copy, rows intact", async () => {
    const selfV1 = defineSchema({
      categories: Entity(
        (t) => ({ id: t.id(), name: t.text(), parentId: t.int() }),
        (r) => ({ parent: r.belongsTo("categories", "parentId", { onDelete: "setNull" }) }),
      ),
    });
    const selfV2 = defineSchema({
      categories: Entity(
        (t) => ({ id: t.id(), name: t.text(), parentId: t.int(), createdAt: defaultTo(t.text(), expr.now()) }),
        (r) => ({ parent: r.belongsTo("categories", "parentId", { onDelete: "setNull" }) }),
      ),
    });
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, selfV1);
    db.run("INSERT INTO categories (id, name, parentId) VALUES (1, 'root', NULL), (2, 'child', 1)");
    const r = await migrate(d, selfV2);
    expect(r.rebuilt).toContain("categories");
    const rows = db.query("SELECT id, parentId FROM categories ORDER BY id").all() as { id: number; parentId: number | null }[];
    expect(rows).toEqual([
      { id: 1, parentId: null },
      { id: 2, parentId: 1 },
    ]);
    // the self-FK survived and still acts
    db.run("DELETE FROM categories WHERE id = 1");
    expect((db.query("SELECT parentId FROM categories WHERE id = 2").get() as { parentId: number | null }).parentId).toBe(null);
  });
});
