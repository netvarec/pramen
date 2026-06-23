// @pramen/auth user management: admin (listUsers / setUserRoles / setUserActive) +
// self-service (changeEmail / changePassword), authorized declaratively by
// authPolicies() — NOT imperative role checks. Runs on the default `main` tenant
// (signup is anonymous). Proves: passwordHash is never projected, admin-only ops are
// ACL-gated (a regular user is denied), self ops are scoped to the caller's own row,
// deactivation blocks login, and a password change rotates the credential.

import { assert, http, token } from "../lib";

export async function runUserManagement(base: string): Promise<void> {
  const call = http(base, "main");
  const admin = await token("admin", ["admin"]); // userId = "admin"

  // Seed two real users via signup (role ["user"]). Their tokens carry userId=username.
  const aliceSignup = await call("signup", { username: "um_alice", password: "password123" });
  const bobSignup = await call("signup", { username: "um_bob", password: "password123" });
  assert(aliceSignup.body.ok && bobSignup.body.ok, "um: seeded two users via signup");
  const alice = aliceSignup.body.result.token;

  // --- admin: listUsers projects out passwordHash ---------------------------
  const list = await call("listUsers", { limit: 200 }, admin);
  assert(list.body.ok && Array.isArray(list.body.result), "um: admin listUsers returns rows");
  const rows = list.body.result as Record<string, unknown>[];
  assert(rows.some((r) => r.username === "um_alice"), "um: a seeded user appears in the admin listing");
  assert(
    rows.every((r) => !("passwordHash" in r)),
    "um: passwordHash is NEVER projected to the admin listing",
  );

  // --- admin: setUserRoles --------------------------------------------------
  const promote = await call("setUserRoles", { username: "um_alice", roles: ["user", "editor"] }, admin);
  assert(promote.body.ok, "um: admin setUserRoles succeeds");
  assert(
    JSON.stringify(promote.body.result.roles) === JSON.stringify(["user", "editor"]),
    "um: setUserRoles echoes the new roles",
  );

  // a regular user cannot setUserRoles (ACL denies writing `roles` / another row)
  const escalate = await call("setUserRoles", { username: "um_bob", roles: ["admin"] }, alice);
  assert(escalate.status === 403, "um: a non-admin setUserRoles is denied (403)");

  // --- self-service: listUsers as a user sees ONLY itself -------------------
  const selfList = await call("listUsers", {}, alice);
  assert(selfList.body.ok, "um: a user may call listUsers");
  const selfRows = selfList.body.result as Record<string, unknown>[];
  assert(
    selfRows.length >= 1 && selfRows.every((r) => r.username === "um_alice"),
    "um: the self policy scopes listUsers to the caller's own row",
  );
  assert(selfRows.every((r) => !("roles" in r)), "um: the self projection excludes roles");

  // --- self-service: changeEmail -------------------------------------------
  const badEmail = await call("changeEmail", { email: "not-an-email" }, alice);
  assert(badEmail.status === 400, "um: changeEmail rejects a malformed address (400)");
  const newEmail = await call("changeEmail", { email: "alice@new.example.com" }, alice);
  assert(newEmail.body.ok && newEmail.body.result.email === "alice@new.example.com", "um: changeEmail updates own email");

  // a user cannot change another user's email (the self policy scopes to own row)
  // — there's no input to target another row, so this is implicit; instead prove the
  // admin path is the only cross-user writer (covered by setUserRoles above).

  // --- self-service: changePassword rotates the credential ------------------
  const wrongCurrent = await call("changePassword", { currentPassword: "nope", newPassword: "brandnew123" }, alice);
  assert(wrongCurrent.status === 401, "um: changePassword with a wrong current password → 401");
  const changed = await call("changePassword", { currentPassword: "password123", newPassword: "brandnew123" }, alice);
  assert(changed.body.ok && changed.body.result?.ok === true, "um: changePassword succeeds");
  const oldLogin = await call("login", { username: "um_alice", password: "password123" });
  assert(oldLogin.status === 401, "um: the old password no longer logs in (401)");
  const newLogin = await call("login", { username: "um_alice", password: "brandnew123" });
  assert(newLogin.body.ok && typeof newLogin.body.result.token === "string", "um: the new password logs in");

  // --- admin: deactivate blocks login, reactivate restores it ---------------
  const deactivate = await call("setUserActive", { username: "um_bob", active: false }, admin);
  // bool columns read back as SQLite 0/1 (pramen stores booleans as INTEGER, no read-decode).
  assert(deactivate.body.ok && Number(deactivate.body.result.active) === 0, "um: admin deactivates a user");
  const blocked = await call("login", { username: "um_bob", password: "password123" });
  assert(blocked.status === 401, "um: a deactivated user cannot log in (401)");
  const reactivate = await call("setUserActive", { username: "um_bob", active: true }, admin);
  assert(reactivate.body.ok, "um: admin reactivates the user");
  const restored = await call("login", { username: "um_bob", password: "password123" });
  assert(restored.body.ok, "um: the reactivated user can log in again");

  // an admin cannot deactivate their own account (foot-gun guard)
  const selfOff = await call("setUserActive", { username: "admin", active: false }, admin);
  assert(selfOff.status === 400, "um: an admin cannot deactivate their own account (400)");

  // --- email uniqueness ------------------------------------------------------
  // alice set alice@new.example.com above; bob trying to take it gets a clean 400.
  const bobLogin = await call("login", { username: "um_bob", password: "password123" });
  const bobTok = bobLogin.body.result.token;
  const clash = await call("changeEmail", { email: "alice@new.example.com" }, bobTok);
  assert(clash.status === 400, "um: changeEmail rejects an email already in use (400, not 500)");

  // --- admin: deleteUser (delete by a non-`id` PK) ---------------------------
  const noSelfDelete = await call("deleteUser", { username: "admin" }, admin);
  assert(noSelfDelete.status === 400, "um: an admin cannot delete their own account (400)");
  const del = await call("deleteUser", { username: "um_bob" }, admin);
  assert(del.body.ok && del.body.result?.ok === true, "um: admin deleteUser succeeds");
  const goneLogin = await call("login", { username: "um_bob", password: "password123" });
  assert(goneLogin.status === 401, "um: a deleted user can no longer log in (401)");
  const goneList = await call("listUsers", { limit: 200 }, admin);
  assert(
    !(goneList.body.result as Record<string, unknown>[]).some((r) => r.username === "um_bob"),
    "um: the deleted user is gone from the listing",
  );

  // --- hardening: the SYSTEM-scope admin data API does NOT leak passwordHash --
  const adminData = await fetch(`${base}/admin/data`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ tenant: "main", table: "auth_users", op: "list", limit: 200 }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  assert(adminData.body.ok && Array.isArray(adminData.body.result), "um: /admin/data lists auth_users");
  assert(
    (adminData.body.result as Record<string, unknown>[]).every((r) => !("passwordHash" in r)),
    "um: hidden() — /admin/data never returns passwordHash even under SYSTEM scope",
  );
}
