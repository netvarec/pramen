// Substrate-seam proof: the SAME Db + ACL engine runs over an async, non-DO Driver
// (bun:sqlite standing in for D1). If this passes, "Worker + D1" reuses the entire
// ACL/read/write layer unchanged. Also a compile-only check that the Dialect seam
// produces Postgres-shaped SQL — the remaining piece for a Hyperdrive/Postgres port.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema } from "../src/sdk/schema";
import { $identity, allow, policy, role, type Identity } from "../src/sdk/acl";
import { compileAcl, type AclContext } from "../src/runtime/acl";
import { Db } from "../src/runtime/db";
import { migrate } from "../src/runtime/migrate";
import { compileSelect, eq } from "../src/runtime/read-engine";
import { postgresDialect, sqliteDialect } from "../src/runtime/driver";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = defineSchema({
  notes: Entity((t) => ({ id: t.id(), title: t.text(), body: t.text(), ownerId: t.text() })),
});

const roles = [
  role("admin", [
    policy("admin:read", "notes", "read", allow()),
    policy("admin:create", "notes", "create", allow()),
  ]),
  role("teammate", [
    policy("teammate:read", "notes", "read", {
      fields: ["id", "title", "ownerId"],
      conditionalFields: [{ fields: ["body"], when: { ownerId: $identity("userId") } }],
    }),
  ]),
];

const ctx = (identity: Identity | null): AclContext => ({ acl: compileAcl(roles), identity });

describe("Db + ACL over an async (D1-like) sqlite Driver", () => {
  test("ACL reads/writes and cell-level field visibility run unchanged off-DO", async () => {
    const driver = bunSqliteDriver(new Database(":memory:"));
    await migrate(driver, schema);

    const admin = new Db(driver, ctx({ userId: "admin", roles: ["admin"] }), schema);
    const aliceNote = await admin.insert("notes", { title: "alice-note", body: "alice-secret", ownerId: "alice" });
    const bobNote = await admin.insert("notes", { title: "bob-note", body: "bob-secret", ownerId: "bob" });
    expect(typeof aliceNote.id).toBe("number");

    // teammate "alice": reads every note, but sees `body` only on her own row — the
    // exact cell-level ACL behaviour, now over an async non-DO substrate.
    const team = new Db(driver, ctx({ userId: "alice", roles: ["teammate"] }), schema);
    const rows = await team.find({ from: "notes", orderBy: { column: "id", dir: "asc" } });
    const mine = rows.find((r) => r.id === aliceNote.id) as Record<string, unknown>;
    const other = rows.find((r) => r.id === bobNote.id) as Record<string, unknown>;
    expect(mine.body).toBe("alice-secret");
    expect("body" in other).toBe(false);

    // count is ACL-scoped and async-correct
    expect(await admin.count({ from: "notes" })).toBe(2);
  });
});

describe("Dialect seam", () => {
  test("postgresDialect emits quoted identifiers and $n placeholders", () => {
    const { sql, params } = compileSelect({ from: "notes", where: eq("ownerId", "alice"), limit: 5 }, postgresDialect);
    expect(sql).toContain('"notes"');
    expect(sql).toContain('"ownerId" = $1');
    expect(sql).toContain("LIMIT $2");
    expect(params).toEqual(["alice", 5]);
  });

  test("sqliteDialect emits bare identifiers and ? placeholders", () => {
    const { sql } = compileSelect({ from: "notes", where: eq("ownerId", "alice"), limit: 5 }, sqliteDialect);
    expect(sql).toContain("FROM notes");
    expect(sql).toContain("ownerId = ?");
    expect(sql).toContain("LIMIT ?");
  });
});
