// Security regressions: which sessions stay valid after the account changes.
//
// - pramen/auth:password-reset-does-not-revoke-sessions-refreshSession: a session stolen before
//   a reset/change kept refreshing forever.
// - pramen/auth:denylist-ttl-from-env-not-minting-factory-ttl: the denylist entry was sized from
//   AUTH_SESSION_TTL_SECONDS while the magic-link/OIDC factories minted with their own TTL.
// - pramen/auth:deleted-username-reusable-no-tombstone: a deleted username could be signed up
//   again, inheriting the old owner's rows and (after a reactivation) their sessions.
// - packages/server/src/worker.ts:useD1Store:session-sub-not-bound-to-store (auth half): a
//   session minted on one store's users table was honored by the other's.
// - packages/auth/src/index.ts:verifyPassword:unverifiable-hash-fast-path-timing-oracle.
//
// The Worker half of the credential epoch (rejecting a token whose iat is below the KV
// notBefore entry) is @pramen/server's; here the entry is asserted as WRITTEN, by its value and
// TTL, without depending on its key format.

import { describe, expect, test } from "bun:test";
import {
  authHandlers,
  createAuthHandlers,
  createMagicLinkAuth,
  createPasswordReset,
  createUserHandlers,
  maxSessionTtlOf,
  userHandlers,
  verifyPassword,
} from "../packages/auth/src/index";
import { authSchema } from "../packages/auth/src/index";
import { Entity, defineSchema } from "../packages/server/src/sdk/schema";
import { createOidcAuth } from "../packages/auth/src/oidc";
import { claims, harness, recorder, type Sent } from "./secfix-auth-harness";

const nowS = () => Math.floor(Date.now() / 1000);

async function withReset() {
  const sent: Sent[] = [];
  const reset = createPasswordReset({ sendEmail: recorder(sent, "reset"), resendCooldownSeconds: 0 });
  const h = await harness({ ...reset.tasks });
  await h.run(authHandlers.signup, h.ctx(), { username: "ada", password: "oldpassword", email: "ada@acme.test" });
  // An account a minute old, so a token from "a few seconds ago" postdates the row itself.
  await h.driver.exec("UPDATE auth_users SET createdAt = ? WHERE username = 'ada'", [Date.now() - 60_000]);
  return { h, sent, reset };
}

describe("a credential change retires every earlier session", () => {
  test("resetPassword: a pre-reset token no longer refreshes, a post-reset login does", async () => {
    const { h, sent, reset } = await withReset();
    const stolenIat = nowS() - 5;
    expect(await h.run(authHandlers.refreshSession, h.ctx({ userId: "ada", iat: stolenIat }))).toMatchObject({ user: { username: "ada" } });

    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@acme.test" });
    await h.run(reset.handlers.resetPassword, h.ctx(), { token: sent.at(-1)!.token, newPassword: "newpassword" });

    await expect(h.run(authHandlers.refreshSession, h.ctx({ userId: "ada", iat: stolenIat }))).rejects.toThrow("session is no longer valid");
    const fresh = await h.run<{ token: string }>(authHandlers.login, h.ctx(), { username: "ada", password: "newpassword" });
    const iat = claims(fresh.token).iat as number;
    expect(await h.run(authHandlers.refreshSession, h.ctx({ userId: "ada", iat }))).toMatchObject({ user: { username: "ada" } });
  });

  test("resetPassword writes a notBefore entry for the Worker: at the reset second, outliving every session", async () => {
    const { h, sent, reset } = await withReset();
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@acme.test" });
    const before = nowS();
    await h.run(reset.handlers.resetPassword, h.ctx(), { token: sent.at(-1)!.token, newPassword: "newpassword" });
    const put = h.kvPuts.find((p) => p.key.includes("ada"))!;
    expect(Number(put.value)).toBeGreaterThanOrEqual(before);
    expect(put.expirationTtl).toBeGreaterThanOrEqual(maxSessionTtlOf({}));
  });

  test("changePassword: the caller's old token dies too, so the result carries a fresh one that works", async () => {
    const { h } = await withReset();
    const oldIat = nowS() - 5;
    const res = await h.run<{ token: string }>(userHandlers.changePassword, h.ctx({ userId: "ada", iat: oldIat }), { currentPassword: "oldpassword", newPassword: "newpassword" });
    await expect(h.run(authHandlers.refreshSession, h.ctx({ userId: "ada", iat: oldIat }))).rejects.toThrow("session is no longer valid");
    const c = claims(res.token);
    expect(c.sub).toBe("ada");
    expect(await h.run(authHandlers.refreshSession, h.ctx({ userId: "ada", iat: c.iat }))).toMatchObject({ user: { username: "ada" } });
    expect(h.kvPuts.some((p) => p.key.includes("ada"))).toBe(true);
  });

  test("a token with no iat cannot be placed in time and is refused", async () => {
    const { h } = await withReset();
    await expect(h.run(authHandlers.refreshSession, h.ctx({ userId: "ada", iat: undefined }))).rejects.toThrow("session is no longer valid");
  });
});

describe("one session TTL for minters and revocation", () => {
  test("a factory without its own option mints at AUTH_SESSION_TTL_SECONDS", async () => {
    const sent: Sent[] = [];
    const magic = createMagicLinkAuth({ sendEmail: recorder(sent, "magic"), resendCooldownSeconds: 0 });
    const h = await harness({ ...magic.tasks });
    const env = { AUTH_SESSION_TTL_SECONDS: "600" };
    await h.run(magic.handlers.requestMagicLink, h.ctx(null, { env }), { email: "bob@acme.test" });
    const login = await h.run<{ token: string }>(magic.handlers.loginWithMagicLink, h.ctx(null, { env }), { token: sent[0]!.token });
    const c = claims(login.token);
    expect((c.exp as number) - (c.iat as number)).toBe(600);
  });

  test("the denylist entry outlives the longest token any factory mints, whatever the env says", async () => {
    // Factories declare their TTLs at construction, as they do at module scope in an app.
    createMagicLinkAuth({ sendEmail: () => {}, sessionTtlSeconds: 7200 });
    createOidcAuth({ issuer: "https://idp.test", clientId: "c", redirectUri: "https://a.test/cb", successRedirect: "https://a.test/", sessionTtlSeconds: 5400 });
    const h = await harness();
    await h.run(authHandlers.signup, h.ctx(), { username: "carol", password: "carolpassword" });
    await h.run(userHandlers.setUserActive, h.ctx({ userId: "admin", roles: ["admin"] }, { env: { AUTH_SESSION_TTL_SECONDS: "300" } }), { username: "carol", active: false });
    const deny = h.kvPuts.find((p) => p.key.includes("carol"))!;
    expect(deny.expirationTtl).toBeGreaterThanOrEqual(7200);
  });

  test("an invalid sessionTtlSeconds is refused at construction", () => {
    expect(() => createMagicLinkAuth({ sendEmail: () => {}, sessionTtlSeconds: 0 })).toThrow("sessionTtlSeconds");
  });
});

describe("deleteUser leaves a tombstone", () => {
  const admin = { userId: "admin", roles: ["admin"] };

  test("the username cannot be signed up again, and its email is free for a new account", async () => {
    const { h } = await withReset();
    await h.run(userHandlers.deleteUser, h.ctx(admin), { username: "ada" });
    await expect(h.run(authHandlers.signup, h.ctx(), { username: "ada", password: "squatterpw" })).rejects.toThrow("username is taken");
    const row = await h.raw("ada");
    expect(row).toMatchObject({ active: 0, passwordHash: "", email: null, emailVerified: null });
    expect(await h.run(authHandlers.signup, h.ctx(), { username: "ada2", password: "ada2password", email: "ada@acme.test" })).toMatchObject({ user: { username: "ada2" } });
  });

  test("reactivating the tombstone does not revive a pre-deletion session", async () => {
    const { h } = await withReset();
    const oldIat = nowS() - 5;
    await h.run(userHandlers.deleteUser, h.ctx(admin), { username: "ada" });
    await h.run(userHandlers.setUserActive, h.ctx(admin), { username: "ada", active: true });
    await expect(h.run(authHandlers.refreshSession, h.ctx({ userId: "ada", iat: oldIat }))).rejects.toThrow("session is no longer valid");
    // Nor can that session plant a password in the tombstone's empty slot.
    await expect(h.run(userHandlers.changePassword, h.ctx({ userId: "ada", iat: oldIat }), { currentPassword: "", newPassword: "plantedpw1" })).rejects.toThrow("authentication required");
  });

  test("a row removed outside deleteUser and re-created refuses the earlier incarnation's token", async () => {
    const h = await harness();
    const oldIat = nowS() - 5;
    await h.driver.exec("INSERT INTO auth_users (username, passwordHash, roles, createdAt) VALUES ('dan', '', '[\"user\"]', ?)", [Date.now()]);
    await expect(h.run(authHandlers.refreshSession, h.ctx({ userId: "dan", iat: oldIat }))).rejects.toThrow("session is no longer valid");
    expect(await h.run(authHandlers.refreshSession, h.ctx({ userId: "dan" }))).toMatchObject({ user: { username: "dan" } });
  });
});

describe("a session is bound to the store that minted it", () => {
  test("signup on D1 stamps the store; the DO store's handlers refuse that session, and the reverse", async () => {
    const h = await harness();
    const d1 = await h.run<{ token: string }>(authHandlers.signup, h.ctx(null, { store: "d1" }), { username: "erin", password: "erinpassword" });
    const c = claims(d1.token);
    expect(c.store).toBe("d1");
    const asD1 = { userId: "erin", roles: ["user"], store: "d1", iat: c.iat };
    await expect(h.run(authHandlers.refreshSession, h.ctx(asD1, { store: "do" }))).rejects.toThrow("session is no longer valid");
    await expect(h.run(userHandlers.changeEmail, h.ctx(asD1, { store: "do" }), { email: "erin@acme.test", currentPassword: "erinpassword" })).rejects.toThrow("session is no longer valid");
    // A DO session (no claim) at the D1 store.
    await expect(h.run(authHandlers.refreshSession, h.ctx({ userId: "erin", iat: c.iat }, { store: "d1" }))).rejects.toThrow("session is no longer valid");
    // Its own store keeps working, and the refreshed token keeps the claim.
    const again = await h.run<{ token: string }>(authHandlers.refreshSession, h.ctx(asD1, { store: "d1" }));
    expect(claims(again.token).store).toBe("d1");
  });

  test("a DO session carries no store claim, so tokens minted before the claim keep working", async () => {
    const h = await harness();
    const res = await h.run<{ token: string }>(createAuthHandlers().signup, h.ctx(), { username: "fay", password: "faypassword" });
    expect(claims(res.token)).not.toHaveProperty("store");
    expect(await h.run(authHandlers.refreshSession, h.ctx({ userId: "fay" }))).toMatchObject({ user: { username: "fay" } });
  });

  test("the custom-table claim and the store claim are checked together", async () => {
    const h = await harness({}, {});
    const users = createUserHandlers();
    await h.run(authHandlers.signup, h.ctx(null, { store: "d1" }), { username: "gil", password: "gilpassword" });
    await expect(h.run(users.changePassword, h.ctx({ userId: "gil", store: "d1", usersTable: "members" }, { store: "d1" }), { currentPassword: "gilpassword", newPassword: "gilpassword2" })).rejects.toThrow("session is no longer valid");
  });
});

describe("a failed verification costs one derivation on every path", () => {
  const time = async (fn: () => Promise<unknown>) => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      await fn();
      runs.push(performance.now() - t);
    }
    return runs.sort((a, b) => a - b)[1]!;
  };

  test("an empty, an unknown-scheme and an unparseable hash take as long as a real one", async () => {
    await verifyPassword("warm", await (await import("../packages/auth/src/index")).hashPassword("warm-up-password"));
    const real = await time(() => verifyPassword("wrong", "pbkdf2$sha256$100000$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaA=="));
    for (const stored of ["", "nosuchscheme$payload", "pbkdf2$garbage"]) {
      expect(await verifyPassword("whatever", stored)).toBe(false);
      expect(await time(() => verifyPassword("whatever", stored))).toBeGreaterThan(real * 0.4);
    }
  });

  test("login for a passwordless account answers no faster than for an unknown one", async () => {
    const h = await harness();
    await h.driver.exec("INSERT INTO auth_users (username, passwordHash, roles, createdAt) VALUES ('pl@acme.test', '', '[\"user\"]', ?)", [Date.now()]);
    const attempt = (username: string) => h.run(authHandlers.login, h.ctx(), { username, password: "whatever1" }).catch(() => {});
    await attempt("warm@acme.test");
    const unknown = await time(() => attempt("nobody@acme.test"));
    const passwordless = await time(() => attempt("pl@acme.test"));
    expect(passwordless).toBeGreaterThan(unknown * 0.4);
  });
});

describe("a custom users table must have the auth_users shape", () => {
  const short = {
    members: Entity((t) => ({
      username: t.textId(),
      passwordHash: t.text(),
      roles: t.json(),
      email: t.text(),
      active: t.bool(),
      createdAt: t.int(),
    })),
  };

  test("createUserHandlers({ table, schema }) refuses a table missing a column, naming it", () => {
    const schema = defineSchema({ ...authSchema, ...short });
    expect(() => createUserHandlers({ table: "members", schema })).toThrow(/members' lacks emailVerified, credentialsChangedAt, profile/);
    expect(() => createUserHandlers({ table: "auth_users", schema })).not.toThrow();
    expect(() => createUserHandlers({ table: "nope", schema })).toThrow(/not in the schema/);
  });

  test("deleteUser revokes the user before a later write can fail on such a table", async () => {
    const h = await harness({}, short);
    await h.driver.exec(`INSERT INTO "members" (username, passwordHash, roles, email, active, createdAt) VALUES ('ada', '', '[]', NULL, 1, 0)`, []);
    const members = createUserHandlers({ table: "members" }); // no schema: the shape is not checked
    const admin = { userId: "admin", roles: ["admin"] };
    await expect(h.run(members.deleteUser, h.ctx(admin), { username: "ada" })).rejects.toThrow();
    expect(h.kvPuts.some((p) => p.key.includes("ada") && p.key.toLowerCase().includes("denied"))).toBe(true);
  });
});
