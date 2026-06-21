// @pramen/auth: signup/login issue HS256 tokens the core verifier accepts, with
// PBKDF2-hashed passwords. Runs on the default `main` tenant (signup/login are
// anonymous). Proves: issuance, verification (me), ACL access via the issued token,
// password checks, and no user enumeration.

import { assert, http } from "../lib";

export async function runAuth(base: string): Promise<void> {
  const call = http(base, "main"); // signup/login are anonymous → the open default tenant
  const username = "zoe";
  const password = "password123";

  // input validation: short password rejected at the boundary
  const short = await call("signup", { username, password: "short" });
  assert(short.status === 400, "auth: short password rejected (400)");

  // signup → token + server-assigned role
  const su = await call("signup", { username, password });
  assert(su.body.ok && typeof su.body.result.token === "string", "auth: signup returns a token");
  assert(JSON.stringify(su.body.result.user.roles) === JSON.stringify(["user"]), "auth: signup assigns the default role");
  const token = su.body.result.token;

  // the issued token is accepted by the core verifier (me echoes the identity)
  const me = await call("me", {}, token);
  assert(me.body.ok && me.body.result?.userId === username, "auth: issued token verifies — me returns the identity");
  assert(JSON.stringify(me.body.result.roles) === JSON.stringify(["user"]), "auth: token carries the assigned roles");

  // and it grants ACL access (the `user` role can read notes)
  const notes = await call("listNotes", {}, token);
  assert(notes.body.ok, "auth: the issued token grants ACL access (listNotes ok)");

  // duplicate signup rejected
  const dup = await call("signup", { username, password });
  assert(dup.status === 400, "auth: duplicate username rejected (400)");

  // login: correct password → token; wrong password / unknown user → 401 (no enumeration)
  const ok = await call("login", { username, password });
  assert(ok.body.ok && typeof ok.body.result.token === "string", "auth: login returns a token");
  const wrong = await call("login", { username, password: "wrongpassword" });
  assert(wrong.status === 401, "auth: wrong password → 401");
  const ghost = await call("login", { username: "ghost", password: "password123" });
  assert(ghost.status === 401, "auth: unknown user → 401 (same shape, no enumeration)");
}
