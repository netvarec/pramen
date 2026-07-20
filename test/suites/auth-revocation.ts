// @pramen/auth session refresh + hard revocation. Proves: refreshSession reissues a
// token for an active user (and reflects a role GRANT with no re-login), refuses a
// deactivated user; the KV denylist (written by setUserActive(false)/deleteUser) makes
// the core Worker reject an OUTSTANDING token immediately (401, not a downgrade to
// anonymous); reactivation lifts the denylist; and a WebSocket enforces the token's
// `exp` per message, so a socket can't outlive its TTL. Runs on the default `main`
// tenant (signup is anonymous; the denylist is global KV, so a unique `rev_` prefix
// keeps it clear of other suites).

import { assert, http, sign, sleep, token, wsClient } from "../lib";

export async function runRevocation(base: string, wsUrl: string): Promise<void> {
  const call = http(base, "main");
  const admin = await token("admin", ["admin"]);

  // Seed a user via signup (role ["user"]); its token carries userId = username.
  const su = await call("signup", { username: "rev_carol", password: "password123" });
  assert(su.body.ok, "revoke: seeded a user via signup");
  let carol = su.body.result.token as string;

  // --- refreshSession: reissues a token for the active caller -----------------
  const refreshed = await call("refreshSession", {}, carol);
  assert(refreshed.body.ok && typeof refreshed.body.result.token === "string", "revoke: refreshSession issues a fresh token");
  assert(refreshed.body.result.user.username === "rev_carol", "revoke: refreshSession echoes the username");
  assert(
    JSON.stringify(refreshed.body.result.user.roles) === JSON.stringify(["user"]),
    "revoke: refreshSession re-reads the current roles",
  );
  carol = refreshed.body.result.token;
  const me = await call("me", {}, carol);
  assert(me.body.ok && me.body.result?.userId === "rev_carol", "revoke: the refreshed token verifies (me)");

  // requires authentication — an anonymous refresh is refused
  const anonRefresh = await call("refreshSession", {});
  assert(anonRefresh.status === 403, "revoke: refreshSession requires authentication (403 anonymous)");

  // --- refreshSession picks up a role GRANT with no re-login ------------------
  const promote = await call("setUserRoles", { username: "rev_carol", roles: ["user", "editor"] }, admin);
  assert(promote.body.ok, "revoke: admin grants the editor role");
  const regrant = await call("refreshSession", {}, carol);
  assert(
    JSON.stringify(regrant.body.result.user.roles) === JSON.stringify(["user", "editor"]),
    "revoke: refreshSession reflects the new role immediately (no re-login)",
  );
  carol = regrant.body.result.token;

  // --- KV denylist: deactivation revokes an OUTSTANDING token immediately -----
  const off = await call("setUserActive", { username: "rev_carol", active: false }, admin);
  assert(off.body.ok, "revoke: admin deactivates the user");
  await sleep(150); // the denylist entry is written in the DO; the Worker reads it (KV)
  const denied = await call("me", {}, carol);
  assert(denied.status === 401, "revoke: an outstanding token is rejected after deactivation (denylist 401, not anon)");
  const noRefresh = await call("refreshSession", {}, carol);
  assert(noRefresh.status === 401, "revoke: refreshSession is refused for the deactivated user (401)");

  // --- reactivation LIFTS the denylist (username-scoped, so it must be cleared) ---
  const on = await call("setUserActive", { username: "rev_carol", active: true }, admin);
  assert(on.body.ok, "revoke: admin reactivates the user");
  await sleep(150);
  const relogin = await call("login", { username: "rev_carol", password: "password123" });
  assert(relogin.body.ok && typeof relogin.body.result.token === "string", "revoke: the reactivated user can log in again");
  const meAgain = await call("me", {}, relogin.body.result.token);
  assert(meAgain.body.ok, "revoke: a fresh token works after reactivation (denylist lifted)");

  // --- deleteUser also denylists the (now-gone) user --------------------------
  const su2 = await call("signup", { username: "rev_dan", password: "password123" });
  const dan = su2.body.result.token as string;
  await call("deleteUser", { username: "rev_dan" }, admin);
  await sleep(150);
  const danDenied = await call("me", {}, dan);
  assert(danDenied.status === 401, "revoke: a deleted user's outstanding token is rejected (denylist 401)");

  // --- WebSocket: a socket enforces the token's exp per message ----------------
  // Mint an admin token that is valid now but expires in ~3s (the `sign` helper lets the
  // payload override its default exp). It upgrades fine, subscribes, then — after it has
  // expired — the next message is rejected 4401 rather than dispatched under a dead token.
  const shortExp = Math.floor(Date.now() / 1000) + 3;
  const expiring = await sign({ sub: "rev_ws", roles: ["admin"], exp: shortExp });
  const live = wsClient(wsUrl, { authorization: `Bearer ${expiring}`, "x-pramen-tenant": "main" });
  await live.ready;
  live.send({ type: "subscribe", id: "l", name: "listNotes" });
  const seeded = await live.next((m: any) => m.type === "data" && m.id === "l", "ws: initial data before expiry");
  assert(Array.isArray(seeded.result), "revoke(ws): subscription seeded while the token is still valid");
  await sleep(3200); // let the token expire
  live.send({ type: "call", id: "c", name: "listNotes" });
  const err = await live.next((m: any) => m.type === "error" && m.id === "c", "ws: error frame after expiry");
  assert(err.code === "unauthorized", "revoke(ws): a message on an expired socket is rejected (unauthorized), not dispatched");
  live.close();
}
