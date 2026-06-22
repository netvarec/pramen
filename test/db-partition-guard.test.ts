// Unit test for the Db table-access guard (runtime/db.ts). When the AclContext carries
// an active partition (a partition-DO knows which partition it serves), every Db entry
// point rejects any access to a table that lives in a DIFFERENT partition — a partition
// DO only owns its own tables. When the partition is unset (the D1/Worker shared-store
// path, or a single-partition default DO with no header), the guard is a NO-OP.
//
// The full e2e suite (booting wrangler) is the real gate for the default routing path
// staying intact; this pins the guard + its error without a Worker.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema } from "../packages/server/src/sdk/schema";
import { allow, policy, role, type Identity } from "../packages/server/src/sdk/acl";
import { compileAcl, type AclContext } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = defineSchema({
  notes: Entity((t) => ({ id: t.textId(), title: t.text() })),
  audits: Entity((t) => ({ id: t.textId(), action: t.text() }), undefined, { partition: "audit" }),
});

const roles = [
  role("admin", [
    policy("admin:notes:read", "notes", "read", allow()),
    policy("admin:notes:create", "notes", "create", allow()),
    policy("admin:audits:read", "audits", "read", allow()),
    policy("admin:audits:create", "audits", "create", allow()),
  ]),
];

const admin: Identity = { userId: "admin", roles: ["admin"] };

function ctx(partition: string | undefined): AclContext {
  return { acl: compileAcl(roles), identity: admin, schema, partition };
}

async function driverWithBothPartitions() {
  const db = new Database(":memory:");
  const driver = bunSqliteDriver(db);
  // Both partitions' tables exist in this one store (so the only thing under test is
  // the in-Db guard, not whether the table physically exists).
  await migrate(driver, schema, { partition: "default" });
  await migrate(driver, schema, { partition: "audit" });
  return driver;
}

describe("Db partition guard", () => {
  test("default partition: own table allowed, foreign table rejected", async () => {
    const driver = await driverWithBothPartitions();
    const db = new Db(driver, ctx("default"), schema);

    // Own-partition table works.
    await db.insert("notes", { id: "n1", title: "hi" });
    expect(await db.count({ from: "notes" })).toBe(1);

    // Foreign-partition table is rejected with a BadRequest (status 400) naming both partitions.
    await expect(db.find({ from: "audits" })).rejects.toMatchObject({
      status: 400,
      message: "table 'audits' is in partition 'audit', not this partition 'default'",
    });
  });

  test("audit partition: own table allowed, default table rejected", async () => {
    const driver = await driverWithBothPartitions();
    const db = new Db(driver, ctx("audit"), schema);

    await db.insert("audits", { id: "a1", action: "login" });
    expect(await db.count({ from: "audits" })).toBe(1);

    await expect(db.find({ from: "notes" })).rejects.toMatchObject({
      status: 400,
      message: "table 'notes' is in partition 'default', not this partition 'audit'",
    });
  });

  test("guard covers every entry point (find/page/count/aggregate/insert/update/delete)", async () => {
    const driver = await driverWithBothPartitions();
    const db = new Db(driver, ctx("default"), schema); // foreign = audits
    const foreign = "table 'audits' is in partition 'audit', not this partition 'default'";

    await expect(db.find({ from: "audits" })).rejects.toMatchObject({ message: foreign });
    await expect(db.page({ from: "audits" })).rejects.toMatchObject({ message: foreign });
    await expect(db.count({ from: "audits" })).rejects.toMatchObject({ message: foreign });
    await expect(
      db.aggregate({ from: "audits", aggregations: { n: { fn: "count" } } }),
    ).rejects.toMatchObject({ message: foreign });
    await expect(db.insert("audits", { id: "x", action: "y" })).rejects.toMatchObject({ message: foreign });
    await expect(db.update("audits", "x", { action: "z" })).rejects.toMatchObject({ message: foreign });
    await expect(db.delete("audits", "x")).rejects.toMatchObject({ message: foreign });
  });

  test("unset partition is a no-op (D1/shared-store path): every table accessible", async () => {
    const driver = await driverWithBothPartitions();
    const db = new Db(driver, ctx(undefined), schema);

    // Both tables work — no guard.
    await db.insert("notes", { id: "n1", title: "hi" });
    await db.insert("audits", { id: "a1", action: "login" });
    expect(await db.count({ from: "notes" })).toBe(1);
    expect(await db.count({ from: "audits" })).toBe(1);
  });
});
