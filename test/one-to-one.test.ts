// One-to-one: oneHasOne (owning, holds the FK) + oneHasOneInverse (the reverse). `with`
// loads a single object (or null) on both sides, `where` traverses both ways, a unique on
// the FK column enforces the 1:1, and onDelete cascade removes the dependent row.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, unique } from "../packages/server/src/sdk/schema";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = defineSchema({
  users: Entity(
    (t) => ({ id: t.id(), name: t.text() }),
    (r) => ({ profile: r.oneHasOneInverse("profiles", "userId") }),
  ),
  profiles: Entity(
    (t) => ({ id: t.id(), userId: unique(t.int()), bio: t.text() }),
    (r) => ({ user: r.oneHasOne("users", "userId", { onDelete: "cascade" }) }),
  ),
});

async function seed() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const sys = () => new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
  const u1 = (await sys().insert("users", { name: "Alice" })).id as number;
  const u2 = (await sys().insert("users", { name: "Bob" })).id as number;
  await sys().insert("profiles", { userId: u1, bio: "hi from alice" });
  return { driver, sys, u1, u2 };
}

describe("one-to-one", () => {
  test("with: owning + inverse each load a single object (or null)", async () => {
    const { sys, u1, u2 } = await seed();
    const users = (await sys().find({ from: "users", with: { profile: true }, orderBy: [{ column: "id" }] })) as any[];
    expect(users.find((u) => u.id === u1).profile.bio).toBe("hi from alice");
    expect(users.find((u) => u.id === u2).profile).toBe(null); // Bob has none
    const profiles = (await sys().find({ from: "profiles", with: { user: true } })) as any[];
    expect(profiles[0].user.name).toBe("Alice");
  });

  test("where: traverses the 1:1 both ways", async () => {
    const { sys } = await seed();
    const byBio = (await sys().find({ from: "users", where: { profile: { bio: "hi from alice" } } })) as any[];
    expect(byBio.map((u) => u.name)).toEqual(["Alice"]);
    const byName = (await sys().find({ from: "profiles", where: { user: { name: "Alice" } } })) as any[];
    expect(byName).toHaveLength(1);
  });

  test("unique on the FK column enforces the 1:1", async () => {
    const { sys, u1 } = await seed();
    await expect(sys().insert("profiles", { userId: u1, bio: "second" })).rejects.toThrow();
  });

  test("onDelete cascade: deleting the owner removes the dependent row", async () => {
    const { sys, u1 } = await seed();
    await sys().delete("users", u1);
    expect((await sys().find({ from: "profiles", where: {} })) as any[]).toHaveLength(0);
  });
});
