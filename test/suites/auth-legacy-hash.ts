// @pramen/auth imported-hash verification (registerPasswordVerifier). Proves: a user
// whose stored hash came from another system verifies through the registered verifier,
// a wrong password against that scheme still fails, login UPGRADES the row to PBKDF2 on
// the first successful sign-in (and the upgraded row keeps working), and an unregistered
// scheme fails closed rather than erroring. The example app registers an unsalted
// `sha256` scheme standing in for bcrypt — see registerPasswordVerifier in example/app.ts.
// Runs on the default `main` tenant; usernames are `imp_`-prefixed to stay clear of
// other suites.

import { assert, http, token } from "../lib";

/** Hex SHA-256, matching the verifier the example app registers. */
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function runLegacyHash(base: string): Promise<void> {
  const call = http(base, "main");
  const admin = await token("admin", ["admin"]);

  // --- seed a user exactly as an import script would --------------------------
  const seeded = await call("seedImportedUser", { username: "imp_dana", sha256Hex: await sha256Hex("password123") }, admin);
  assert(seeded.body.ok, "legacy: seeded a user carrying an imported sha256 hash");

  const before = await call("passwordHashScheme", { username: "imp_dana" }, admin);
  assert(before.body.result.scheme === "sha256", "legacy: the seeded row stores the imported scheme");

  // --- a wrong password must still fail, on the imported scheme ---------------
  const wrong = await call("login", { username: "imp_dana", password: "not-the-password" });
  assert(wrong.status === 401, "legacy: wrong password against an imported hash is rejected");
  const stillImported = await call("passwordHashScheme", { username: "imp_dana" }, admin);
  assert(stillImported.body.result.scheme === "sha256", "legacy: a failed login does not rewrite the hash");

  // --- the imported hash verifies and issues a normal session -----------------
  const ok = await call("login", { username: "imp_dana", password: "password123" });
  assert(ok.body.ok && typeof ok.body.result.token === "string", "legacy: an imported hash verifies and logs in");
  const me = await call("me", {}, ok.body.result.token as string);
  assert(me.body.ok && me.body.result?.userId === "imp_dana", "legacy: the issued token verifies like any other");

  // --- ...and the row is upgraded in place ------------------------------------
  const after = await call("passwordHashScheme", { username: "imp_dana" }, admin);
  assert(after.body.result.scheme === "pbkdf2", "legacy: a successful login upgrades the row to PBKDF2");

  // The upgraded row keeps working — the rehash used the same plaintext.
  const again = await call("login", { username: "imp_dana", password: "password123" });
  assert(again.body.ok, "legacy: the upgraded row still logs in with the same password");
  const wrongAfter = await call("login", { username: "imp_dana", password: "not-the-password" });
  assert(wrongAfter.status === 401, "legacy: the upgraded row still rejects a wrong password");

  // --- an unregistered scheme fails closed ------------------------------------
  // Same payload, relabelled to a scheme nobody registered: verifyPassword returns false
  // rather than throwing, so it presents as a bad password (401), not a 500 — and the
  // row is NOT upgraded, because nothing ever verified.
  const orphan = await call(
    "seedImportedUser",
    { username: "imp_orphan", sha256Hex: await sha256Hex("password123"), scheme: "md5" },
    admin,
  );
  assert(orphan.body.ok, "legacy: seeded a user under an unregistered scheme");
  const orphanLogin = await call("login", { username: "imp_orphan", password: "password123" });
  assert(orphanLogin.status === 401, "legacy: an unregistered scheme fails closed (401, not 500)");
  const orphanAfter = await call("passwordHashScheme", { username: "imp_orphan" }, admin);
  assert(orphanAfter.body.result.scheme === "md5", "legacy: a never-verified row is left untouched");
}
