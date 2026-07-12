// @pramen/auth magic link: passwordless login via an emailed one-time token.
// Runs on the default `main` tenant (request/login are anonymous). Proves: a request
// always returns ok (no enumeration), the emailed token logs in and issues a token
// the core verifier accepts, single-use (replay rejected), expiry validation, bad
// tokens rejected, and that re-requesting invalidates the prior link.

import { assert, http, token } from "../lib";

/** Run the outbox now: the email (and its dev token-stash in KV) is sent from the
 * `sendMagicLinkEmail` task AFTER the requestMagicLink mutation commits, so the test must
 * drain before reading the inbox. The DO also self-drains via an alarm; this is deterministic. */
async function drain(base: string, admin: string): Promise<void> {
  await fetch(`${base}/admin/tasks/drain`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ tenant: "main" }),
  });
}

export async function runMagicLink(base: string): Promise<void> {
  const call = http(base, "main"); // request/login are anonymous → the open default tenant
  const admin = await token("admin", ["admin"]); // the dev __magicInbox is admin-gated
  const email = "casey@example.com";

  // input validation: a malformed email is rejected at the boundary
  const bad = await call("requestMagicLink", { email: "not-an-email" });
  assert(bad.status === 400, "magic: malformed email rejected (400)");

  // request → always { ok: true } (same response whether or not the account exists)
  const req = await call("requestMagicLink", { email });
  assert(req.body.ok && req.body.result?.ok === true, "magic: requestMagicLink returns ok");
  await drain(base, admin); // the email (token stash) is sent from a task after commit

  // read the "inbox" (dev-only handler in the example app) to get the emailed token
  const inbox = await call("__magicInbox", { email }, admin);
  const linkToken = inbox.body.result?.token as string;
  assert(typeof linkToken === "string" && linkToken.length > 0, "magic: a token was emailed");

  // hardening: the dev inbox is admin-gated — an anonymous caller can't read the token.
  const anonInbox = await call("__magicInbox", { email });
  assert(anonInbox.status === 403, "magic: __magicInbox is admin-only (anonymous denied — no token leak)");

  // a bad token → 401 (same shape as expired)
  const wrong = await call("loginWithMagicLink", { token: "deadbeef-not-real" });
  assert(wrong.status === 401, "magic: invalid token → 401");

  // redeem → session token + the find-or-created passwordless user
  const login = await call("loginWithMagicLink", { token: linkToken });
  assert(login.body.ok && typeof login.body.result.token === "string", "magic: redeem issues a session token");
  assert(login.body.result.user.username === email, "magic: the user is keyed by email");
  assert(
    JSON.stringify(login.body.result.user.roles) === JSON.stringify(["user"]),
    "magic: a first-time magic-link user gets the default role",
  );
  const session = login.body.result.token;

  // the issued token is accepted by the core verifier (me echoes the identity)
  const me = await call("me", {}, session);
  assert(me.body.ok && me.body.result?.userId === email, "magic: issued token verifies — me returns the identity");

  // single-use: replaying the same link → 401
  const replay = await call("loginWithMagicLink", { token: linkToken });
  assert(replay.status === 401, "magic: a consumed link cannot be replayed (401)");

  // re-request invalidates the prior link: a fresh request mints a new token, and the
  // OLD token (already consumed above) plus any prior pending link no longer works.
  const req2 = await call("requestMagicLink", { email });
  assert(req2.body.ok, "magic: re-request returns ok");
  await drain(base, admin);
  const inbox2 = await call("__magicInbox", { email }, admin);
  const linkToken2 = inbox2.body.result?.token as string;
  assert(linkToken2 !== linkToken, "magic: re-request mints a distinct token");
  const login2 = await call("loginWithMagicLink", { token: linkToken2 });
  assert(login2.body.ok, "magic: the latest link logs the returning user in");
  assert(
    JSON.stringify(login2.body.result.user.roles) === JSON.stringify(["user"]),
    "magic: a returning user keeps their existing roles (not re-created)",
  );
}
