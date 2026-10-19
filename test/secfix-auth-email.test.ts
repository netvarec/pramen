// Security regressions in the emailed-token flows and the recovery address.
//
// - pramen/auth:changeEmail-unverified-address-feeds-password-reset: a bare session rewrote the
//   recovery address, then reset the password changePassword refuses to replace.
// - pramen/auth:changeEmail:verified-flag-cleared-in-separate-statement: on D1, an invocation cut
//   off between the email write and the flag clear left the new address verified.
// - pramen/auth:single-use-token-consume-unconditional-update: two concurrent redemptions of one
//   magic-link / reset / verify token both passed on D1.
// - pramen/auth:verifyEmail:stamp-not-conditioned-on-current-email: a changeEmail landing
//   between verifyEmail's check and its stamp got an unconfirmed address marked verified.
// - pramen/auth:anonymous-email-send-unthrottled: one email per call, to any address.
//
// The harness driver behaves like D1 (every statement autocommits), so the interleavings and
// the cut-off are the real ones.

import { describe, expect, test } from "bun:test";
import { authHandlers, createEmailVerification, createMagicLinkAuth, createPasswordReset, userHandlers, verifyPassword } from "../packages/auth/src/index";
import { harness, recorder, type Sent } from "./secfix-auth-harness";

async function setup(cooldown = 0) {
  const sent: Sent[] = [];
  const magic = createMagicLinkAuth({ sendEmail: recorder(sent, "magic"), resendCooldownSeconds: cooldown });
  const reset = createPasswordReset({ sendEmail: recorder(sent, "reset"), resendCooldownSeconds: cooldown });
  const verify = createEmailVerification({ sendEmail: recorder(sent, "verify"), resendCooldownSeconds: cooldown });
  const h = await harness({ ...magic.tasks, ...reset.tasks, ...verify.tasks });
  await h.run(authHandlers.signup, h.ctx(), { username: "ada", password: "adapassword", email: "ada@acme.test" });
  return { h, sent, magic, reset, verify };
}

describe("changeEmail is a credential operation when the account has a password", () => {
  test("a bare session cannot move the recovery address, so cannot reset the password through it", async () => {
    const { h, sent, reset, verify } = await setup();
    const session = h.ctx({ userId: "ada", roles: ["user"] });
    await expect(h.run(userHandlers.changeEmail, session, { email: "mallory@evil.test" })).rejects.toThrow("current password is incorrect");
    await expect(h.run(userHandlers.changeEmail, session, { email: "mallory@evil.test", currentPassword: "guess-guess" })).rejects.toThrow("current password is incorrect");
    expect((await h.raw("ada"))?.email).toBe("ada@acme.test");
    // The whole chain from the record: verify the new address, request a reset to it, redeem.
    await h.run(verify.handlers.requestEmailVerification, session);
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "mallory@evil.test" });
    expect(sent.filter((m) => m.email === "mallory@evil.test")).toHaveLength(0);
    expect(await verifyPassword("adapassword", String((await h.raw("ada"))?.passwordHash))).toBe(true);
  });

  test("with the current password it works and clears the verification", async () => {
    const { h } = await setup();
    await h.driver.exec("UPDATE auth_users SET emailVerified = 1 WHERE username = 'ada'", []);
    const res = await h.run(userHandlers.changeEmail, h.ctx({ userId: "ada" }), { email: "ada2@acme.test", currentPassword: "adapassword" });
    expect(res).toMatchObject({ email: "ada2@acme.test", emailVerified: null });
    expect(await h.raw("ada")).toMatchObject({ email: "ada2@acme.test", emailVerified: null });
  });

  test("a passwordless account needs no password to change it", async () => {
    const { h, magic, sent } = await setup();
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "bob@acme.test" });
    await h.run(magic.handlers.loginWithMagicLink, h.ctx(), { token: sent.at(-1)!.token });
    expect(await h.run(userHandlers.changeEmail, h.ctx({ userId: "bob@acme.test" }), { email: "bob2@acme.test" })).toMatchObject({ email: "bob2@acme.test" });
  });

  test("cut off after its first write, it never leaves the new address verified", async () => {
    const { h } = await setup();
    await h.driver.exec("UPDATE auth_users SET emailVerified = 1 WHERE username = 'ada'", []);
    // The invocation dies at the statement after its first write (a client disconnect
    // canceling pending I/O, incident #51). D1 keeps whatever already committed.
    let writes = 0;
    h.setBeforeExec((sql) => {
      if (/^\s*update/i.test(sql) && ++writes === 2) throw new Error("invocation canceled");
    });
    await expect(h.run(userHandlers.changeEmail, h.ctx({ userId: "ada" }), { email: "victim@corp.test", currentPassword: "adapassword" })).rejects.toThrow("invocation canceled");
    h.setBeforeExec(null);
    const row = await h.raw("ada");
    expect(row?.email === "victim@corp.test" && row?.emailVerified != null).toBe(false);
  });
});

describe("a single-use token yields one redemption, concurrent ones included", () => {
  /** Redeem twice, the second redemption running to completion right before the first one's
   * consuming write: the worst interleaving two requests can produce on D1. */
  async function redeemTwice(h: Awaited<ReturnType<typeof harness>>, redeem: () => Promise<unknown>) {
    let second: Promise<PromiseSettledResult<unknown>> | null = null;
    h.setBeforeExec(async (sql) => {
      if (second === null && /^\s*update\s+\w+\s+set\s+consumedAt/i.test(sql)) {
        h.setBeforeExec(null);
        second = Promise.allSettled([redeem()]).then(([r]) => r!);
        await second;
      }
    });
    const [first] = await Promise.allSettled([redeem()]);
    h.setBeforeExec(null);
    expect(second).not.toBeNull();
    return [first!, await second!].filter((r) => r.status === "fulfilled").length;
  }

  test("magic link", async () => {
    const { h, magic, sent } = await setup();
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "bob@acme.test" });
    const token = sent.at(-1)!.token;
    expect(await redeemTwice(h, () => h.run(magic.handlers.loginWithMagicLink, h.ctx(), { token }))).toBe(1);
  });

  test("password reset", async () => {
    const { h, reset, sent } = await setup();
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@acme.test" });
    const token = sent.at(-1)!.token;
    expect(await redeemTwice(h, () => h.run(reset.handlers.resetPassword, h.ctx(), { token, newPassword: "firstnewpw" }))).toBe(1);
  });

  test("email verification", async () => {
    const { h, verify, sent } = await setup();
    await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }));
    const token = sent.at(-1)!.token;
    expect(await redeemTwice(h, () => h.run(verify.handlers.verifyEmail, h.ctx(), { token }))).toBe(1);
  });
});

describe("verifyEmail stamps only the address the token was minted for", () => {
  test("a changeEmail landing between the redemption and the stamp leaves the new address unverified", async () => {
    const { h, verify, sent } = await setup();
    await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }));
    const token = sent.at(-1)!.token;
    // Both of changeEmail's writes land right before verifyEmail's stamp, as two requests'
    // statements interleave on D1.
    let raced = false;
    h.setBeforeExec(async (sql) => {
      if (!raced && /set emailVerified = \?/i.test(sql)) {
        raced = true;
        await h.driver.exec("UPDATE auth_users SET emailVerified = NULL WHERE username = 'ada'", []);
        await h.driver.exec("UPDATE auth_users SET email = 'victim@corp.test' WHERE username = 'ada'", []);
      }
    });
    await expect(h.run(verify.handlers.verifyEmail, h.ctx(), { token })).rejects.toThrow("invalid or expired token");
    h.setBeforeExec(null);
    expect(await h.raw("ada")).toMatchObject({ email: "victim@corp.test", emailVerified: null });
  });
});

describe("one email per address per cooldown window", () => {
  test("requestMagicLink: paced repeats inside the window send one link, still answering ok", async () => {
    const { h, magic, sent } = await setup(60);
    for (let i = 0; i < 4; i++) expect(await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "target@victim.test" })).toEqual({ ok: true });
    expect(sent.filter((m) => m.email === "target@victim.test")).toHaveLength(1);
    // The link that went out is still the live one.
    expect(await h.run(magic.handlers.loginWithMagicLink, h.ctx(), { token: sent.at(-1)!.token })).toMatchObject({ user: { username: "target@victim.test" } });
  });

  test("a redeemed link does not hold back the next one", async () => {
    const { h, magic, sent } = await setup(60);
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "target@victim.test" });
    await h.run(magic.handlers.loginWithMagicLink, h.ctx(), { token: sent.at(-1)!.token });
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "target@victim.test" });
    expect(sent.filter((m) => m.email === "target@victim.test")).toHaveLength(2);
  });

  test("after the window a new link goes out", async () => {
    const { h, magic, sent } = await setup(60);
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "target@victim.test" });
    await h.driver.exec("UPDATE auth_magic_links SET createdAt = ? WHERE email = 'target@victim.test'", [Date.now() - 61_000]);
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "target@victim.test" });
    expect(sent.filter((m) => m.email === "target@victim.test")).toHaveLength(2);
  });

  test("requestPasswordReset and requestEmailVerification", async () => {
    const { h, reset, verify, sent } = await setup(60);
    for (let i = 0; i < 3; i++) expect(await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: "ada@acme.test" })).toEqual({ ok: true });
    for (let i = 0; i < 3; i++) expect(await h.run(verify.handlers.requestEmailVerification, h.ctx({ userId: "ada" }))).toEqual({ ok: true });
    expect(sent.filter((m) => m.kind === "reset")).toHaveLength(1);
    expect(sent.filter((m) => m.kind === "verify")).toHaveLength(1);
  });

  test("the default is on", async () => {
    const sent: Sent[] = [];
    const magic = createMagicLinkAuth({ sendEmail: recorder(sent, "magic") });
    const h = await harness({ ...magic.tasks });
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "x@y.test" });
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email: "x@y.test" });
    expect(sent).toHaveLength(1);
  });
});
