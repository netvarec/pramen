// Unit test for declarative write-triggers: the Db write path enqueues a task per
// matching trigger (atomic with the write), with field-level filtering on updates.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, trigger } from "../packages/server/src/sdk/schema";
import { allow, policy, role, type Identity } from "../packages/server/src/sdk/acl";
import { compileAcl, type AclContext } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { ensureOutbox } from "../packages/server/src/runtime/outbox";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = defineSchema({
  items: Entity((t) => ({ id: t.textId(), name: t.text(), status: t.text() }), undefined, {
    triggers: [
      trigger({ task: "on-create", on: { create: true } }),
      trigger({ task: "on-status", on: { update: ["status"] } }), // fire only on status writes
      trigger({ task: "on-gone", on: { delete: true } }),
    ],
  }),
});

const roles = [
  role("admin", [
    policy("a:r", "items", "read", allow()),
    policy("a:c", "items", "create", allow()),
    policy("a:u", "items", "update", allow()),
    policy("a:d", "items", "delete", allow()),
  ]),
];
const admin: Identity = { userId: "admin", roles: ["admin"] };

async function freshDb() {
  const sqlite = new Database(":memory:");
  const driver = bunSqliteDriver(sqlite);
  await migrate(driver, schema);
  await ensureOutbox(driver);
  const ctx: AclContext = { acl: compileAcl(roles), identity: admin, schema, partition: undefined };
  return { driver, db: new Db(driver, ctx, schema) };
}

const outbox = (driver: ReturnType<typeof bunSqliteDriver>) =>
  driver
    .exec("SELECT kind, payload FROM _pramen_outbox ORDER BY createdAt", [])
    .then((rows) => rows.map((r) => ({ kind: String(r.kind), payload: JSON.parse(String(r.payload)) })));

describe("declarative write-triggers", () => {
  test("create fires the create trigger with { entity, op, id, row }", async () => {
    const { driver, db } = await freshDb();
    await db.insert("items", { id: "a", name: "Apple", status: "draft" });
    const rows = await outbox(driver);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("on-create");
    expect(rows[0].payload).toMatchObject({ entity: "items", op: "create", id: "a", row: { name: "Apple", status: "draft" } });
    expect(db.taskEnqueues).toBe(1);
  });

  test("update fires only when a watched column is written (field filter)", async () => {
    const { driver, db } = await freshDb();
    await db.insert("items", { id: "a", name: "Apple", status: "draft" }); // 1 (on-create)
    await db.update("items", "a", { status: "published" }); // fires on-status
    await db.update("items", "a", { name: "Apricot" }); // does NOT fire (status not written)
    const fired = (await outbox(driver)).map((r) => r.kind);
    expect(fired).toEqual(["on-create", "on-status"]);
  });

  test("delete fires the delete trigger with the removed row", async () => {
    const { driver, db } = await freshDb();
    await db.insert("items", { id: "a", name: "Apple", status: "draft" });
    await db.delete("items", "a");
    const last = (await outbox(driver)).at(-1)!;
    expect(last.kind).toBe("on-gone");
    expect(last.payload).toMatchObject({ op: "delete", id: "a", row: { name: "Apple" } });
  });

  test("an entity without triggers enqueues nothing", async () => {
    const plain = defineSchema({ items: Entity((t) => ({ id: t.textId(), name: t.text() })) });
    const sqlite = new Database(":memory:");
    const driver = bunSqliteDriver(sqlite);
    await migrate(driver, plain);
    await ensureOutbox(driver);
    const ctx: AclContext = { acl: compileAcl(roles), identity: admin, schema: plain, partition: undefined };
    const db = new Db(driver, ctx, plain);
    await db.insert("items", { id: "a", name: "Apple" });
    expect((await outbox(driver)).length).toBe(0);
    expect(db.taskEnqueues).toBe(0);
  });
});
