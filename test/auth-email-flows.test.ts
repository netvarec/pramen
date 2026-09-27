// @pramen/auth password reset + email verification: the one-time-email-token flows.
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
import type { HandlerContext, JsonValue } from "@pramen/server";
import {
  authSchema,
  emailTokenSchema,
  magicLinkSchema,
  authHandlers,
  userHandlers,
  createPasswordReset,
  createEmailVerification,
  createMagicLinkAuth,
  verifyPassword,
} from "../packages/auth/src/index";

// `magicLinkSchema` je tu kvůli `inviteUser` (ten píše do `auth_magic_links`), účet bez hesla
// se jinak nedá založit tak, jak vzniká v provozu, a test na první heslo by stál na ručním
// INSERTu, tedy na domněnce o tvaru řádku místo na tom, co ho doopravdy zakládá.
const schema = defineSchema({ ...authSchema, ...emailTokenSchema, ...magicLinkSchema });
// Every module's `sendEmail` lands here: the token is minted inside the send TASK (#73), so
// the email is the only place a test (or a user) can read it from.
interface Sent {
  kind: string;
  email: string;
  token: string;
}
let outbox: Sent[] = [];
/** How many upcoming sends throw, as a transport outage would. */
let failSends = 0;
const deliver = (kind: string) => async (_c: HandlerContext, a: { email: string; token: string }) => {
  if (failSends > 0) {
    failSends--;
    throw new Error("transport down");
  }
  outbox.push({ kind, ...a });
};
const reset = createPasswordReset({ sendEmail: deliver("reset") });
const verify = createEmailVerification({ sendEmail: deliver("verify") });
// Jen kvůli `inviteUser`: účet bez hesla se jinak nedá založit tak, jak vzniká v provozu.
const magic = createMagicLinkAuth({ sendEmail: deliver("magic") });
const tasks = { ...reset.tasks, ...verify.tasks, ...magic.tasks };
const SECRET = "test-secret-at-least-16-chars";

interface Enqueued {
  kind: string;
  payload: { email: string; username?: string; requestId?: string; token?: string };
}

async function harness() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const db = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
  const enqueued: Enqueued[] = [];
  outbox = [];
  failSends = 0;
  const sent = outbox;
  /** Run a recorded task the way the drainer would. */
  const runTask = (t: Enqueued) => Promise.resolve(tasks[t.kind](ctx(), t.payload, { id: t.kind, attempts: 1 }));
  // A minimal handler ctx: system Db (the handlers' authorization is the token, not the
  // ACL), an env with AUTH_SECRET (signup signs a token), an identity, and a task sink that
  // records the payload and, unless `drain` is off, runs the task right away, so the
  // emailed token shows up in `sent`. With `drain: false` a test runs tasks itself, in
  // whatever order a real outbox could.
  const ctx = (identity: { userId: string; roles?: string[] } | null = null, { drain = true } = {}): never => {
    const c = {
      db,
      env: { AUTH_SECRET: SECRET },
      identity,
      tasks: {
        enqueue: async (t: Enqueued) => {
          enqueued.push(t);
          if (drain) await runTask(t);
        },
      },
    };
    return c as never;
  };
  const run = (h: { run: (c: never, i: never) => unknown }, c: never, input?: unknown) => Promise.resolve().then(() => h.run(c, input));
  const rawUser = async (username: string) => (await driver.exec("SELECT * FROM auth_users WHERE username = ?", [username]))[0];
  return { driver, db, enqueued, sent, ctx, run, runTask, rawUser };
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
    const token = h.sent[0].token;

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
    const token = h.sent[0].token;
    await h.run(reset.handlers.resetPassword, h.ctx(), { token, newPassword: "firstchange" });
    await expect(h.run(reset.handlers.resetPassword, h.ctx(), { token, newPassword: "secondchange" })).rejects.toThrow(/invalid or expired/);
  });

  test("an expired token is rejected", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const token = h.sent[0].token;
    // Force the stored token to be in the past.
    await h.driver.exec("UPDATE auth_email_tokens SET expiresAt = ? WHERE purpose = 'reset'", [Date.now() - 1000]);
    await expect(h.run(reset.handlers.resetPassword, h.ctx(), { token, newPassword: "whatever1" })).rejects.toThrow(/invalid or expired/);
  });

  test("re-requesting invalidates the prior token (only the latest works)", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const first = h.sent[0].token;
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const second = h.sent[1].token;
    expect(second).not.toBe(first);
    await expect(h.run(reset.handlers.resetPassword, h.ctx(), { token: first, newPassword: "whatever1" })).rejects.toThrow(/invalid or expired/);
    const ok = (await h.run(reset.handlers.resetPassword, h.ctx(), { token: second, newPassword: "whatever2" })) as { ok: boolean };
    expect(ok.ok).toBe(true);
  });

  test("a deactivated account: request sends nothing, and a pre-issued token won't reset", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const token = h.sent[0].token;
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
    const token = h.sent[0].token;

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
    const token = h.sent[0].token;
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
    const staleToken = h.sent[0].token;
    // Simulate a changeEmail after the request (raw update; the real handler also clears
    // emailVerified, which is exercised in the e2e suite).
    await h.driver.exec("UPDATE auth_users SET email = 'ada2@example.com', emailVerified = NULL WHERE username = 'ada'", []);
    await expect(h.run(verify.handlers.verifyEmail, h.ctx(), { token: staleToken })).rejects.toThrow(/invalid or expired/);
    expect((await h.rawUser("ada")).emailVerified).toBe(null); // never verified the new address
  });

  test("verify tokens are single-use", async () => {
    const h = await harness();
    await seedUser(h, "ada", "correcthorse", "ada@example.com");
    await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }));
    const token = h.sent[0].token;
    await h.run(verify.handlers.verifyEmail, h.ctx(), { token });
    await expect(h.run(verify.handlers.verifyEmail, h.ctx(), { token })).rejects.toThrow(/invalid or expired/);
  });

  test("a reset token cannot be redeemed as a verification token (purpose is enforced)", async () => {
    const h = await harness();
    await seedUser(h, "ada", "correcthorse", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const resetToken = h.sent[0].token;
    await expect(h.run(verify.handlers.verifyEmail, h.ctx(), { token: resetToken })).rejects.toThrow(/invalid or expired/);
  });
});

describe("tokens never rest in the outbox (#73)", () => {
  const admin = { userId: "admin", roles: ["admin"] };
  const later = { drain: false };
  const login = (h: Awaited<ReturnType<typeof harness>>, token: string) => h.run(magic.handlers.loginWithMagicLink, h.ctx(), { token });

  test("no send-task payload carries the emailed token, for any of the four flows", async () => {
    const h = await harness();
    await seedUser(h, "ada", "correcthorse", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }));
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "bob@example.com" });
    await h.run(magic.handlers.inviteUser, h.ctx(admin), { email: "cy@example.com" });

    expect(h.enqueued.map((t) => t.kind)).toEqual(["sendPasswordResetEmail", "sendVerificationEmail", "sendMagicLinkEmail", "sendMagicLinkEmail"]);
    expect(h.sent).toHaveLength(4);
    const payloads = JSON.stringify(h.enqueued.map((t) => t.payload));
    for (const { token } of h.sent) {
      expect(token.length).toBeGreaterThan(20);
      expect(payloads).not.toContain(token);
    }
    for (const t of h.enqueued) expect(t.payload).not.toHaveProperty("token");
  });

  test("a pending request is never redeemable", async () => {
    const h = await harness();
    await h.run(magic.handlers.requestMagicLink, h.ctx(null, later), { email: "bob@example.com" });
    const [row] = await h.driver.exec("SELECT tokenHash, requestId FROM auth_magic_links", []);
    expect(row.tokenHash).toBe(`pending:${row.requestId}`);
    await expect(login(h, String(row.requestId))).rejects.toThrow(/invalid or expired/);
    await expect(login(h, `pending:${row.requestId}`)).rejects.toThrow(/invalid or expired/);
  });

  test("a new request revokes the pending link before its own send task runs", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const first = h.sent[0].token;
    await h.run(reset.handlers.requestPasswordReset, h.ctx(null, later), { email: "ada@example.com" });
    await expect(h.run(reset.handlers.resetPassword, h.ctx(), { token: first, newPassword: "whatever1" })).rejects.toThrow(/invalid or expired/);
  });

  test("an older task running after a newer request sends nothing and leaves the newer link live", async () => {
    const h = await harness();
    await h.run(magic.handlers.requestMagicLink, h.ctx(null, later), { email: "bob@example.com" });
    const older = h.enqueued[0];
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "bob@example.com" });
    const newer = h.sent[0].token;
    await h.runTask(older);
    expect(h.sent).toHaveLength(1);
    expect(((await login(h, newer)) as { token: string }).token).toBeString();
  });

  test("a redelivery after a successful send sends nothing, and the delivered link keeps working", async () => {
    const h = await harness();
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "bob@example.com" });
    await h.runTask(h.enqueued[0]);
    expect(h.sent).toHaveLength(1);
    expect(((await login(h, h.sent[0].token)) as { token: string }).token).toBeString();
  });

  test("a retry after a failed send delivers exactly one working link", async () => {
    const h = await harness();
    await h.run(magic.handlers.requestMagicLink, h.ctx(null, later), { email: "bob@example.com" });
    failSends = 1;
    await expect(h.runTask(h.enqueued[0])).rejects.toThrow(/transport down/);
    await h.runTask(h.enqueued[0]);
    expect(h.sent).toHaveLength(1);
    expect(((await login(h, h.sent[0].token)) as { token: string }).token).toBeString();
  });

  test("two drainers running the same task concurrently send one email", async () => {
    const h = await harness();
    await h.run(magic.handlers.requestMagicLink, h.ctx(null, later), { email: "bob@example.com" });
    await Promise.all([h.runTask(h.enqueued[0]), h.runTask(h.enqueued[0])]);
    expect(h.sent).toHaveLength(1);
    expect(((await login(h, h.sent[0].token)) as { token: string }).token).toBeString();
  });

  test("once the password is reset, a late reset task mints nothing", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    await h.run(reset.handlers.resetPassword, h.ctx(), { token: h.sent[0].token, newPassword: "brandnewpass" });
    await h.runTask(h.enqueued[0]);
    expect(h.sent).toHaveLength(1);
    expect(await h.driver.exec("SELECT tokenHash FROM auth_email_tokens", [])).toHaveLength(0);
  });

  test("a reset task after changeEmail sends nothing to the old address, and a link already sent there is dead", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    const mailed = h.sent[0].token;
    await h.run(reset.handlers.requestPasswordReset, h.ctx(null, later), { email: "ada@example.com" });
    await h.driver.exec("UPDATE auth_users SET email = 'ada2@example.com' WHERE username = 'ada'", []);
    await h.runTask(h.enqueued[1]);
    expect(h.sent).toHaveLength(1);
    // The first link was revoked by the second request; mint one more to test the guard itself.
    await h.driver.exec("UPDATE auth_users SET email = 'ada@example.com' WHERE username = 'ada'", []);
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@example.com" });
    await h.driver.exec("UPDATE auth_users SET email = 'ada2@example.com' WHERE username = 'ada'", []);
    await expect(h.run(reset.handlers.resetPassword, h.ctx(), { token: h.sent[1].token, newPassword: "whatever1" })).rejects.toThrow(/invalid or expired/);
    expect(mailed).not.toBe(h.sent[1].token);
  });

  test("a reset task for a since-deactivated account sends nothing", async () => {
    const h = await harness();
    await seedUser(h, "ada", "oldpassword", "ada@example.com");
    await h.run(reset.handlers.requestPasswordReset, h.ctx(null, later), { email: "ada@example.com" });
    await h.driver.exec("UPDATE auth_users SET active = 0 WHERE username = 'ada'", []);
    await h.runTask(h.enqueued[0]);
    expect(h.sent).toHaveLength(0);
  });

  test("a verification task for an address verified in the meantime sends nothing", async () => {
    const h = await harness();
    await seedUser(h, "ada", "correcthorse", "ada@example.com");
    await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }, later));
    await h.driver.exec("UPDATE auth_users SET emailVerified = 1 WHERE username = 'ada'", []);
    await h.runTask(h.enqueued[0]);
    expect(h.sent).toHaveLength(0);
    expect(await h.driver.exec("SELECT tokenHash FROM auth_email_tokens", [])).toHaveLength(0);
  });

  test("verifying drops any other pending verification request", async () => {
    const h = await harness();
    await seedUser(h, "ada", "correcthorse", "ada@example.com");
    await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }));
    await h.run(verify.handlers.verifyEmail, h.ctx(), { token: h.sent[0].token });
    expect(await h.driver.exec("SELECT tokenHash FROM auth_email_tokens WHERE purpose = 'verify'", [])).toHaveLength(0);
  });

  test("a payload enqueued before the fix is delivered while its link is live, and not after", async () => {
    const h = await harness();
    const token = "legacy-token-from-an-0.0.76-outbox-row";
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await h.driver.exec("INSERT INTO auth_magic_links (tokenHash, email, expiresAt, createdAt) VALUES (?, ?, ?, ?)", [hash, "bob@example.com", Date.now() + 60_000, Date.now()]);
    const legacy = { kind: "sendMagicLinkEmail", payload: { email: "bob@example.com", token } };
    await h.runTask(legacy);
    expect(h.sent.map((m) => m.token)).toEqual([token]);
    await login(h, token);
    await h.runTask(legacy);
    expect(h.sent).toHaveLength(1);
  });
});

/*
 * --- Nastavení PRVNÍHO hesla ---------------------------------------------------------------
 *
 * Účet z pozvánky nebo magic linku nemá heslo (`inviteUser` i `loginWithMagicLink` nechávají
 * `passwordHash` prázdný). `changePassword` po něm dřív SOUČASNÉ heslo chtěl, takže si ho
 * přihlášený uživatel nemohl nastavit vůbec: dostal „current password is incorrect" o hesle,
 * které nikdy neexistovalo, a jedinou cestou byl reset e-mailem, tedy tok pojmenovaný podle
 * problému, který nemá.
 *
 * Pravidlo je teď jedno: PRÁZDNOU přihrádku smí zaplnit sezení, OBSAZENOU jen ten, kdo dokáže,
 * že staré heslo zná. Druhá půlka je ta, na které záleží, a je tady doložená vedle první,
 * jinak by se z „umí to i bez hesla" snadno stalo „nechce heslo nikdy".
 */
describe("první heslo pro účet z magic linku", () => {
  /** Účet bez hesla, přesně jak ho zakládá pozvánka. */
  const invite = async (h: Awaited<ReturnType<typeof harness>>, email: string) => {
    await h.run(magic.handlers.inviteUser, h.ctx({ userId: "admin", roles: ["admin"] }), { email });
    h.enqueued.length = 0;
    expect(String((await h.rawUser(email)).passwordHash)).toBe("");
  };

  test("prázdné „současné heslo“ nastaví první heslo a přihlášení pak projde", async () => {
    const h = await harness();
    await invite(h, "ada@example.com");

    const res = (await h.run(userHandlers.changePassword, h.ctx({ userId: "ada@example.com" }), {
      currentPassword: "",
      newPassword: "correcthorse",
    })) as { ok: boolean; firstPassword: boolean };
    expect(res).toEqual({ ok: true, firstPassword: true });

    // A opravdu se tím účet odemkl: `login` je jediný důkaz, který stojí za řeč.
    const login = (await h.run(authHandlers.login, h.ctx(), { username: "ada@example.com", password: "correcthorse" })) as {
      token: string;
    };
    expect(login.token).toBeString();
  });

  test("obsazenou přihrádku sezení samo nepřepíše", async () => {
    // Tohle je ta vlastnost, kterou uvolnění NESMÍ vzít s sebou: kdo má jen ukradené sezení,
    // nesmí z něj vyrobit trvalé heslo tam, kde už nějaké je.
    const h = await harness();
    await seedUser(h, "bob", "correcthorse");
    const before = String((await h.rawUser("bob")).passwordHash);

    await expect(
      h.run(userHandlers.changePassword, h.ctx({ userId: "bob" }), { currentPassword: "", newPassword: "brandnewpass" }),
    ).rejects.toThrow(/current password is incorrect/);
    await expect(
      h.run(userHandlers.changePassword, h.ctx({ userId: "bob" }), { currentPassword: "hadam", newPassword: "brandnewpass" }),
    ).rejects.toThrow(/current password is incorrect/);
    expect(String((await h.rawUser("bob")).passwordHash)).toBe(before);
  });

  test("běžná změna hesla se hlásí jako změna, ne jako nastavení", async () => {
    // `firstPassword` řídí větu, kterou administrace ukáže. Kdyby lhala, uživatel s heslem se
    // dozví „heslo nastaveno“ a bude si myslet, že to staré přestalo platit.
    const h = await harness();
    await seedUser(h, "cyd", "oldpassword");
    const res = (await h.run(userHandlers.changePassword, h.ctx({ userId: "cyd" }), {
      currentPassword: "oldpassword",
      newPassword: "brandnewpass",
    })) as { firstPassword: boolean };
    expect(res.firstPassword).toBe(false);
  });

  test("token na smazaný účet nic nezaloží", async () => {
    // Dřív spadl do téže větve jako uživatel bez hesla a odmítl se, neškodně. Jakmile se ale
    // prázdná přihrádka smí zaplnit, byl by z toho UPDATE bez jediného řádku, který hlásí
    // úspěch: administrace by řekla „heslo nastaveno“ a přihlásit by se nedalo nikdy.
    const h = await harness();
    await expect(
      h.run(userHandlers.changePassword, h.ctx({ userId: "kdovi" }), { currentPassword: "", newPassword: "correcthorse" }),
    ).rejects.toThrow(/authentication required/);
    expect(await h.rawUser("kdovi")).toBeUndefined();
  });

  test("krátké heslo neprojde ani na účtu bez hesla", async () => {
    // Uvolnění se týká SOUČASNÉHO hesla, ne požadavků na nové.
    const h = await harness();
    await invite(h, "dan@example.com");
    await expect(
      h.run(userHandlers.changePassword, h.ctx({ userId: "dan@example.com" }), { currentPassword: "", newPassword: "krátké" }),
    ).rejects.toThrow(/at least 8 characters/);
    expect(String((await h.rawUser("dan@example.com")).passwordHash)).toBe("");
  });

  test("bez přihlášení to nejde vůbec", async () => {
    const h = await harness();
    await invite(h, "eve@example.com");
    await expect(
      h.run(userHandlers.changePassword, h.ctx(), { currentPassword: "", newPassword: "correcthorse" }),
    ).rejects.toThrow();
    expect(String((await h.rawUser("eve@example.com")).passwordHash)).toBe("");
  });
});
