// createAuthHandlers({ loginBy }) — logging in with an email instead of the username.
//
// The motivating case: a migration where auth_users.username is an opaque id carried over
// from the old system, so members know only their email address. Proves the email path
// resolves, is case-insensitive when unambiguous, refuses when two addresses differ only
// by case, and that `loginBy: "either"` still accepts the username.
//
// The example app registers `loginEither` (loginBy: "either") and `loginByEmail`
// (loginBy: "email") alongside the default username-only `login`.

import { assert, http, token } from "../lib";

export async function runLoginBy(base: string): Promise<void> {
  const call = http(base, "main");
  const admin = await token("admin", ["admin"]);

  // Seed a member whose username is an opaque id, as a migration would leave it.
  const seeded = await call(
    "seedIdentityUser",
    { username: "lb_00000000-1111-2222-3333-444444444444", email: "Member@Example.com", password: "password123" },
    admin,
  );
  assert(seeded.body.ok, "loginBy: seeded a member keyed by an opaque id");

  // --- the default handler still requires the username ------------------------
  const defaultByEmail = await call("login", { username: "Member@Example.com", password: "password123" });
  assert(defaultByEmail.status === 401, "loginBy: the default login still rejects an email (unchanged behaviour)");
  const defaultByName = await call("login", { username: "lb_00000000-1111-2222-3333-444444444444", password: "password123" });
  assert(defaultByName.body.ok, "loginBy: the default login still accepts the username");

  // --- loginBy: "email" --------------------------------------------------------
  const byEmail = await call("loginByEmail", { username: "Member@Example.com", password: "password123" });
  assert(byEmail.body.ok, "loginBy(email): the email resolves");
  assert(
    byEmail.body.result.user.username === "lb_00000000-1111-2222-3333-444444444444",
    "loginBy(email): the issued session carries the real username, not the email",
  );

  const wrongPw = await call("loginByEmail", { username: "Member@Example.com", password: "wrongpassword" });
  assert(wrongPw.status === 401, "loginBy(email): a wrong password is still rejected");

  const unknown = await call("loginByEmail", { username: "nobody@example.com", password: "password123" });
  assert(unknown.status === 401, "loginBy(email): an unknown email is rejected");

  // Case-insensitive when it can only mean one account.
  const lower = await call("loginByEmail", { username: "member@example.com", password: "password123" });
  assert(lower.body.ok, "loginBy(email): matches case-insensitively when unambiguous");

  // ...and the username is NOT accepted on the email-only handler.
  const nameOnEmailHandler = await call("loginByEmail", {
    username: "lb_00000000-1111-2222-3333-444444444444",
    password: "password123",
  });
  assert(nameOnEmailHandler.status === 401, "loginBy(email): the username is not accepted");

  // --- loginBy: "either" -------------------------------------------------------
  const eitherName = await call("loginEither", { username: "lb_00000000-1111-2222-3333-444444444444", password: "password123" });
  assert(eitherName.body.ok, "loginBy(either): accepts the username");
  const eitherEmail = await call("loginEither", { username: "member@example.com", password: "password123" });
  assert(eitherEmail.body.ok, "loginBy(either): accepts the email");

  // --- ambiguity: two addresses differing only by case -------------------------
  // `unique(email)` is case-sensitive, so both rows can exist. Neither may be chosen.
  const second = await call(
    "seedIdentityUser",
    { username: "lb_99999999-1111-2222-3333-444444444444", email: "MEMBER@example.com", password: "password123" },
    admin,
  );
  assert(second.body.ok, "loginBy: seeded a second address differing only by case");
  const ambiguous = await call("loginByEmail", { username: "member@EXAMPLE.com", password: "password123" });
  assert(ambiguous.status === 401, "loginBy(email): refuses an ambiguous case-insensitive match rather than guessing");
  // An exact match still wins over the ambiguous fallback.
  const exactStillWorks = await call("loginByEmail", { username: "MEMBER@example.com", password: "password123" });
  assert(exactStillWorks.body.ok, "loginBy(email): an exact match is unaffected by the ambiguity");
}
