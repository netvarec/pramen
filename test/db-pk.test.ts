// Unit test for the Db read/write engine against entities whose PRIMARY KEY is not
// named "id". update()/delete()/belongsTo-load must resolve the real PK via pkOf(),
// not a hardcoded "id" (the bug that broke @pramen/auth's auth_users, PK = username).
// Also pins hidden() column stripping on every read path, including SYSTEM scope.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, hidden } from "../packages/server/src/sdk/schema";
import { allow, policy, role, type Identity } from "../packages/server/src/sdk/acl";
import { compileAcl, type AclContext } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

// orgs.slug is the PK (textId, not "id"); members.org is a belongsTo into orgs.
const schema = defineSchema({
  orgs: Entity((t) => ({ slug: t.textId(), name: t.text(), secret: hidden(t.text()) })),
  members: Entity(
    (t) => ({ id: t.textId(), orgSlug: t.text() }),
    (r) => ({ org: r.belongsTo("orgs", "orgSlug") }),
  ),
});

const roles = [
  role("admin", [
    policy("a:orgs:read", "orgs", "read", allow()),
    policy("a:orgs:create", "orgs", "create", allow()),
    policy("a:orgs:update", "orgs", "update", allow()),
    policy("a:orgs:delete", "orgs", "delete", allow()),
    policy("a:members:read", "members", "read", allow()),
    policy("a:members:create", "members", "create", allow()),
  ]),
];
const admin: Identity = { userId: "admin", roles: ["admin"] };

function adminDb(driver: ReturnType<typeof bunSqliteDriver>): Db {
  const ctx: AclContext = { acl: compileAcl(roles), identity: admin, schema, partition: undefined };
  return new Db(driver, ctx, schema);
}

async function freshDb() {
  const sqlite = new Database(":memory:");
  const driver = bunSqliteDriver(sqlite);
  await migrate(driver, schema);
  return { driver, db: adminDb(driver) };
}

describe("Db: non-`id` primary keys + hidden columns", () => {
  test("update / delete resolve a non-`id` PK; belongsTo loads via the target PK", async () => {
    const { db } = await freshDb();
    await db.insert("orgs", { slug: "acme", name: "Acme", secret: "s3cr3t" });
    await db.insert("members", { id: "m1", orgSlug: "acme" });

    // update by the real PK (slug) — previously generated `WHERE id = ?` -> no such column
    const updated = await db.update("orgs", "acme", { name: "Acme Inc" });
    expect(updated?.name).toBe("Acme Inc");

    // belongsTo eager-load resolves members.orgSlug -> orgs.slug (target PK = slug)
    const withOrg = (await db.find({ from: "members", with: { org: true } })) as Array<Record<string, any>>;
    expect(withOrg[0].org?.slug).toBe("acme");
    expect(withOrg[0].org?.name).toBe("Acme Inc");

    // delete by the real PK
    expect(await db.delete("orgs", "acme")).toBe(true);
    expect(await db.find({ from: "orgs" })).toHaveLength(0);
  });

  test("hidden columns are never projected, even under full allow() and SYSTEM reads", async () => {
    const { driver, db } = await freshDb();
    await db.insert("orgs", { slug: "acme", name: "Acme", secret: "s3cr3t" });

    const rows = (await db.find({ from: "orgs" })) as Array<Record<string, unknown>>;
    expect(rows[0].name).toBe("Acme");
    expect("secret" in rows[0]).toBe(false); // stripped despite admin's allow() (full read)

    const sysDb = new Db(driver, { acl: compileAcl(roles), identity: null, schema, system: true }, schema);
    const sysRows = (await sysDb.find({ from: "orgs" })) as Array<Record<string, unknown>>;
    expect("secret" in sysRows[0]).toBe(false); // stripped even under SYSTEM scope

    // ...but a hidden column is still writable, and visible to raw exec (the escape hatch).
    const raw = (await db.exec("SELECT secret FROM orgs WHERE slug = 'acme'")) as Array<Record<string, unknown>>;
    expect(raw[0].secret).toBe("s3cr3t");
  });
});
