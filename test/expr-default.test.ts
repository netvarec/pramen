// SQL-expression column defaults: expr.now()/expr.raw() + defaultTo() carrying an
// ExprDefault, the unquoted DDL rendering, and the migrator's additive table-rebuild
// fallback (SQLite forbids ALTER ADD COLUMN with a non-constant default).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, defaultTo, expr, ExprDefault, type FieldBuilders } from "../packages/server/src/sdk/schema";
import { createTableSql } from "../packages/server/src/runtime/ddl";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

let t!: FieldBuilders;
Entity((b) => ((t = b), { id: b.textId() }));

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

describe("expr defaults", () => {
  test("expr.now() / expr.raw() produce ExprDefault sql", () => {
    expect(expr.now()).toBeInstanceOf(ExprDefault);
    expect(expr.now().sql).toBe("datetime('now')");
    expect(expr.raw("strftime('%s','now')").sql).toBe("strftime('%s','now')");
  });

  test("defaultTo(field, expr.*) sets defaultExpr; a literal still sets default", () => {
    expect(defaultTo(t.text(), expr.now())).toEqual({ type: "text", defaultExpr: "datetime('now')" });
    expect(defaultTo(t.text(), "pending")).toEqual({ type: "text", default: "pending" });
  });

  test("DDL emits defaultExpr UNQUOTED and a literal default quoted", () => {
    const sql = createTableSql("events", {
      fields: { id: t.id(), at: defaultTo(t.text(), expr.now()), status: defaultTo(t.text(), "new") },
    });
    expect(sql).toContain("DEFAULT (datetime('now'))"); // parenthesized, unquoted
    expect(sql).toContain("DEFAULT 'new'"); // literal stays quoted
    expect(sql).not.toContain("DEFAULT 'datetime('now')'");
  });
});

describe("migrate — expr default", () => {
  test("CREATE TABLE: an omitted expr-default column is filled by the DB", async () => {
    const db = new Database(":memory:");
    await migrate(bunSqliteDriver(db), defineSchema({ events: Entity((b) => ({ id: b.id(), at: defaultTo(b.text(), expr.now()) })) }));
    db.run("INSERT INTO events (id) VALUES (1)");
    const row = db.query("SELECT at FROM events WHERE id = 1").get() as { at: string };
    expect(row.at).toMatch(DATETIME_RE);
  });

  test("ADD COLUMN with an expr default rebuilds (additive, ungated) and backfills existing rows", async () => {
    const db = new Database(":memory:");
    const d = bunSqliteDriver(db);
    // v1: no `at` column; seed a row.
    await migrate(d, defineSchema({ events: Entity((b) => ({ id: b.id(), kind: b.text() })) }));
    db.run("INSERT INTO events (kind) VALUES ('signup')");
    // v2: add an expr-default column. NOTE: allowDestructive is NOT set — the rebuild
    // is additive, so it must still apply.
    const r = await migrate(d, defineSchema({ events: Entity((b) => ({ id: b.id(), kind: b.text(), at: defaultTo(b.text(), expr.now()) })) }));
    expect(r.rebuilt).toContain("events");
    expect(r.skipped).toEqual([]);
    const row = db.query("SELECT kind, at FROM events").get() as { kind: string; at: string };
    expect(row.kind).toBe("signup"); // existing data preserved
    expect(row.at).toMatch(DATETIME_RE); // existing row backfilled with the default
  });
});
