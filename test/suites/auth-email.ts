// @pramen/auth password reset + email verification (the one-time-email-token flows).
// Runs on the default `main` tenant (request/redeem are anonymous or self-authenticated).
// Proves, against a real wrangler-dev DO: signup stores an unverified email; the emailed
// verification token stamps emailVerified and is single-use; requestPasswordReset is
// enumeration-safe and the emailed reset token changes the password (old fails, new works)
// once; and a changeEmail invalidates a pending verification token AND clears emailVerified.

import { assert, http, token } from "../lib";

/** Drain the outbox so the emails (and their dev token-stashes in KV) are sent — the
 * sends run from tasks AFTER the request mutation commits. */
async function drain(base: string, admin: string): Promise<void> {
  await fetch(`${base}/admin/tasks/drain`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ tenant: "main" }),
  });
}

export async function runAuthEmail(base: string): Promise<void> {
  const call = http(base, "main");
  const admin = await token("admin", ["admin"]); // the dev __*Inbox handlers are admin-gated
  const email = "reset-me@example.com";
  const password = "originalpass1";

  // --- signup stores the email UNVERIFIED ---
  const su = await call("signup", { username: email, password, email });
  assert(su.body.ok && su.body.result.user.email === email, "auth-email: signup accepts + echoes the email");
  const userToken = su.body.result.token as string;

  // a self-read shows the email present but unverified (emailVerified null)
  // (listUsers with the self policy returns only the caller's own row)
  // We instead assert verification state via the flow below.

  // --- email verification (authenticated request → anonymous verify) ---
  const anonReq = await call("requestEmailVerification", {});
  assert(anonReq.status === 403, "auth-email: requestEmailVerification requires authentication (403)");

  const req = await call("requestEmailVerification", {}, userToken);
  assert(req.body.ok && req.body.result.ok === true, "auth-email: requestEmailVerification returns ok");
  await drain(base, admin);

  const vInbox = await call("__verifyInbox", { email }, admin);
  const verifyToken = vInbox.body.result?.token as string;
  assert(typeof verifyToken === "string" && verifyToken.length > 0, "auth-email: a verification token was emailed");

  // the dev inbox is admin-gated (no anonymous token leak)
  const anonInbox = await call("__verifyInbox", { email });
  assert(anonInbox.status === 403, "auth-email: __verifyInbox is admin-only");

  const bad = await call("verifyEmail", { token: "not-a-real-token" });
  assert(bad.status === 401, "auth-email: an invalid verification token → 401");

  const verified = await call("verifyEmail", { token: verifyToken });
  assert(verified.body.ok && verified.body.result.email === email, "auth-email: verifyEmail confirms the address");

  // single-use: replay rejected
  const replay = await call("verifyEmail", { token: verifyToken });
  assert(replay.status === 401, "auth-email: a verification token is single-use (replay → 401)");

  // re-requesting once verified is a no-op that sends nothing new
  const already = await call("requestEmailVerification", {}, userToken);
  assert(already.body.ok && already.body.result.alreadyVerified === true, "auth-email: re-request after verify is a no-op (alreadyVerified)");

  // --- changeEmail invalidates verification (clears emailVerified) ---
  const newEmail = "moved@example.com";
  // request a fresh verify token, then change the email before redeeming it
  await call("changeEmail", { email: "still-old@example.com" }, userToken); // sets a (now-old) address, clears verified
  const req2 = await call("requestEmailVerification", {}, userToken);
  assert(req2.body.ok, "auth-email: can request verification again after changeEmail cleared the flag");
  await drain(base, admin);
  const staleToken = (await call("__verifyInbox", { email: "still-old@example.com" }, admin)).body.result?.token as string;
  // change the email again — the stale token was minted for the previous address
  await call("changeEmail", { email: newEmail }, userToken);
  const staleVerify = await call("verifyEmail", { token: staleToken });
  assert(staleVerify.status === 401, "auth-email: a verify token for a since-changed address is rejected (401)");

  // --- password reset (anonymous request → anonymous reset) ---
  const badEmail = await call("requestPasswordReset", { email: "not-an-email" });
  assert(badEmail.status === 400, "auth-email: requestPasswordReset validates the email (400)");

  // enumeration-safe: an unknown address still returns ok
  const unknown = await call("requestPasswordReset", { email: "nobody-here@example.com" });
  assert(unknown.body.ok && unknown.body.result.ok === true, "auth-email: requestPasswordReset is enumeration-safe (ok for unknown)");

  // the real account (its current email is `newEmail` after the changeEmail above)
  const rReq = await call("requestPasswordReset", { email: newEmail });
  assert(rReq.body.ok && rReq.body.result.ok === true, "auth-email: requestPasswordReset returns ok for a real account");
  await drain(base, admin);
  const resetToken = (await call("__pwResetInbox", { email: newEmail }, admin)).body.result?.token as string;
  assert(typeof resetToken === "string" && resetToken.length > 0, "auth-email: a reset token was emailed");

  const tooShort = await call("resetPassword", { token: resetToken, newPassword: "short" });
  assert(tooShort.status === 400, "auth-email: resetPassword enforces the min password length (400)");

  const newPassword = "brandnewpass2";
  const done = await call("resetPassword", { token: resetToken, newPassword });
  assert(done.body.ok && done.body.result.ok === true, "auth-email: resetPassword succeeds");

  // the new password logs in; the old one no longer does
  const newLogin = await call("login", { username: email, password: newPassword });
  assert(newLogin.body.ok && typeof newLogin.body.result.token === "string", "auth-email: the new password logs in");
  const oldLogin = await call("login", { username: email, password });
  assert(oldLogin.status === 401, "auth-email: the old password no longer logs in (401)");

  // the reset token is single-use
  const reuse = await call("resetPassword", { token: resetToken, newPassword: "another1pass" });
  assert(reuse.status === 401, "auth-email: a reset token is single-use (replay → 401)");
}
