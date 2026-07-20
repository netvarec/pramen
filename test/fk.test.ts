// Real foreign keys on a belongsTo that declares onDelete: runtime enforcement
// (CASCADE / SET NULL / RESTRICT, insert integrity) and migration (add/remove an FK via
// a rebuild, and the orphaned-data skip). Driven over bun:sqlite with FKs enabled — the
// test driver mirrors DO/D1's default enforcement and models D1's atomic batch().

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema } from "../packages/server/src/sdk/schema";
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
