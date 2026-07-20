// @pramen/auth password reset + email verification — the one-time-email-token flows.
// Drives the handlers built by createPasswordReset / createEmailVerification directly
// against a real system Db over bun:sqlite (the handlers use ctx.db.exec + ctx.tasks, so
// no ACL/wrangler needed). Covers: enumeration-safety, single-use, expiry, the account
// active/exists checks, the changed-email guard on verification, and signup-with-email.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema } from "../packages/server/src/sdk/schema";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";
import {
  authSchema,
  emailTokenSchema,
  authHandlers,
  createPasswordReset,
  createEmailVerification,
  verifyPassword,
} from "../packages/auth/src/index";

const schema = defineSchema({ ...authSchema, ...emailTokenSchema });
const reset = createPasswordReset({ sendEmail: async () => {} });
const verify = createEmailVerification({ sendEmail: async () => {} });
const SECRET = "test-secret-at-least-16-chars";

interface Enqueued {
  kind: string;
  payload: { email: string; token: string; username: string };
}

async function harness() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const db = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
  const enqueued: Enqueued[] = [];
  // A minimal handler ctx: system Db (the handlers' authorization is the token, not the
  // ACL), an env with AUTH_SECRET (signup signs a token), a task sink that captures the
  // payload (so the test can read the token that would have been emailed), and an identity.
  const ctx = (identity: { userId: string; roles?: string[] } | null = null) =>
    ({ db, env: { AUTH_SECRET: SECRET }, identity, tasks: { enqueue: async (t: Enqueued) => void enqueued.push(t) } }) as never;
  const run = (h: { run: (c: never, i: unknown) => unknown }, c: never, input?: unknown) => Promise.resolve().then(() => h.run(c, input));
  const rawUser = async (username: string) => (await driver.exec("SELECT * FROM auth_users WHERE username = ?", [username]))[0];
  return { driver, db, enqueued, ctx, run, rawUser };
}

// Seed a password user (optionally with an email) via the real signup handler.
async function seedUser(h: Awaited<ReturnType<typeof harness>>, username: string, password: string, email?: string) {
  await h.run(authHandlers.signup, h.ctx(), { username, password, email });
  h.enqueued.length = 0; // signup enqueues nothing, but keep the sink clean for assertions
}

describe("signup with an optional email", () => {
  test("stores the email UNVERIFIED; a duplicate email is a clean 400", async () => {
    const h = await harness();
    const res = (await h.run(authHandlers.signup, h.ctx(), { username: "ada", password: "correcthorse", email: "ada@example.com" })) as {
      user: { email: string | null };
    };
    expect(res.user.email).toBe("ada@example.com");
    const row = await h.rawUser("ada");
    expect(row.email).toBe("ada@example.com");
    expect(row.emailVerified).toBe(null); // stored unverified

    await expect(
      h.run(authHandlers.signup, h.ctx(), { username: "bob", password: "correcthorse", email: "ada@example.com" }),
    ).rejects.toThrow(/email already in use/);
  });

  test("email is optional (stays NULL when omitted)", async () => {
    const h = await harness();
    await h.run(authHandlers.signup, h.ctx(), { username: "nomail", password: "correcthorse" });
    expect((await h.rawUser("nomail")).email).toBe(null);
  });
});

describe("password reset", () => {
  test("request → reset → the new password works and the old one does not", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");

    const req = (await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" })) as { ok: boolean };
    expect(req.ok).toBe(true);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].kind).toBe("sendPasswordResetEmail");
    const token = h.enqueued[0].payload.token;

    const done = (await h.run(reset.handlers.resetPassword, h.ctx(), { token, newPassword: "brandnewpass" })) as { ok: boolean };
    expect(done.ok).toBe(true);

    const stored = String((await h.rawUser("ada")).passwordHash);
    expect(await verifyPassword("brandnewpass", stored)).toBe(true);
    expect(await verifyPassword("oldpassword", stored)).toBe(false);
  });

  test("enumeration-safe: an unknown email still returns ok, sends nothing", async () => {
    const h = await harness();
    const req = (await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "nobody@example.com" })) as { ok: boolean };
    expect(req.ok).toBe(true);
    expect(h.enqueued).toHaveLength(0); // no account matched → no email
  });

  test("single-use: the token cannot be redeemed twice", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const token = h.enqueued[0].payload.token;
    await h.run(reset.handlers.resetPassword, h.ctx(), { token, newPassword: "firstchange" });
    await expect(h.run(reset.handlers.resetPassword, h.ctx(), { token, newPassword: "secondchange" })).rejects.toThrow(/invalid or expired/);
  });

  test("an expired token is rejected", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const token = h.enqueued[0].payload.token;
    // Force the stored token to be in the past.
    await h.driver.exec("UPDATE auth_email_tokens SET expiresAt = ? WHERE purpose = 'reset'", [Date.now() - 1000]);
    await expect(h.run(reset.handlers.resetPassword, h.ctx(), { token, newPassword: "whatever1" })).rejects.toThrow(/invalid or expired/);
  });

  test("re-requesting invalidates the prior token (only the latest works)", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const first = h.enqueued[0].payload.token;
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const second = h.enqueued[1].payload.token;
    expect(second).not.toBe(first);
    await expect(h.run(reset.handlers.resetPassword, h.ctx(), { token: first, newPassword: "whatever1" })).rejects.toThrow(/invalid or expired/);
    const ok = (await h.run(reset.handlers.resetPassword, h.ctx(), { token: second, newPassword: "whatever2" })) as { ok: boolean };
    expect(ok.ok).toBe(true);
  });

  test("a deactivated account: request sends nothing, and a pre-issued token won't reset", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const token = h.enqueued[0].payload.token;
    await h.driver.exec("UPDATE auth_users SET active = 0 WHERE username = 'ada'", []);
    // a fresh request for the deactivated account enqueues nothing
    h.enqueued.length = 0;
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    expect(h.enqueued).toHaveLength(0);
    // the token issued while active no longer resets a since-deactivated account
    await expect(h.run(reset.handlers.resetPassword, h.ctx(), { token, newPassword: "whatever1" })).rejects.toThrow(/deactivated/);
  });
});

describe("email verification", () => {
  test("request (authenticated) → verify → emailVerified is stamped", async () => {
    const h = await harness();
    await seedUser(h, "ada", "correcthorse", "ada@example.com");
    expect((await h.rawUser("ada")).emailVerified).toBe(null);

    const req = (await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }))) as { ok: boolean };
    expect(req.ok).toBe(true);
    expect(h.enqueued[0].kind).toBe("sendVerificationEmail");
    const token = h.enqueued[0].payload.token;

    const res = (await h.run(verify.handlers.verifyEmail, h.ctx(), { token })) as { ok: boolean; email: string };
    expect(res.ok).toBe(true);
    expect(res.email).toBe("ada@example.com");
    expect((await h.rawUser("ada")).emailVerified).not.toBe(null); // stamped
  });

  test("no email on file → 400", async () => {
    const h = await harness();
    await seedUser(h, "nomail", "correcthorse"); // no email
    await expect(h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "nomail" }))).rejects.toThrow(/no email on file/);
  });

  test("already verified → a no-op that sends nothing", async () => {
    const h = await harness();
    await seedUser(h, "ada", "correcthorse", "ada@example.com");
    await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }));
    const token = h.enqueued[0].payload.token;
    await h.run(verify.handlers.verifyEmail, h.ctx(), { token });
    h.enqueued.length = 0;
    const again = (await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }))) as { ok: boolean; alreadyVerified?: boolean };
    expect(again.alreadyVerified).toBe(true);
    expect(h.enqueued).toHaveLength(0);
  });

  test("changed-email guard: a token for the old address won't verify a new one", async () => {
    const h = await harness();
    await seedUser(h, "ada", "correcthorse", "ada@example.com");
    await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }));
    const staleToken = h.enqueued[0].payload.token;
    // Simulate a changeEmail after the request (raw update; the real handler also clears
    // emailVerified — exercised in the e2e suite).
    await h.driver.exec("UPDATE auth_users SET email = 'ada2@example.com', emailVerified = NULL WHERE username = 'ada'", []);
    await expect(h.run(verify.handlers.verifyEmail, h.ctx(), { token: staleToken })).rejects.toThrow(/invalid or expired/);
    expect((await h.rawUser("ada")).emailVerified).toBe(null); // never verified the new address
  });

  test("verify tokens are single-use", async () => {
    const h = await harness();
    await seedUser(h, "ada", "correcthorse", "ada@example.com");
    await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }));
    const token = h.enqueued[0].payload.token;
    await h.run(verify.handlers.verifyEmail, h.ctx(), { token });
    await expect(h.run(verify.handlers.verifyEmail, h.ctx(), { token })).rejects.toThrow(/invalid or expired/);
  });

  test("a reset token cannot be redeemed as a verification token (purpose is enforced)", async () => {
    const h = await harness();
    await seedUser(h, "ada", "correcthorse", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const resetToken = h.enqueued[0].payload.token;
    await expect(h.run(verify.handlers.verifyEmail, h.ctx(), { token: resetToken })).rejects.toThrow(/invalid or expired/);
  });
});
