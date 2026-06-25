// Reserved-word identifiers (`order`, `group`, `select`) must be quoted everywhere the
// engine emits SQL — DDL (CREATE TABLE, the UNIQUE INDEX), every read/write/where/orderBy,
// and the destructive table-rebuild's INSERT…SELECT. Before quoting, a column named
// `order` broke the migration outright; this pins it end-to-end on real SQLite.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, unique, defaultTo, expr } from "../packages/server/src/sdk/schema";
import { allow, policy, role, type Identity } from "../packages/server/src/sdk/acl";
import { compileAcl, type AclContext } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = defineSchema({
  items: Entity((t) => ({
    id: t.id(),
    order: t.int(), // reserved word as a plain column
    group: unique(t.text()), // reserved word that is ALSO a UNIQUE INDEX (index DDL)
    select: t.text(), // another reserved word
  })),
});

const roles = [
  role("admin", [
    policy("a:read", "items", "read", allow()),
    policy("a:create", "items", "create", allow()),
    policy("a:update", "items", "update", allow()),
    policy("a:delete", "items", "delete", allow()),
  ]),
];
const admin: Identity = { userId: "a", roles: ["admin"] };

function adminDb(driver: ReturnType<typeof bunSqliteDriver>, s = schema): Db {
  const ctx: AclContext = { acl: compileAcl(roles), identity: admin, schema: s, partition: undefined };
  return new Db(driver, ctx, s);
}

describe("reserved-word identifiers are quoted end-to-end", () => {
  test("migrate (CREATE TABLE + UNIQUE INDEX), insert, where, orderBy, update, delete on `order`/`group`/`select`", async () => {
    const sqlite = new Database(":memory:");
    const driver = bunSqliteDriver(sqlite);
    await migrate(driver, schema); // would throw "near \"order\": syntax error" before quoting
    const db = adminDb(driver);

    await db.insert("items", { id: 1, order: 2, group: "a", select: "x" });
    await db.insert("items", { id: 2, order: 1, group: "b", select: "y" });

    // where on a reserved column
    const byOrder = (await db.find({ from: "items", where: { order: 1 } })) as Array<Record<string, unknown>>;
    expect(byOrder).toHaveLength(1);
    expect(byOrder[0].id).toBe(2);

    // orderBy a reserved column
    const sorted = (await db.find({ from: "items", orderBy: { column: "order", dir: "asc" } })) as Array<Record<string, unknown>>;
    expect(sorted.map((r) => r.order)).toEqual([1, 2]);

    // update a reserved column by PK
    const updated = (await db.update("items", 2, { order: 9, select: "z" })) as Record<string, unknown>;
    expect(updated.order).toBe(9);

    // the UNIQUE INDEX on `group` is real (duplicate rejected)
    await expect(db.insert("items", { id: 3, order: 0, group: "a", select: "dup" })).rejects.toThrow();

    // delete by PK
    expect(await db.delete("items", 1)).toBe(true);
    expect(await db.find({ from: "items" })).toHaveLength(1);
  });

  test("the destructive table-rebuild copies reserved columns (INSERT…SELECT is quoted)", async () => {
    const sqlite = new Database(":memory:");
    const driver = bunSqliteDriver(sqlite);
    await migrate(driver, schema);
    await adminDb(driver).insert("items", { id: 1, order: 7, group: "g", select: "s" });

    // Adding an expr-default column forces a table rebuild (create temp, copy, swap) —
    // its INSERT…SELECT names every reserved column. Additive, so ungated.
    const v2 = defineSchema({
      items: Entity((t) => ({
        id: t.id(),
        order: t.int(),
        group: unique(t.text()),
        select: t.text(),
        createdAt: defaultTo(t.text(), expr.now()),
      })),
    });
    const report = await migrate(driver, v2);
    expect(report.rebuilt).toContain("items");

    const rows = (await adminDb(driver, v2).find({ from: "items" })) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ id: 1, order: 7, group: "g", select: "s" });
    expect(typeof rows[0].createdAt).toBe("string"); // backfilled by the DB default
  });
});
