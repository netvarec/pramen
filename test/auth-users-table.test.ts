// A custom users table, end to end: every `@pramen/auth` factory reads and writes the table it
// is given, quotes it, and stamps sessions with it so another table's handlers refuse them.
//
// The quoting cases use a table named `group`, an SQL keyword: before the shared helper only
// `createAuthHandlers` quoted the name, so signup worked and `listUsers`/`changePassword`/
// `resetPassword` died on a syntax error.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema } from "../packages/server/src/sdk/schema";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";
import type { HandlerContext, JsonValue } from "@pramen/server";
import {
  authHandlers,
  authSchema,
  createAuthHandlers,
  createMagicLinkAuth,
  createPasswordReset,
  createUserHandlers,
  emailTokenSchema,
  magicLinkSchema,
} from "../packages/auth/src/index";

const SECRET = "test-secret-for-users-table";

type Run = { run: (c: unknown, i: unknown) => Promise<unknown> };
const run = (h: unknown, ctx: unknown, input: unknown = {}) => (h as Run).run(ctx, input) as Promise<Record<string, unknown>>;

/** The claims of a session token (no verification: the handlers under test minted it). */
function claims(token: unknown): Record<string, unknown> {
  const body = String(token).split(".")[1]!;
  return JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

async function harness(table: string) {
  const schema = defineSchema({ ...authSchema, ...emailTokenSchema, ...magicLinkSchema, [table]: authSchema.auth_users });
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const db = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
  const enqueued: { kind: string; payload: JsonValue }[] = [];
  const ctx = (identity: Record<string, unknown> | null = null) =>
    ({ db, env: { AUTH_SECRET: SECRET }, identity, tasks: { enqueue: async (t: { kind: string; payload: JsonValue }) => void enqueued.push(t) } }) as never;
  const rowsOf = async (t: string) => (await driver.exec(`SELECT username FROM "${t}"`, [])) as { username: string }[];
  return { ctx, enqueued, rowsOf };
}

describe("magic link over a custom table", () => {
  test("inviteUser, loginWithMagicLink and refreshSession use the table and stamp the session", async () => {
    const h = await harness("members");
    const sent: { email: string; token: string }[] = [];
    const magic = createMagicLinkAuth({ table: "members", sendEmail: (_c, a) => void sent.push(a) });

    expect(await run(magic.handlers.inviteUser, h.ctx({ userId: "admin", roles: ["admin"] }), { email: "ada@acme.com", roles: ["editor"] })).toMatchObject({ created: true });
    expect(await h.rowsOf("members")).toEqual([{ username: "ada@acme.com" }]);
    expect(await h.rowsOf("auth_users")).toEqual([]);

    const task = h.enqueued.find((t) => t.kind === "sendMagicLinkEmail")!;
    await magic.tasks.sendMagicLinkEmail!(h.ctx() as HandlerContext, task.payload, { id: "t", attempts: 1 });
    const login = await run(magic.handlers.loginWithMagicLink, h.ctx(), { token: sent[0]!.token });
    expect(login.user).toEqual({ username: "ada@acme.com", roles: ["editor"] });
    expect(claims(login.token)).toMatchObject({ sub: "ada@acme.com", usersTable: "members" });

    const refreshed = await run(magic.handlers.refreshSession, h.ctx({ userId: "ada@acme.com", roles: ["editor"], usersTable: "members" }));
    expect(refreshed.user).toEqual({ username: "ada@acme.com", roles: ["editor"] });
  });

  test("a default-table magic link mints no table claim", async () => {
    const h = await harness("members");
    const sent: { email: string; token: string }[] = [];
    const magic = createMagicLinkAuth({ sendEmail: (_c, a) => void sent.push(a) });
    await run(magic.handlers.requestMagicLink, h.ctx(), { email: "bob@acme.com" });
    await magic.tasks.sendMagicLinkEmail!(h.ctx() as HandlerContext, h.enqueued[0]!.payload, { id: "t", attempts: 1 });
    const login = await run(magic.handlers.loginWithMagicLink, h.ctx(), { token: sent[0]!.token });
    expect(claims(login.token)).not.toHaveProperty("usersTable");
    expect(await h.rowsOf("auth_users")).toEqual([{ username: "bob@acme.com" }]);
  });
});

describe("a session is honored only by its own table's handlers", () => {
  test("refreshSession refuses a session from another table that shares the username", async () => {
    const h = await harness("members");
    const members = createAuthHandlers({ table: "members" });
    await run(authHandlers.signup, h.ctx(), { username: "ada", password: "password123" });
    const login = await run(members.signup, h.ctx(), { username: "ada", password: "password123" });
    expect(claims(login.token)).toMatchObject({ usersTable: "members" });

    // An `auth_users` session (no claim) at the members handler, and the reverse.
    await expect(run(members.refreshSession, h.ctx({ userId: "ada", roles: ["user"] }))).rejects.toThrow("session is no longer valid");
    await expect(run(authHandlers.refreshSession, h.ctx({ userId: "ada", roles: ["user"], usersTable: "members" }))).rejects.toThrow("session is no longer valid");
    expect(await run(members.refreshSession, h.ctx({ userId: "ada", roles: ["user"], usersTable: "members" }))).toMatchObject({ user: { username: "ada" } });
  });

  test("me reads no profile across tables", async () => {
    const h = await harness("members");
    const members = createAuthHandlers({ table: "members" });
    await run(authHandlers.signup, h.ctx(), { username: "ada", password: "password123" });
    expect(await run(members.me, h.ctx({ userId: "ada", roles: ["user"] }))).toMatchObject({ userId: "ada", profile: null });
  });
});

describe("a table named with an SQL keyword", () => {
  test("signup, listUsers, changePassword and the password reset all work", async () => {
    const h = await harness("group");
    const auth = createAuthHandlers({ table: "group" });
    const users = createUserHandlers({ table: "group" });
    const sent: { email: string; token: string }[] = [];
    const reset = createPasswordReset({ table: "group", sendEmail: (_c, a) => void sent.push(a) });

    await run(auth.signup, h.ctx(), { username: "ada", password: "password123", email: "ada@acme.com" });
    expect(await run(users.listUsers, h.ctx({ userId: "admin", roles: ["admin"] }))).toMatchObject([{ username: "ada" }]);
    await run(users.changePassword, h.ctx({ userId: "ada", roles: ["user"], usersTable: "group" }), { currentPassword: "password123", newPassword: "password456" });

    await run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@acme.com" });
    await reset.tasks.sendPasswordResetEmail!(h.ctx() as HandlerContext, h.enqueued[0]!.payload, { id: "t", attempts: 1 });
    await run(reset.handlers.resetPassword, h.ctx(), { token: sent[0]!.token, newPassword: "password789" });
    expect(await run(auth.login, h.ctx(), { username: "ada", password: "password789" })).toMatchObject({ user: { username: "ada" } });
  });

  test("an invalid name is refused at construction by every factory", () => {
    const table = "members; DROP TABLE auth_users";
    const sendEmail = () => {};
    expect(() => createAuthHandlers({ table })).toThrow("invalid table name");
    expect(() => createUserHandlers({ table })).toThrow("invalid table name");
    expect(() => createMagicLinkAuth({ table, sendEmail })).toThrow("invalid table name");
    expect(() => createPasswordReset({ table, sendEmail })).toThrow("invalid table name");
  });
});
