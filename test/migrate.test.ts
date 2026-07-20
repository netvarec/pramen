// Unit test for the migrator against real SQLite (bun:sqlite), driven through the
// async Driver seam (the same path D1 uses). ALTER TABLE ADD COLUMN and the
// table-rebuild are standard SQLite; the e2e suite separately exercises the boot
// path on the real DO.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, renamedFrom, hidden, unique, notNull, defaultTo } from "../packages/server/src/sdk/schema";
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

// --- partition-scoped migration. A partition-DO runs migrate with `{ partition }`
// so it only ever creates/alters/drops its OWN tables, and tracks drift under a
// per-partition hash key (so partitions don't thrash each other).

const tableNames = (db: Database): string[] =>
  (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

describe("migrate — partition-scoped", () => {
  // `notes` in the default partition; `audit` (+ `audit_meta`) in the "audit" partition.
  const multi = defineSchema({
    notes: Entity((t) => ({ id: t.id(), title: t.text() })),
    audit: Entity((t) => ({ id: t.id(), action: t.text() }), undefined, { partition: "audit" }),
    audit_meta: Entity((t) => ({ id: t.id(), note: t.text() }), undefined, { partition: "audit" }),
  });

  test("creates only the named partition's tables; default-partition tables absent", async () => {
    const db = new Database(":memory:");
    const r = await migrate(bunSqliteDriver(db), multi, { partition: "audit" });
    expect(r.changed).toBe(true);
    expect(r.created.sort()).toEqual(["audit", "audit_meta"]);
    expect(tableNames(db).sort()).toEqual(["audit", "audit_meta"]);
    // the default partition's table was never created in this DO
    expect(tableNames(db)).not.toContain("notes");
  });

  test("default-partition scope creates only default tables", async () => {
    const db = new Database(":memory:");
    const r = await migrate(bunSqliteDriver(db), multi, { partition: "default" });
    expect(r.created).toEqual(["notes"]);
    expect(tableNames(db)).toEqual(["notes"]);
  });

  test("no partition (default) creates every partition's tables — unchanged behavior", async () => {
    const db = new Database(":memory:");
    const r = await migrate(bunSqliteDriver(db), multi);
    expect(r.created.sort()).toEqual(["audit", "audit_meta", "notes"]);
    expect(tableNames(db).sort()).toEqual(["audit", "audit_meta", "notes"]);
  });

  test("re-running the same partition is a no-op (per-partition hash short-circuit)", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, multi, { partition: "audit" });
    const again = await migrate(d, multi, { partition: "audit" });
    expect(again.changed).toBe(false);
    expect(again.created).toEqual([]);
  });

  test("changing a DIFFERENT partition's entity does not invalidate this partition's hash", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    // Migrate the audit partition; record its applied hash.
    await migrate(d, multi, { partition: "audit" });

    // A new schema version that only changes the DEFAULT partition (adds a column to
    // `notes`), leaving the audit entities byte-for-byte identical.
    const multiV2 = defineSchema({
      notes: Entity((t) => ({ id: t.id(), title: t.text(), body: t.text() })),
      audit: Entity((t) => ({ id: t.id(), action: t.text() }), undefined, { partition: "audit" }),
      audit_meta: Entity((t) => ({ id: t.id(), note: t.text() }), undefined, { partition: "audit" }),
    });
    // Re-running the audit partition against the changed app is still a no-op: the
    // audit subset is unchanged, so its hash matches.
    const r = await migrate(d, multiV2, { partition: "audit" });
    expect(r.changed).toBe(false);
  });

  test("changing THIS partition's entity does invalidate its hash", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, multi, { partition: "audit" });
    const multiV2 = defineSchema({
      notes: Entity((t) => ({ id: t.id(), title: t.text() })),
      audit: Entity((t) => ({ id: t.id(), action: t.text(), at: t.int() }), undefined, { partition: "audit" }),
      audit_meta: Entity((t) => ({ id: t.id(), note: t.text() }), undefined, { partition: "audit" }),
    });
    const r = await migrate(d, multiV2, { partition: "audit" });
    expect(r.changed).toBe(true);
    expect(r.added).toContain("audit.at");
  });

  test("a partition's drop pass never drops another partition's live tables", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    // Stand up the full app (all partitions) in one store, as a shared-store test.
    await migrate(d, multi);
    expect(tableNames(db).sort()).toEqual(["audit", "audit_meta", "notes"]);

    // Now run a partition-scoped migration where the audit partition has DROPPED
    // `audit_meta`. With allowDestructive, audit_meta is dropped, but `notes` (a
    // different partition's live table) must be left untouched.
    const auditTrimmed = defineSchema({
      notes: Entity((t) => ({ id: t.id(), title: t.text() })),
      audit: Entity((t) => ({ id: t.id(), action: t.text() }), undefined, { partition: "audit" }),
    });
    const r = await migrate(d, auditTrimmed, { partition: "audit", allowDestructive: true });
    expect(r.droppedTables).toEqual(["audit_meta"]);
    expect(tableNames(db).sort()).toEqual(["audit", "notes"]); // notes survived
  });

  // Mirrors upgrading a deployed @pramen/auth store (0.0.7 -> the email/active shape):
  // adding a nullable UNIQUE column + a bool column with a DEFAULT to a populated table.
  test("adds nullable unique + defaulted columns to a populated table, backfilling", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    // v0: the shipped auth_users (no email/active).
    const v0 = defineSchema({
      auth_users: Entity((t) => ({ username: t.textId(), passwordHash: t.text(), roles: t.json(), createdAt: t.int() })),
    });
    await migrate(d, v0);
    db.run("INSERT INTO auth_users (username, passwordHash, roles, createdAt) VALUES ('alice', 'h', '[\"user\"]', 1)");

    // v1: + email (unique, nullable) + active (bool DEFAULT true), like the new schema.
    const v1auth = defineSchema({
      auth_users: Entity((t) => ({
        username: t.textId(),
        passwordHash: hidden(t.text()),
        roles: t.json(),
        email: unique(t.text()),
        active: defaultTo(t.bool(), true),
        createdAt: t.int(),
      })),
    });
    const r = await migrate(d, v1auth);
    expect(r.changed).toBe(true);
    expect(r.added).toEqual(expect.arrayContaining(["auth_users.email", "auth_users.active"]));

    const row = db.query("SELECT email, active FROM auth_users WHERE username = 'alice'").get() as {
      email: unknown;
      active: unknown;
    };
    expect(row.email).toBe(null); // backfilled NULL
    expect(row.active).toBe(1); // backfilled to the DEFAULT (active)

    // the UNIQUE index allows multiple NULL emails...
    db.run("INSERT INTO auth_users (username, passwordHash, roles, createdAt) VALUES ('bob', 'h', '[\"user\"]', 2)");
    db.run("UPDATE auth_users SET email = 'x@y.com' WHERE username = 'alice'");
    // ...but rejects a duplicate non-null email.
    expect(() => db.run("UPDATE auth_users SET email = 'x@y.com' WHERE username = 'bob'")).toThrow();
  });
});

// --- modifier reconciliation on an EXISTING column. migrate() now detects and applies
// (or safely skips) a NOT NULL / DEFAULT / PRIMARY KEY / UNIQUE change on a column that
// already exists — and, crucially, only records the schema hash when the store fully
// matches the schema, so a skipped change keeps showing as drift instead of silently
// diverging.

describe("migrate — modifier reconciliation", () => {
  test("adding notNull() over NULL rows (no default) is skipped by default; hash unwritten", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    const base = defineSchema({ notes: Entity((t) => ({ id: t.id(), code: t.text() })) });
    await migrate(d, base);
    db.run("INSERT INTO notes (code) VALUES (NULL)");
    db.run("INSERT INTO notes (code) VALUES ('a')");

    const v = defineSchema({ notes: Entity((t) => ({ id: t.id(), code: notNull(t.text()) })) });
    const r = await migrate(d, v); // gate OFF
    expect(r.rebuilt).toEqual([]);
    expect(r.skipped.some((s) => s.includes("NOT NULL"))).toBe(true);
    // data untouched, NOT NULL not enforced (NULL still present)
    expect(db.query("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 2 });

    // hash NOT written -> the drift persists across a re-run (still skipped, changed).
    const again = await migrate(d, v);
    expect(again.changed).toBe(true);
    expect(again.rebuilt).toEqual([]);
    expect(again.skipped.some((s) => s.includes("NOT NULL"))).toBe(true);
  });

  test("after the NULLs are backfilled, adding notNull() applies and records the hash", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    const base = defineSchema({ notes: Entity((t) => ({ id: t.id(), code: t.text() })) });
    await migrate(d, base);
    db.run("INSERT INTO notes (code) VALUES (NULL)");
    const v = defineSchema({ notes: Entity((t) => ({ id: t.id(), code: notNull(t.text()) })) });
    expect((await migrate(d, v)).skipped.length).toBeGreaterThan(0); // skipped while NULL present

    db.run("UPDATE notes SET code = 'x' WHERE code IS NULL"); // operator fixes the data
    const fixed = await migrate(d, v); // still gate OFF — now safe (no NULLs)
    expect(fixed.rebuilt).toContain("notes");
    expect(fixed.skipped).toEqual([]);
    // NOT NULL is now enforced
    expect(() => db.run("INSERT INTO notes (code) VALUES (NULL)")).toThrow();
    // hash recorded -> re-run is a no-op
    expect((await migrate(d, v)).changed).toBe(false);
  });

  test("adding notNull() with a DEFAULT backfills the NULL rows (applied without the gate)", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    const base = defineSchema({ notes: Entity((t) => ({ id: t.id(), status: t.text() })) });
    await migrate(d, base);
    db.run("INSERT INTO notes (status) VALUES (NULL)");
    db.run("INSERT INTO notes (status) VALUES ('open')");

    const v = defineSchema({ notes: Entity((t) => ({ id: t.id(), status: notNull(defaultTo(t.text(), "pending")) })) });
    const r = await migrate(d, v); // gate OFF — a default makes it safe
    expect(r.rebuilt).toContain("notes");
    expect(r.skipped).toEqual([]);
    // the NULL row was backfilled from the default; the other row kept its value
    expect(db.query("SELECT status FROM notes ORDER BY id").all()).toEqual([{ status: "pending" }, { status: "open" }]);
    expect(() => db.run("INSERT INTO notes (status) VALUES (NULL)")).toThrow();
  });

  test("adding a DEFAULT to an existing column rebuilds, backfills future inserts, records hash", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    const base = defineSchema({ notes: Entity((t) => ({ id: t.id(), status: t.text() })) });
    await migrate(d, base);
    db.run("INSERT INTO notes (id, status) VALUES (1, 'x')");
    db.run("INSERT INTO notes (id, status) VALUES (2, NULL)");

    const v = defineSchema({ notes: Entity((t) => ({ id: t.id(), status: defaultTo(t.text(), "pending") })) });
    const r = await migrate(d, v); // no gate — a DEFAULT add loses no data
    expect(r.rebuilt).toContain("notes");
    expect(r.skipped).toEqual([]);
    // existing rows preserved verbatim (a DEFAULT only fills omitted future inserts)
    expect(db.query("SELECT id, status FROM notes ORDER BY id").all()).toEqual([
      { id: 1, status: "x" },
      { id: 2, status: null },
    ]);
    // an insert omitting status now gets the default
    db.run("INSERT INTO notes (id) VALUES (3)");
    expect(db.query("SELECT status FROM notes WHERE id = 3").get()).toEqual({ status: "pending" });
    // hash recorded -> no-op re-run
    expect((await migrate(d, v)).changed).toBe(false);
  });

  test("changing an existing column's DEFAULT rebuilds and applies the new default", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    const base = defineSchema({ notes: Entity((t) => ({ id: t.id(), status: defaultTo(t.text(), "a") })) });
    await migrate(d, base);
    db.run("INSERT INTO notes (id, status) VALUES (1, 'keep')");

    const v = defineSchema({ notes: Entity((t) => ({ id: t.id(), status: defaultTo(t.text(), "b") })) });
    const r = await migrate(d, v);
    expect(r.rebuilt).toContain("notes");
    expect(r.skipped).toEqual([]);
    expect(db.query("SELECT status FROM notes WHERE id = 1").get()).toEqual({ status: "keep" }); // existing kept
    db.run("INSERT INTO notes (id) VALUES (2)");
    expect(db.query("SELECT status FROM notes WHERE id = 2").get()).toEqual({ status: "b" }); // new default
    expect((await migrate(d, v)).changed).toBe(false);
  });

  test("adding unique() to an existing column creates the index (no rebuild) when there are no dups", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    const base = defineSchema({ notes: Entity((t) => ({ id: t.id(), code: t.text() })) });
    await migrate(d, base);
    db.run("INSERT INTO notes (code) VALUES ('a')");
    db.run("INSERT INTO notes (code) VALUES ('b')");

    const v = defineSchema({ notes: Entity((t) => ({ id: t.id(), code: unique(t.text()) })) });
    const r = await migrate(d, v);
    expect(r.rebuilt).toEqual([]); // unique is an index op, not a rebuild
    expect(r.skipped).toEqual([]);
    // uniqueness now enforced
    db.run("INSERT INTO notes (code) VALUES ('c')");
    expect(() => db.run("INSERT INTO notes (code) VALUES ('a')")).toThrow();
    expect((await migrate(d, v)).changed).toBe(false); // hash recorded
  });

  test("adding unique() to a column with duplicate values is skipped; hash unwritten", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    const base = defineSchema({ notes: Entity((t) => ({ id: t.id(), code: t.text() })) });
    await migrate(d, base);
    db.run("INSERT INTO notes (code) VALUES ('dup')");
    db.run("INSERT INTO notes (code) VALUES ('dup')");

    const v = defineSchema({ notes: Entity((t) => ({ id: t.id(), code: unique(t.text()) })) });
    const r = await migrate(d, v);
    expect(r.skipped.some((s) => s.includes("UNIQUE"))).toBe(true);
    expect(r.rebuilt).toEqual([]);
    // no unique index was created -> a third duplicate still inserts
    db.run("INSERT INTO notes (code) VALUES ('dup')");
    expect(db.query("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 3 });
    // hash unwritten -> a re-run still detects the drift
    expect((await migrate(d, v)).changed).toBe(true);
  });

  test("dropping unique() removes the managed index", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    const base = defineSchema({ notes: Entity((t) => ({ id: t.id(), code: unique(t.text()) })) });
    await migrate(d, base);
    db.run("INSERT INTO notes (code) VALUES ('a')");
    expect(() => db.run("INSERT INTO notes (code) VALUES ('a')")).toThrow(); // unique enforced

    const v = defineSchema({ notes: Entity((t) => ({ id: t.id(), code: t.text() })) });
    const r = await migrate(d, v);
    expect(r.skipped).toEqual([]);
    // the unique index is gone -> a duplicate now inserts
    db.run("INSERT INTO notes (code) VALUES ('a')");
    expect(db.query("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 2 });
    expect((await migrate(d, v)).changed).toBe(false); // hash recorded
  });

  test("a hidden()/generated()-only change records the hash (no physical column change)", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    const base = defineSchema({ notes: Entity((t) => ({ id: t.id(), secret: t.text() })) });
    await migrate(d, base);
    const v = defineSchema({ notes: Entity((t) => ({ id: t.id(), secret: hidden(t.text()) })) });
    const r = await migrate(d, v); // hash differs (hidden is in the fingerprint) but no store delta
    expect(r.rebuilt).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect((await migrate(d, v)).changed).toBe(false); // hash was recorded — store already matched
  });
});

describe("migrate — partition move", () => {
  test("an entity moved to another partition is a skipped manual migration; data preserved, hash unwritten", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    const v1 = defineSchema({ logs: Entity((t) => ({ id: t.id(), msg: t.text() }), undefined, { partition: "p" }) });
    await migrate(d, v1, { partition: "p" }); // creates `logs` in partition p
    db.run("INSERT INTO logs (msg) VALUES ('x')");

    const v2 = defineSchema({ logs: Entity((t) => ({ id: t.id(), msg: t.text() }), undefined, { partition: "q" }) });
    const r = await migrate(d, v2, { partition: "p" });
    expect(r.skipped.some((s) => s.includes("move partition"))).toBe(true);
    // the data is left intact in this DO (never dropped) for a manual cross-DO migration
    expect(db.query("SELECT count(*) AS n FROM logs").get()).toEqual({ n: 1 });
    // hash unwritten -> the drift keeps showing
    expect((await migrate(d, v2, { partition: "p" })).changed).toBe(true);
  });
});

describe("migrate — composite unique", () => {
  const withUnique = defineSchema({
    members: Entity((t) => ({ id: t.id(), orgId: t.text(), userId: t.text() }), undefined, { unique: [["orgId", "userId"]] }),
  });
  const noUnique = defineSchema({
    members: Entity((t) => ({ id: t.id(), orgId: t.text(), userId: t.text() })),
  });

  test("creates a composite unique index that rejects duplicate tuples", async () => {
    const db = new Database(":memory:");
    await migrate(bunSqliteDriver(db), withUnique);
    db.run("INSERT INTO members (orgId, userId) VALUES ('o1', 'u1')");
    db.run("INSERT INTO members (orgId, userId) VALUES ('o1', 'u2')"); // same org, different user — ok
    db.run("INSERT INTO members (orgId, userId) VALUES ('o2', 'u1')"); // different org, same user — ok
    expect(() => db.run("INSERT INTO members (orgId, userId) VALUES ('o1', 'u1')")).toThrow();
  });

  test("declaring a composite unique changes the schema hash (migration re-runs)", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, noUnique);
    const r = await migrate(d, withUnique);
    expect(r.changed).toBe(true);
    expect(() => db.run("INSERT INTO members (orgId, userId) VALUES ('o1','u1'),('o1','u1')")).toThrow();
  });

  test("adding a composite unique over existing duplicate tuples is skipped, not thrown", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, noUnique);
    db.run("INSERT INTO members (orgId, userId) VALUES ('o1', 'u1')");
    db.run("INSERT INTO members (orgId, userId) VALUES ('o1', 'u1')"); // pre-existing duplicate tuple
    const r = await migrate(d, withUnique);
    expect(r.skipped.some((s) => s.includes("composite UNIQUE members(orgId, userId)"))).toBe(true);
    // no index built -> the duplicate stays and further inserts are unconstrained
    db.run("INSERT INTO members (orgId, userId) VALUES ('o1', 'u1')");
    expect(db.query("SELECT count(*) AS n FROM members").get()).toEqual({ n: 3 });
  });

  test("removing a composite unique drops the managed index", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    await migrate(d, withUnique);
    db.run("INSERT INTO members (orgId, userId) VALUES ('o1', 'u1')");
    await migrate(d, noUnique); // drop the constraint
    // the duplicate that would have been rejected now inserts fine
    db.run("INSERT INTO members (orgId, userId) VALUES ('o1', 'u1')");
    expect(db.query("SELECT count(*) AS n FROM members").get()).toEqual({ n: 2 });
  });
});
