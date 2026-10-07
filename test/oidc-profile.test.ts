// The OIDC profile: what the provider says about the person (`name`, `picture`), stored on the
// user's row at every sign-in and handed back by `me`.
//
// Against a real migrated table rather than the stubbed privileged call the callback tests in
// `oidc.test.ts` use: the point here is the column (that an existing table gains it, that a
// sign-in writes and rewrites it, that `me` reads it back), which a stub cannot show.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema } from "../packages/server/src/sdk/schema";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";
import { authHandlers, authSchema, authPolicies, createAuthHandlers, userHandlers, parseProfile } from "../packages/auth/src/index";
import { role } from "../packages/server/src/sdk/acl";
import { defaultOidcProfile, oidcHandlers, OIDC_UPSERT_HANDLER } from "../packages/auth/src/oidc";
import { Entity } from "../packages/server/src/sdk/schema";

const schema = defineSchema({ ...authSchema });

async function harness() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const db = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
  const ctx = (identity: { userId: string; roles?: string[] } | null = null) => ({ db, env: {}, identity }) as never;
  const upsert = (input: Record<string, unknown>) =>
    (oidcHandlers[OIDC_UPSERT_HANDLER] as { run: (c: unknown, i: unknown) => Promise<unknown> }).run(ctx(), {
      table: "auth_users",
      email: "ada@acme.com",
      roles: null,
      defaultRoles: ["user"],
      ...input,
    });
  const me = (identity: { userId: string; roles?: string[] } | null) =>
    (authHandlers.me as { run: (c: unknown, i: unknown) => Promise<unknown> }).run(ctx(identity), {});
  const rawProfile = async (username: string) =>
    ((await driver.exec("SELECT profile FROM auth_users WHERE username = ?", [username])) as { profile: unknown }[])[0]?.profile;
  return { driver, upsert, me, rawProfile };
}

describe("defaultOidcProfile", () => {
  test("takes the standard name and picture claims", () => {
    expect(defaultOidcProfile({ sub: "1", name: "Ada Lovelace", picture: "https://idp.example.com/a.svg?v=2" })).toEqual({
      name: "Ada Lovelace",
      picture: "https://idp.example.com/a.svg?v=2",
    });
  });

  test("a picture that is not an absolute https URL is dropped, it goes straight into <img src>", () => {
    for (const picture of ["/api/v1/user/1/avatar.svg", "http://idp.example.com/a.png", "javascript:alert(1)", "data:image/svg+xml,<svg/>", 42]) {
      expect(defaultOidcProfile({ name: "Ada", picture } as never)).toEqual({ name: "Ada" });
    }
  });

  test("neither claim is null, so a provider that stops sending them clears the stored value", () => {
    expect(defaultOidcProfile({ sub: "1", email: "ada@acme.com" })).toBeNull();
    expect(defaultOidcProfile({ name: "   ", picture: null } as never)).toBeNull();
  });
});

describe("the profile column", () => {
  test("an existing users table without it gains it on migrate, rows intact", async () => {
    const driver = bunSqliteDriver(new Database(":memory:"));
    // The table as a deployment before this change has it: the same entity minus `profile`.
    const before = defineSchema({
      auth_users: Entity((t) => ({
        username: t.textId(),
        passwordHash: t.text(),
        roles: t.json(),
        email: t.text(),
        emailVerified: t.int(),
        active: t.bool(),
        createdAt: t.int(),
      })),
    });
    await migrate(driver, before);
    await driver.exec("INSERT INTO auth_users (username, passwordHash, roles, email, active, createdAt) VALUES ('ada', '', '[\"user\"]', 'ada@acme.com', 1, 1)", []);

    await migrate(driver, schema);
    const [row] = (await driver.exec("SELECT username, profile FROM auth_users", [])) as { username: string; profile: unknown }[];
    expect(row).toEqual({ username: "ada", profile: null });
  });
});

describe("the upsert stores the profile at every sign-in", () => {
  test("a first sign-in writes it", async () => {
    const h = await harness();
    await h.upsert({ username: "ada@acme.com", profile: { name: "Ada", picture: "https://idp.example.com/a.svg" } });
    expect(parseProfile(await h.rawProfile("ada@acme.com"))).toEqual({ name: "Ada", picture: "https://idp.example.com/a.svg" });
  });

  test("a returning sign-in overwrites it, and null clears it", async () => {
    const h = await harness();
    await h.upsert({ username: "ada@acme.com", profile: { name: "Ada" } });
    await h.upsert({ username: "ada@acme.com", profile: { name: "Ada Lovelace", picture: "https://idp.example.com/b.svg" } });
    expect(parseProfile(await h.rawProfile("ada@acme.com"))).toEqual({ name: "Ada Lovelace", picture: "https://idp.example.com/b.svg" });
    await h.upsert({ username: "ada@acme.com", profile: null });
    expect(await h.rawProfile("ada@acme.com")).toBeNull();
  });

  test("an input without the key (an older caller) clears it rather than failing", async () => {
    const h = await harness();
    await h.upsert({ username: "ada@acme.com", profile: { name: "Ada" } });
    await h.upsert({ username: "ada@acme.com" });
    expect(await h.rawProfile("ada@acme.com")).toBeNull();
  });
});

describe("me", () => {
  test("a custom table is used throughout auth, even with a matching default-table username", async () => {
    const schema = defineSchema({ ...authSchema, members: authSchema.auth_users });
    const driver = bunSqliteDriver(new Database(":memory:"));
    await migrate(driver, schema);
    const db = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
    const ctx = { db, env: { AUTH_SECRET: "test-secret-for-custom-table" }, identity: { userId: "ada", roles: ["user"], usersTable: "members" } } as never;
    const handlers = createAuthHandlers({ table: "members" });
    await handlers.signup.run(ctx, { username: "ada", password: "password123", email: "ada@acme.com" });
    await driver.exec("INSERT INTO auth_users (username, profile) VALUES (?, ?)", ["ada", JSON.stringify({ name: "Wrong Ada" })]);
    await oidcHandlers[OIDC_UPSERT_HANDLER]!.run(ctx, {
      table: "members", username: "ada", email: "ada@acme.com", roles: ["editor"], defaultRoles: ["user"], profile: { name: "Ada" },
    });
    expect(await handlers.me.run(ctx, {})).toMatchObject({ profile: { name: "Ada" } });
    expect(await handlers.login.run(ctx, { username: "ada", password: "password123" })).toMatchObject({ user: { username: "ada", roles: ["editor"] } });
    expect(await handlers.refreshSession.run(ctx, {})).toMatchObject({ user: { username: "ada", roles: ["editor"] } });
    await driver.exec("DELETE FROM members WHERE username = ?", ["ada"]);
    expect(await handlers.me.run(ctx, {})).toMatchObject({ profile: null });
  });

  test("a custom table identifier is validated at construction", () => {
    expect(() => createAuthHandlers({ table: "members; DROP TABLE auth_users" })).toThrow("invalid table name");
  });

  test("returns the identity plus the stored profile", async () => {
    const h = await harness();
    await h.upsert({ username: "ada@acme.com", profile: { name: "Ada", picture: "https://idp.example.com/a.svg" } });
    expect(await h.me({ userId: "ada@acme.com", roles: ["user"] })).toEqual({
      userId: "ada@acme.com",
      roles: ["user"],
      profile: { name: "Ada", picture: "https://idp.example.com/a.svg" },
    });
  });

  test("a user without one gets profile: null, with the identity's fields unchanged", async () => {
    const h = await harness();
    await h.upsert({ username: "ada@acme.com", profile: null });
    expect(await h.me({ userId: "ada@acme.com", roles: ["user"] })).toEqual({ userId: "ada@acme.com", roles: ["user"], profile: null });
    // An identity with no row at all (an external JWT): still the identity, still no profile.
    expect(await h.me({ userId: "nobody", roles: ["user"] })).toEqual({ userId: "nobody", roles: ["user"], profile: null });
  });

  test("anonymous is exactly what it was", async () => {
    const h = await harness();
    expect(await h.me(null)).toBeNull();
  });

  test("a deployment without the users table still gets its identity back", async () => {
    const driver = bunSqliteDriver(new Database(":memory:"));
    const empty = defineSchema({});
    await migrate(driver, empty);
    const db = new Db(driver, { acl: compileAcl([]), identity: null, schema: empty, system: true }, empty);
    const res = await (authHandlers.me as { run: (c: unknown, i: unknown) => Promise<unknown> }).run({ db, env: {}, identity: { userId: "ext", roles: ["user"] } }, {});
    expect(res).toEqual({ userId: "ext", roles: ["user"], profile: null });
  });
});

test("the default admin policy exposes profiles through listUsers without exposing password hashes", async () => {
  const h = await harness();
  await h.upsert({ username: "ada", profile: { name: "Ada" } });
  const identity = { userId: "admin", roles: ["admin"] };
  const db = new Db(h.driver, { acl: compileAcl([role("admin", authPolicies().admin)]), identity, schema }, schema);
  const rows = await userHandlers.listUsers.run({ db, identity } as never, {});
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ username: "ada", profile: { name: "Ada" } });
  expect(rows[0]).not.toHaveProperty("passwordHash");
});
