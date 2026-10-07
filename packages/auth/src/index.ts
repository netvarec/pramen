// @pramen/auth: optional credential→JWT login for pramen, so an app can issue
// tokens without a third-party IdP. The core stays verify-only (HS256 against
// AUTH_SECRET, or RS256/JWKS); this package signs HS256 tokens the verifier accepts.
//
// Usage:
//   import { authSchema, authHandlers } from "@pramen/auth";
//   const schema = defineSchema({ ...authSchema, notes: Entity(...) });
//   const { query, mutation } = createApp(schema);
//   const handlers = { ...authHandlers, ...yourHandlers };
//
// signup/login store users in the `auth_users` table and return a bearer token
// (sub = username, roles). Passwords are PBKDF2-hashed (WebCrypto, no deps).
// Requires AUTH_SECRET in the environment (ctx.env). JWKS setups don't use this.
//
// Passwordless magic-link login is also available via createMagicLinkAuth (spread
// magicLinkSchema too). It is transport-agnostic: you supply sendEmail; pramen owns
// the token lifecycle. See createMagicLinkAuth below.

import { Entity, mutation, query, defaultTo, unique, hidden, policy, allow, $identity, BadRequest, Unauthorized, denySession, allowSession, isSystemRole } from "@pramen/server";
import type { AppTaskMap, CellValue, HandlerContext, HandlerMap, JsonObject, JsonValue, Policy, Row } from "@pramen/server";
import { sessionIsFrom, tableClaim, usersTable, type UsersTable } from "./users-table.js";

/** What an auth factory contributes to an app: RPC handlers plus the task handlers
 * that deliver their emails. */
export interface AuthModule {
  handlers: HandlerMap;
  tasks: AppTaskMap;
}

/** Validated signup / login credentials, parsed from the request input. */
interface Credentials {
  username: string;
  password: string;
  email?: string;
}

// --- schema fragment: spread into your defineSchema so the table is migrated ---

export const authSchema = {
  auth_users: Entity((t) => ({
    username: t.textId(), // stable identity / PK (= the JWT `sub`); not the email
    passwordHash: hidden(t.text()), // never readable via the ORM; empty for passwordless users
    roles: t.json(), // string[]
    email: unique(t.text()), // mutable contact email (nullable, unique); the magic-link key
    emailVerified: t.int(), // epoch ms the current `email` was confirmed; NULL = unverified (additive)
    active: defaultTo(t.bool(), true), // deactivation flag; false blocks login (additive, backfills 1)
    createdAt: t.int(),
    // What the identity provider says about the person ({ name, picture } by default), written
    // on every OIDC sign-in and read back by `me`. NULL for users who never signed in through
    // OIDC. Additive: an existing table gains the column on the next migrate.
    profile: t.json(),
  })),
};

// --- base64 / base64url ---

const enc = (s: string) => new TextEncoder().encode(s);
function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s: string) => b64url(enc(s));

// --- password hashing (PBKDF2-SHA256) ---

/** workerd's hard ceiling on PBKDF2 iterations.
 *
 * It does not clamp. It throws:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 600000).
 *
 * Bun, Node and browsers have no such cap, so anything above this passes every local
 * test (including under lopata, which is a Bun runtime) and then fails on the first
 * real deployment. This value is the platform limit, not a tuning knob. */
const PBKDF2_MAX_ITERATIONS = 100_000;

/** Iterations for NEW hashes.
 *
 * OWASP 2026 guidance for PBKDF2-HMAC-SHA256 is ~600k, and this was 600k until it
 * turned out that every signup and login 500s on Workers (see PBKDF2_MAX_ITERATIONS).
 * pramen deploys to workerd, so the platform ceiling is the real bound: WebCrypto there
 * offers no scrypt or argon2 either, making 100k the strongest KDF available.
 *
 * The count (and hash alg) are ENCODED in the stored string,
 * `pbkdf2$sha256$<iters>$<saltB64>$<hashB64>`, and verifyPassword parses them back
 * out, so changing this never breaks verification of an already-stored hash, as long
 * as the stored count is itself within the cap. */
const PBKDF2_ITERATIONS = Math.min(600_000, PBKDF2_MAX_ITERATIONS);
const PBKDF2_HASH = "SHA-256";

/** Derive 256 PBKDF2 bits, turning workerd's iteration-cap rejection into a diagnosis.
 *
 * Hashing can no longer request too many, but VERIFY takes its count from the stored
 * hash, so a row written at 600k by pramen <= 0.0.43, or by a Bun/Node-only
 * deployment sharing a database with a Worker, cannot be verified on Workers at all.
 * That would otherwise surface as `NotSupportedError` from deep inside WebCrypto, or
 * (worse, if a caller swallowed it) as a plain "wrong password" locking the account
 * out with nothing in the logs to explain why. */
async function deriveBits(password: string, salt: Uint8Array, iterations: number, hash: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveBits"]);
  try {
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash }, key, 256));
  } catch (cause) {
    if (iterations > PBKDF2_MAX_ITERATIONS) {
      throw new Error(
        `password hash uses ${iterations} PBKDF2 iterations, above the ${PBKDF2_MAX_ITERATIONS} this runtime allows. `
          + `It was written by pramen <= 0.0.43 or on a runtime without the cap (Bun/Node), and cannot be verified here. `
          + `Reset the affected passwords, or re-import the rows under a foreign scheme (see registerPasswordVerifier).`,
        { cause },
      );
    }
    throw cause;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, PBKDF2_ITERATIONS, PBKDF2_HASH);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(bits)}`;
}

/** Constant-time string compare (avoids leaking the hash via timing). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Parse the self-describing hash string. Supports the current
 * `pbkdf2$sha256$<iters>$<salt>$<hash>` form and the legacy `pbkdf2$<iters>$<salt>$<hash>`
 * (no alg segment). Iterations come FROM the stored string, so raising PBKDF2_ITERATIONS
 * never breaks verification of an already-stored hash. */
function parseStoredHash(stored: string): { iterations: number; hash: string; saltB64: string; hashB64: string } | null {
  const parts = stored.split("$");
  if (parts[0] !== "pbkdf2") return null;
  // 5 parts: pbkdf2 $ sha256 $ iters $ salt $ hash   (current)
  // 4 parts: pbkdf2 $ iters $ salt $ hash            (legacy, implicit sha256)
  const [algSeg, iterStr, saltB64, hashB64] = parts.length === 5 ? parts.slice(1) : ["sha256", ...parts.slice(1)];
  const iterations = Number(iterStr);
  if (!saltB64 || !hashB64 || !Number.isFinite(iterations) || iterations <= 0) return null;
  const hash = algSeg === "sha512" ? "SHA-512" : "SHA-256";
  return { iterations, hash, saltB64, hashB64 };
}

// --- foreign hash schemes (opt-in, for migrating in from another system) -----
//
// Importing users from an existing app means importing hashes that are NOT PBKDF2:
// bcrypt from Contember/Rails, `pbkdf2_sha256$` from Django, and so on. Those cannot be
// converted (that needs the plaintext), so the only alternative would be forcing every
// user to reset their password.
//
// Instead: store the foreign hash under its own scheme prefix (`bcrypt$<payload>`),
// register a verifier for that scheme, and let login UPGRADE it. On the one successful
// login where the plaintext is briefly in hand, the row is rehashed to PBKDF2. The
// scheme deletes itself as users return; nothing has to be migrated ahead of time.
//
// pramen deliberately does NOT bundle an implementation. bcrypt needs a pure-JS library
// (WebCrypto has none) which is real bundle weight, and it is useless to the apps that
// never import anything, so the app supplies it:
//
//   import bcrypt from "bcryptjs";
//   registerPasswordVerifier("bcrypt", (password, payload) => bcrypt.compare(password, payload));
//
// then import rows with `passwordHash = "bcrypt$" + row.password_hash` (a bcrypt hash is
// itself `$2b$10$...`, so the stored value reads `bcrypt$$2b$10$...`).

/** Verify `password` against a foreign hash `payload` (the stored value with its
 * `<scheme>$` prefix already stripped). May be sync or async; throwing counts as a
 * failed verification, never a 500. */
export type PasswordVerifier = (password: string, payload: string) => boolean | Promise<boolean>;

const foreignVerifiers = new Map<string, PasswordVerifier>();

/** Register a verifier for an imported hash scheme. Call once at module scope, before
 * any login can run. `pbkdf2` is built in and cannot be overridden. */
export function registerPasswordVerifier(scheme: string, verify: PasswordVerifier): void {
  if (!scheme || scheme.includes("$")) throw new Error(`invalid hash scheme '${scheme}' (must be non-empty and contain no '$')`);
  if (scheme === "pbkdf2") throw new Error("'pbkdf2' is built in and cannot be overridden");
  foreignVerifiers.set(scheme, verify);
}

/** True if `stored` is a foreign (non-PBKDF2) hash, i.e. one that login should upgrade
 * after a successful verify. Also true for an unparseable value, which never verifies. */
export function isForeignHash(stored: string): boolean {
  return stored.split("$")[0] !== "pbkdf2";
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const scheme = stored.split("$")[0];
  if (scheme !== "pbkdf2") {
    const verify = foreignVerifiers.get(scheme);
    // Unknown scheme (including the empty passwordHash of a passwordless user) never
    // verifies, the same as before this feature existed.
    if (!verify) return false;
    try {
      return await verify(password, stored.slice(scheme.length + 1));
    } catch {
      // A broken/garbage payload must fail closed, not surface as a 500 that
      // distinguishes it from a wrong password.
      return false;
    }
  }
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const bits = await deriveBits(password, unb64(parsed.saltB64), parsed.iterations, parsed.hash);
  return constantTimeEqual(b64(bits), parsed.hashB64);
}

// A fixed placeholder hash (current params), computed once and reused, so a login for a
// NON-EXISTENT username can still run a full PBKDF2 verify. That equalizes the timing of
// the "no such user" and "wrong password" paths (neither short-circuits) closing the
// user-existence timing oracle. Lazily initialized (top-level await isn't available here).
let dummyHashPromise: Promise<string> | undefined;
function dummyPasswordHash(): Promise<string> {
  return (dummyHashPromise ??= hashPassword("pramen-login-timing-equalizer-placeholder"));
}

// --- HS256 token signing (matches the verifier in @pramen/server auth.ts) ---

export async function signToken(
  claims: JsonObject,
  secret: string,
  opts: { ttlSeconds?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlStr(JSON.stringify({ iat: now, exp: now + (opts.ttlSeconds ?? 3600), ...claims }));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

// --- handlers ---

function secretOf(ctx: HandlerContext): string {
  const s = ctx.env.AUTH_SECRET;
  if (typeof s !== "string" || s.length === 0) throw new Error("@pramen/auth: AUTH_SECRET is not configured");
  return s;
}

const DEFAULT_ROLES = ["user"];
const TOKEN_TTL_SECONDS = 3600;

/** Session-token lifetime: AUTH_SESSION_TTL_SECONDS from the env (a deployment can
 * shorten it to tighten the deactivation/role-change window), else 1h. */
function sessionTtlOf(ctx: HandlerContext): number {
  const v = Number(ctx.env.AUTH_SESSION_TTL_SECONDS);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : TOKEN_TTL_SECONDS;
}

/** A permissive email shape check (one `@`, a dot in the domain). The single source of
 * truth for `parseEmail` and the optional email at signup. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function parseCreds(raw: JsonValue): Credentials {
  const o = (raw ?? {}) as JsonObject;
  if (typeof o.username !== "string" || o.username.length === 0) throw new Error("username is required");
  if (typeof o.password !== "string" || o.password.length < 8) throw new Error("password must be at least 8 characters");
  // Optional contact email at signup, validated + normalized when present, so password
  // reset and email verification work without a separate changeEmail round-trip. Absent ⇒
  // the row's email stays NULL (still allowed; the user can set it later).
  let email: string | undefined;
  if (o.email !== undefined && o.email !== null && o.email !== "") {
    const e = String(o.email).trim().toLowerCase();
    if (!EMAIL_RE.test(e)) throw new Error("a valid email is required");
    email = e;
  }
  return { username: o.username, password: o.password, email };
}

/** Build the `refreshSession` handler: an AUTHENTICATED mutation that re-reads the caller's
 * `roles` + `active` from the users table (keyed on `username` = the JWT `sub`) and reissues a
 * fresh token with the configured session TTL: the same `{ token, user }` shape as `login`.
 * Throws Unauthorized if the row is gone or the account is deactivated (the `isActive` helper).
 *
 * Why it exists: the core is stateless verify-only, so roles/active are baked into a token at
 * login. refreshSession lets a client (1) silently refresh at ~half-TTL, so AUTH_SESSION_TTL_SECONDS
 * can be kept SHORT (bounded revocation lag) without logging the user out; and (2) pick up a role
 * GRANT immediately (e.g. right after a subscription checkout flips the role) with no re-login.
 * Shared by password users (`authHandlers`) and magic-link users (`createMagicLinkAuth`): both
 * store the row in the same authSchema-shaped table keyed on the immutable `username`. `ttlOf`
 * supplies each factory's own configured TTL. */
function buildRefreshSession(ttlOf: (ctx: HandlerContext) => number, table: UsersTable) {
  return mutation(
    async (ctx) => {
      const userId = requireOwnUser(ctx, table);
      const rows = await ctx.db.exec(`SELECT username, roles, active FROM ${table.sql} WHERE username = ? LIMIT 1`, userId);
      const u = rows[0];
      // Gone or deactivated ⇒ no fresh token (mirrors login). The Worker denylist already
      // fails a deactivated user's outstanding token closed; this ensures refresh can't
      // launder a revoked session into a new, longer-lived one either.
      if (!u || !isActive(u.active)) throw new Unauthorized("session is no longer valid");
      const roles = JSON.parse(String(u.roles)) as string[];
      const token = await signToken({ sub: String(u.username), roles, ...tableClaim(table) }, secretOf(ctx), { ttlSeconds: ttlOf(ctx) });
      return { token, user: { username: String(u.username), roles } };
    },
    { auth: "authenticated" },
  );
}

export interface AuthHandlerOptions {
  /** Users table, default `auth_users`. Pass the same table as `createOidcAuth` and
   * `createUserHandlers`; it must have the `authSchema.auth_users` shape. */
  table?: string;
  /** Which column `login` resolves the submitted identifier against.
   *
   * - `"username"` (default): the PK only, the historical behaviour.
   * - `"email"`: the email column only. For apps where the username is an opaque id
   *   (a migrated tenant identity, say) and members know only their email address.
   * - `"either"`: username first (it is the PK, so it cannot be ambiguous), then email.
   *   Use when two populations coexist: migrated members keyed by an opaque id, and
   *   newer accounts that signed up with their email as the username.
   *
   * Email lookup tries an exact match, then falls back to a case-insensitive one, but
   * ONLY when that matches exactly one row, so a pair of addresses differing just by
   * case can never resolve to an arbitrary account. */
  loginBy?: "username" | "email" | "either";
}

/**
 * The caller's stored OIDC profile (see `profile` in {@link authSchema}), or `null`.
 *
 * Never throws: `me` is how the editor learns that a session is real, so a deployment whose
 * identities do not live in `auth_users` (an external JWT, a table without the column yet)
 * must still get its identity back, just without a profile.
 */
async function readProfile(ctx: HandlerContext, username: string, table: UsersTable): Promise<JsonObject | null> {
  if (!sessionIsFrom(ctx, table)) return null;
  try {
    const rows = (await ctx.db.exec(`SELECT profile FROM ${table.sql} WHERE username = ? LIMIT 1`, username)) as Row[];
    return parseProfile(rows[0]?.profile);
  } catch {
    return null;
  }
}

/** A `profile` cell as an object, or `null`. The column is JSON text on SQLite; a value that is
 * not an object (a hand-edited row, a future shape) is treated as no profile. */
export function parseProfile(cell: unknown): JsonObject | null {
  let value = cell;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

/** Build signup / login / me / refreshSession. Roles are assigned server-side (default
 * `["user"]`): the client never picks its own roles. Spread into your handler map. */
export function createAuthHandlers(opts: AuthHandlerOptions = {}) {
  const table = usersTable(opts.table);
  const loginBy = opts.loginBy ?? "username";

  /** Resolve the submitted identifier to a row, per `loginBy`. Returns undefined when
   * nothing matches; the caller still runs a dummy verify so the timing is flat. */
  async function findLoginRow(ctx: HandlerContext, identifier: string): Promise<Row | undefined> {
    const cols = `SELECT username, passwordHash, roles, active FROM ${table.sql}`;
    if (loginBy !== "email") {
      const byName = await ctx.db.exec(`${cols} WHERE username = ? LIMIT 1`, identifier);
      if (byName[0]) return byName[0];
      if (loginBy === "username") return undefined;
    }
    const exact = await ctx.db.exec(`${cols} WHERE email = ? LIMIT 1`, identifier);
    if (exact[0]) return exact[0];
    // Case-insensitive fallback, accepted only when unambiguous: `unique(email)` is
    // case-SENSITIVE, so two rows may differ only by case and neither may be picked
    // arbitrarily.
    const loose = await ctx.db.exec(`${cols} WHERE lower(email) = lower(?) LIMIT 2`, identifier);
    return loose.length === 1 ? loose[0] : undefined;
  }

  return {
    // NOTE on username enumeration: signup returns a distinct "username is taken" error,
    // which is an enumeration oracle. This is INHERENT to systems where the username is a
    // user-chosen, publicly-visible identifier: the caller learns "taken" the moment the
    // name shows up anywhere, so hiding it at signup buys little. What we CAN close is the
    // timing side channel: both the taken and the available paths run the same expensive
    // PBKDF2 hash before responding, so response time doesn't leak which path was taken.
    // The enumeration-SAFE flow is the passwordless / magic-link path (createMagicLinkAuth),
    // which keys on the email and always returns the same `{ ok: true }`.
    signup: mutation(
      async (ctx, input: { username: string; password: string; email?: string }) => {
        const existing = await ctx.db.exec(`SELECT 1 FROM ${table.sql} WHERE username = ? LIMIT 1`, input.username);
        if (existing.length > 0) {
          // Equalize timing with the available path (which hashes below) so the taken vs.
          // available decision isn't a fast timing oracle on top of the response-body one.
          await hashPassword(input.password);
          throw new BadRequest("username is taken");
        }
        // A supplied email must be free (the column is unique). Same clean-400 shape as
        // changeEmail rather than surfacing the DB constraint as a 500.
        if (input.email) {
          const emailTaken = await ctx.db.exec(`SELECT 1 FROM ${table.sql} WHERE email = ? LIMIT 1`, input.email);
          if (emailTaken.length > 0) throw new BadRequest("email already in use");
        }
        const roles = DEFAULT_ROLES;
        const passwordHash = await hashPassword(input.password);
        // Signup stores the email UNVERIFIED (emailVerified NULL). The app confirms it via
        // createEmailVerification (requestEmailVerification runs right after signup, when the
        // client already holds the returned session token).
        await ctx.db.exec(
          `INSERT INTO ${table.sql} (username, passwordHash, roles, email, createdAt) VALUES (?, ?, ?, ?, ?)`,
          input.username,
          passwordHash,
          JSON.stringify(roles),
          input.email ?? null,
          Date.now(),
        );
        const token = await signToken({ sub: input.username, roles, ...tableClaim(table) }, secretOf(ctx), { ttlSeconds: sessionTtlOf(ctx) });
        return { token, user: { username: input.username, roles, email: input.email ?? null } };
      },
      { input: parseCreds },
    ),

    login: mutation(
      async (ctx, input: { username: string; password: string }) => {
        const u = await findLoginRow(ctx, input.username);
        if (!u) {
          // No such user: still run a full PBKDF2 verify against a fixed dummy hash so the
          // not-found path costs the same as a wrong-password path, so there is no timing oracle that
          // distinguishes "unknown username" from "bad password".
          await verifyPassword(input.password, await dummyPasswordHash());
          throw new Unauthorized("invalid username or password");
        }
        if (!(await verifyPassword(input.password, String(u.passwordHash)))) {
          throw new Unauthorized("invalid username or password");
        }
        // Only after the password verifies (so this can't enumerate accounts): a
        // deactivated user gets no new token. Existing tokens expire within the TTL.
        if (!isActive(u.active)) throw new Unauthorized("account is deactivated");
        // Upgrade an imported foreign hash (see registerPasswordVerifier). This is the one
        // moment the plaintext is in hand for a user whose hash predates pramen, so rehash
        // to PBKDF2 and drop the old scheme. Deliberately AFTER the active check, so a
        // deactivated account is never rewritten. Best-effort: a failed upgrade must not
        // fail an otherwise valid login: the row simply upgrades on a later attempt.
        if (isForeignHash(String(u.passwordHash))) {
          try {
            await ctx.db.exec(
              `UPDATE ${table.sql} SET passwordHash = ? WHERE username = ?`,
              await hashPassword(input.password),
              String(u.username),
            );
          } catch {
            /* keep the legacy hash; the next login retries */
          }
        }
        const roles = JSON.parse(String(u.roles)) as string[];
        const token = await signToken({ sub: String(u.username), roles, ...tableClaim(table) }, secretOf(ctx), { ttlSeconds: sessionTtlOf(ctx) });
        return { token, user: { username: String(u.username), roles } };
      },
      { input: parseCreds },
    ),

    me: query(async (ctx) => {
      const identity = ctx.identity;
      // Anonymous stays exactly what it was: the editor reads a missing identity as "this
      // session is not real", and an object with a `profile` key would look like one.
      const userId = identity?.userId;
      if (typeof userId !== "string" || userId === "") return identity;
      return { ...identity, profile: await readProfile(ctx, userId, table) };
    }),

    // Re-read roles/active for the caller and reissue a token at the env-configured session
    // TTL (AUTH_SESSION_TTL_SECONDS). Lets a short TTL bound revocation lag without logging
    // the user out, and picks up role grants without re-login. See buildRefreshSession.
    refreshSession: buildRefreshSession(sessionTtlOf, table),
  };
}

/** Default handlers: login resolves by username only (the historical behaviour). */
export const authHandlers = createAuthHandlers();

// --- magic link (passwordless) login ---------------------------------------
//
// A one-time, single-use, time-boxed link emailed to the user. The flow is two
// anonymous mutations:
//   requestMagicLink({ email })  -> revokes any pending link, records a pending request
//                                   and enqueues the send task, which mints a token,
//                                   persists its HASH + expiry and calls your sendEmail.
//                                   Always returns { ok: true }
//                                   (no account enumeration: the response is the
//                                   same whether or not the email has an account).
//   loginWithMagicLink({ token }) -> validates the token (unexpired, unconsumed),
//                                   consumes it, find-or-creates the auth_users row
//                                   (passwordless: empty passwordHash never verifies),
//                                   and returns the same { token, user } as login.
//
// The emailed user is keyed by email in the `username` column, so a magic-link user
// and a password user with the same handle are the same row. Tokens are stored only
// as a SHA-256 hash, so a DB leak never exposes a live link.

// Spread alongside authSchema so the link table is migrated.
export const magicLinkSchema = {
  auth_magic_links: Entity((t) => ({
    tokenHash: t.textId(), // PK = sha256(token); the raw token only ever leaves via email
    email: t.text(),
    expiresAt: t.int(), // epoch ms
    consumedAt: t.int(), // epoch ms; NULL until redeemed (single-use)
    createdAt: t.int(),
    requestId: t.text(), // the request this link answers; its send task finds the row by it
    sentAt: t.int(), // epoch ms the email went out; NULL while pending
  })),
};

// One-time email-token table shared by password reset AND email verification (spread it
// once if you use EITHER `createPasswordReset` or `createEmailVerification`). Rows are
// discriminated by `purpose` ("reset" | "verify"); only a SHA-256 hash of the token is
// stored, so a DB leak never exposes a live token. `username` binds the token to the
// account it acts on; `email` pins the address it was minted for (verification rejects a
// token whose address the user has since changed).
export const emailTokenSchema = {
  auth_email_tokens: Entity((t) => ({
    tokenHash: t.textId(), // PK = sha256(token)
    purpose: t.text(), // "reset" | "verify"
    username: t.text(), // the account (JWT sub) the token acts on
    email: t.text(), // the address at mint time
    expiresAt: t.int(), // epoch ms
    consumedAt: t.int(), // epoch ms; NULL until redeemed (single-use)
    createdAt: t.int(),
    requestId: t.text(), // the request this token answers; its send task finds the row by it
    sentAt: t.int(), // epoch ms the email went out; NULL while pending
  })),
};

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 256 bits of entropy, url-safe: the raw link token. */
function mintToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

// --- emailed tokens: minted by the send task, never at rest in the outbox (#73) ---------
//
// A task payload sits in `_pramen_outbox` as plain JSON (and in every backup of it), so a
// raw token passed through it would undo hashing the token row. The request instead writes
// a PENDING row under a random `requestId` and enqueues only that id, which is no secret.
// The send task mints the token and claims ITS OWN row with it, so:
//  - a request that was superseded (a newer request deleted its row) or made moot (reset
//    done, email verified) finds no row and sends nothing;
//  - a redelivery after a successful send sees `sentAt` and sends nothing, so the link
//    already in the inbox stays the live one (delivery is at-least-once);
//  - a retry after a FAILED send re-mints over its own row only, never a newer request's;
//  - two drainers running the same task race on one conditional UPDATE, and one wins.
// A pending row's `tokenHash` is `pending:<requestId>`, which no sha256 hex digest can
// equal, so it is never redeemable.

type TokenTable = "auth_magic_links" | "auth_email_tokens";

const pendingHash = (requestId: string): string => `pending:${requestId}`;

/** Mint the token for `requestId` and claim its row with the hash, or return null when the
 * request is gone or already delivered. The caller sends, then calls `markSent`. */
async function mintForRequest(ctx: HandlerContext, table: TokenTable, requestId: string, expiresAt: number): Promise<string | null> {
  const rows = await ctx.db.exec(`SELECT tokenHash, sentAt FROM ${table} WHERE requestId = ? LIMIT 1`, requestId);
  const row = rows[0];
  if (!row || row.sentAt != null) return null;
  const token = mintToken();
  const claimed = await ctx.db.exec(
    `UPDATE ${table} SET tokenHash = ?, expiresAt = ? WHERE requestId = ? AND tokenHash = ? AND sentAt IS NULL RETURNING requestId`,
    await sha256Hex(token),
    expiresAt,
    requestId,
    row.tokenHash,
  );
  return claimed.length > 0 ? token : null;
}

async function markSent(ctx: HandlerContext, table: TokenTable, requestId: string): Promise<void> {
  await ctx.db.exec(`UPDATE ${table} SET sentAt = ? WHERE requestId = ?`, Date.now(), requestId);
}

/** A payload enqueued by 0.0.76 or earlier still carries the raw token and no requestId.
 * Deliver it exactly as the old task did, but only while its row is still live, so a
 * request superseded or redeemed since is not resent. The plaintext stays in that outbox
 * row until the drainer prunes it (a dead-lettered row is never pruned). */
async function legacyTokenIsLive(ctx: HandlerContext, table: TokenTable, token: string): Promise<boolean> {
  const rows = await ctx.db.exec(`SELECT expiresAt, consumedAt FROM ${table} WHERE tokenHash = ? LIMIT 1`, await sha256Hex(token));
  const row = rows[0];
  return !!row && row.consumedAt == null && Number(row.expiresAt) >= Date.now();
}

interface SendPayload {
  email: string;
  username?: string;
  requestId?: string;
  token?: string;
}

function parseEmail(raw: JsonValue): { email: string } {
  const o = (raw ?? {}) as JsonObject;
  const email = typeof o.email === "string" ? o.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) throw new BadRequest("a valid email is required");
  return { email };
}

function parseLinkToken(raw: JsonValue): { token: string } {
  const o = (raw ?? {}) as JsonObject;
  if (typeof o.token !== "string" || o.token.length === 0) throw new BadRequest("token is required");
  return { token: o.token };
}

export interface MagicLinkOptions {
  /** Deliver the link to the recipient. Receives the handler ctx and the raw token, so
   * build the URL however your app routes it, e.g. `${ctx.env.APP_URL}/auth?token=${token}`.
   * On Cloudflare the recommended transport is Cloudflare Email Sending: a
   * `send_email` binding (no API keys), e.g.
   * `await (ctx.env.EMAIL as SendEmail).send({ to, from: { email, name }, subject, text, html })`
   * (see example/app.ts + oblaka.ts). Called from the `sendMagicLinkEmail` TASK, not
   * inline in the mutation, since a slow SMTP/API call can't hold the mutation's storage
   * transaction open and time the store out. Retries follow the outbox retry policy;
   * a permanent failure dead-letters the task and the token expires unused (users just
   * request a new link). */
  sendEmail: (ctx: HandlerContext, args: { email: string; token: string }) => void | Promise<void>;
  /** How long the emailed link stays valid, in seconds. Default 900 (15 min). */
  linkTtlSeconds?: number;
  /** TTL of the session JWT minted on successful login, in seconds. Default 3600 (1h). */
  sessionTtlSeconds?: number;
  /** Roles assigned when a magic-link login first creates the user. Default `["user"]`. */
  defaultRoles?: string[];
  /** Users table, default `auth_users`. Pass the same `table` as `createAuthHandlers`: both
   * export a `refreshSession`, and whichever is spread last serves every caller. */
  table?: string;
}

/** Build the `requestMagicLink` / `loginWithMagicLink` handler pair, plus the
 * `sendMagicLinkEmail` task handler that actually invokes `opts.sendEmail`.
 *
 * ```
 * const magicLink = createMagicLinkAuth({ sendEmail: ... });
 * const handlers = { ...cmsHandlers, ...authHandlers, ...magicLink.handlers };
 * const tasks    = { ...cmsTasks,    ...magicLink.tasks };
 * ```
 *
 * The `requestMagicLink` handler revokes any pending link and ENQUEUES a task (atomic
 * with the write via the transactional outbox); the drainer runs `sendMagicLinkEmail`
 * AFTER commit, outside the mutation's storage transaction, and that task mints the
 * token, so it is never at rest in the outbox. This avoids the class
 * of failure where a slow SMTP/API call holds the storage lock long enough for the
 * store to time out and reset the underlying object.
 *
 * You MUST spread `magicLink.tasks` into your app's task map. Without it, no link
 * is ever minted and the email never sends (the drainer retries then dead-letters).
 * Both handlers are anonymous and gate nothing; the token is the capability. */
export function createMagicLinkAuth(opts: MagicLinkOptions): AuthModule {
  const linkTtlMs = (opts.linkTtlSeconds ?? 900) * 1000;
  const sessionTtl = opts.sessionTtlSeconds ?? TOKEN_TTL_SECONDS;
  const defaultRoles = opts.defaultRoles ?? DEFAULT_ROLES;
  const table = usersTable(opts.table);

  /** Revoke every link for `email` (only the latest request works), record the new
   * request as pending and enqueue its send. The task mints the token (see above). */
  async function requestLink(ctx: HandlerContext, email: string): Promise<void> {
    const requestId = crypto.randomUUID();
    const now = Date.now();
    await ctx.db.exec("DELETE FROM auth_magic_links WHERE email = ?", email);
    await ctx.db.exec(
      "INSERT INTO auth_magic_links (tokenHash, email, expiresAt, createdAt, requestId) VALUES (?, ?, ?, ?, ?)",
      pendingHash(requestId),
      email,
      now + linkTtlMs,
      now,
      requestId,
    );
    await ctx.tasks.enqueue({ kind: "sendMagicLinkEmail", payload: { email, requestId } });
  }

  const handlers: HandlerMap = {
    // Silent token refresh for magic-link users (keyed on username). Reissues at this
    // factory's configured session TTL. Shared implementation with authHandlers: when both
    // are spread into one app, the one spread last serves every caller, which is why both
    // take the same `table`.
    refreshSession: buildRefreshSession(() => sessionTtl, table),

    /** Admin-only: create a passwordless user with the given roles (defaults if omitted)
     * and email them a fresh magic link. Idempotent: inviting an existing user just
     * resends the link and leaves their roles alone (admin uses setUserRoles for changes).
     * Piggybacks on the sendMagicLinkEmail task, so the send happens outside the
     * mutation's storage transaction. */
    inviteUser: mutation(
      async (ctx, input: { email: string; roles?: string[] }) => {
        const { email } = parseEmail(input);
        const roles =
          Array.isArray(input?.roles) && input.roles.every((r) => typeof r === "string" && r.length > 0)
            ? input.roles
            : defaultRoles;
        const now = Date.now();
        // Existence check on username (== email, per magic-link convention); a re-invite
        // MUST NOT overwrite roles; that's setUserRoles's job.
        const existing = await ctx.db.exec(`SELECT username FROM ${table.sql} WHERE username = ? LIMIT 1`, email);
        if (existing.length === 0) {
          // Same shape as loginWithMagicLink's find-or-create path: username-only, no
          // `email` column set (it stays a pure contact attribute, set via changeEmail).
          await ctx.db.exec(
            `INSERT INTO ${table.sql} (username, passwordHash, roles, active, createdAt) VALUES (?, ?, ?, ?, ?)`,
            email,
            "",
            JSON.stringify(roles),
            1,
            now,
          );
        }
        // Reuse magic-link machinery so login flow is identical whether the user was
        // self-signed-up or admin-invited.
        await requestLink(ctx, email);
        return { ok: true, created: existing.length === 0 };
      },
      { auth: ["admin"] },
    ),

    requestMagicLink: mutation(
      async (ctx, input: { email: string }) => {
        await requestLink(ctx, input.email);
        return { ok: true };
      },
      { input: parseEmail },
    ),

    loginWithMagicLink: mutation(
      async (ctx, input: { token: string }) => {
        const tokenHash = await sha256Hex(input.token);
        const rows = await ctx.db.exec(
          "SELECT email, expiresAt, consumedAt FROM auth_magic_links WHERE tokenHash = ? LIMIT 1",
          tokenHash,
        );
        const link = rows[0];
        if (!link || link.consumedAt != null || Number(link.expiresAt) < Date.now()) {
          throw new Unauthorized("invalid or expired link");
        }
        // Single-use: consume before issuing the session.
        await ctx.db.exec("UPDATE auth_magic_links SET consumedAt = ? WHERE tokenHash = ?", Date.now(), tokenHash);

        const email = String(link.email);
        // Key on the USERNAME (the immutable identity = the JWT sub), NOT the mutable
        // `email` column: a magic-link user's username IS their email address, so this
        // both matches existing users and avoids resolving login by a mutable, unverified
        // field (which would let a changeEmail squat another address, and would miss
        // pre-`email`-column users on upgrade, colliding on the username PK).
        const existing = await ctx.db.exec(`SELECT roles, active FROM ${table.sql} WHERE username = ? LIMIT 1`, email);
        let roles: string[];
        if (existing.length > 0) {
          if (!isActive(existing[0].active)) throw new Unauthorized("account is deactivated");
          roles = JSON.parse(String(existing[0].roles)) as string[];
        } else {
          roles = defaultRoles;
          // No email column set: it stays a pure contact attribute (set via changeEmail),
          // so a new passwordless user can never collide with a password user's contact email.
          await ctx.db.exec(
            `INSERT INTO ${table.sql} (username, passwordHash, roles, createdAt) VALUES (?, ?, ?, ?)`,
            email,
            "",
            JSON.stringify(roles),
            Date.now(),
          );
        }
        const token = await signToken({ sub: email, roles, ...tableClaim(table) }, secretOf(ctx), { ttlSeconds: sessionTtl });
        return { token, user: { username: email, roles } };
      },
      { input: parseLinkToken },
    ),
  };

  const tasks: AppTaskMap = {
    sendMagicLinkEmail: async (ctx, payload) => {
      const { email, requestId, token: legacy } = payload as SendPayload;
      if (requestId === undefined) {
        if (legacy !== undefined && (await legacyTokenIsLive(ctx, "auth_magic_links", legacy))) await opts.sendEmail(ctx, { email, token: legacy });
        return;
      }
      const token = await mintForRequest(ctx, "auth_magic_links", requestId, Date.now() + linkTtlMs);
      if (token === null) return;
      await opts.sendEmail(ctx, { email, token });
      await markSent(ctx, "auth_magic_links", requestId);
    },
  };

  return { handlers, tasks };
}

// --- user management ---------------------------------------------------------
//
// Admin + self-service operations over `auth_users`, built the pramen way: ordinary
// handlers over `ctx.db` whose authorization is the ACL, not imperative `if (admin)`
// checks. They are inert until you grant access: spread `authPolicies()` into your
// roles (admin manages everyone; the authenticated user manages only itself). Because
// the admin read policy restricts `fields`, `passwordHash` is never projected back.
//
// Roles are baked into the JWT at login, so the core is stateless verify-only. Two
// mechanisms close the gap that leaves, without a session store:
//  - `refreshSession` (authHandlers / createMagicLinkAuth): an authenticated caller
//    re-reads roles/active and gets a fresh token. A client refreshing at ~half-TTL lets
//    AUTH_SESSION_TTL_SECONDS (default 3600) stay short, bounding how long a stale
//    setUserRoles/setUserActive lingers, and picks up a role GRANT immediately (no re-login).
//  - KV denylist (HARD revocation, independent of TTL): setUserActive(false) and deleteUser
//    write an `authDenied:<username>` entry via `denySession(ctx.kv, …)`; the core Worker
//    checks `isSessionDenied` right after resolving identity and fails a revoked token closed
//    (401), so a deactivate/delete takes effect on the NEXT request, not the next login. The
//    entry self-expires at the session TTL (the list never grows); reactivation lifts it
//    (`allowSession`). `denySession`/`allowSession`/`isSessionDenied` are exported from
//    @pramen/server so an app can revoke on its own compromise signals too.

/** SQLite has no bool: `active` is stored 0/1 (NULL on a pre-column row = active). */
function isActive(v: CellValue): boolean {
  return v == null || Number(v) !== 0;
}

function requireUserId(ctx: HandlerContext): string {
  const id = ctx.identity?.userId;
  if (typeof id !== "string" || id.length === 0) throw new Unauthorized("authentication required");
  return id;
}

/** The caller's username, for a handler that acts on the caller's OWN row in `table`. A session
 * minted from another users table names a different person who shares the username, so it is
 * refused rather than let act on (or be reissued from) this table's row. */
function requireOwnUser(ctx: HandlerContext, table: UsersTable): string {
  const id = requireUserId(ctx);
  if (!sessionIsFrom(ctx, table)) throw new Unauthorized("session is no longer valid");
  return id;
}

// `ctx.db` is schema-typed against the *app's* composed schema, which this package
// can't import, so address the users table through a minimal structural view of the
// ACL'd Db. This is the same ctx.db at runtime: row-scope + field projection still apply.
interface UsersDb {
  update(table: string, id: string, patch: Row): Promise<Row | undefined>;
  delete(table: string, id: string): Promise<boolean>;
}
const usersDb = (ctx: HandlerContext): UsersDb => ctx.db as UsersDb;

/** Build admin + self-service handlers over a users table (default `auth_users`).
 * Pass `table` to operate over your OWN authSchema-shaped table (e.g. one with an
 * extra `tenants` column) without renaming it: the handlers manage username/roles/
 * email/active/delete and ignore any extra columns. Spread the result into your
 * handler map and gate it with the matching `authPolicies({ table })`. The table must
 * have a `username` primary key and (for changeEmail/changePassword) `email`/
 * `passwordHash` columns. */
export function createUserHandlers(opts: { table?: string } = {}) {
  const users = usersTable(opts.table);
  const table = users.name;
  return {
    /** Admin: list users (ACL projects out passwordHash). A non-admin caller granted
     * only the self policy sees just their own row; ungranted callers get a 403. */
    listUsers: query(async (ctx, input: { limit?: number; offset?: number }) => {
      const limit = Math.min(Math.max(Math.trunc(Number(input?.limit ?? 50)) || 50, 1), 200);
      const offset = Math.max(Math.trunc(Number(input?.offset ?? 0)) || 0, 0);
      return ctx.db.find({ from: table, orderBy: { column: "createdAt", dir: "desc" }, limit, offset });
    }),

    /** Admin: replace a user's roles. The ACL admin update policy permits writing
     * `roles`; a self-only caller can't (so this is admin-gated declaratively). */
    setUserRoles: mutation(async (ctx, input: { username: string; roles: string[] }) => {
      if (typeof input?.username !== "string" || input.username.length === 0) throw new BadRequest("username is required");
      if (!Array.isArray(input.roles) || !input.roles.every((r) => typeof r === "string" && r.length > 0)) {
        throw new BadRequest("roles must be a non-empty string[]");
      }
      // A SYSTEM role (`__`-prefixed) is reserved for calls the Worker makes to itself: it
      // gates handlers that write roles and bypass the row ACL. The token verifier already
      // strips these, so granting one would do nothing; refusing is the honest answer rather
      // than storing a role that silently never takes effect.
      const reserved = input.roles.filter(isSystemRole);
      if (reserved.length > 0) {
        throw new BadRequest(`roles reserved for the server cannot be granted: ${reserved.join(", ")}`);
      }
      const updated = await usersDb(ctx).update(table, input.username, { roles: input.roles });
      if (!updated) throw new BadRequest("user not found"); // (or out of the caller's update scope)
      return updated;
    }),

    /** Admin: activate / deactivate a user. Deactivating blocks future logins AND
     * refreshSession, AND revokes OUTSTANDING tokens immediately via the KV denylist (the
     * Worker fails them closed), so revocation no longer waits out the token TTL. The
     * denylist entry self-expires at the session TTL. Reactivating LIFTS the entry (it is
     * username-scoped, so a stale entry would otherwise lock out even a fresh login). */
    setUserActive: mutation(async (ctx, input: { username: string; active: boolean }) => {
      if (typeof input?.username !== "string" || input.username.length === 0) throw new BadRequest("username is required");
      if (typeof input?.active !== "boolean") throw new BadRequest("active must be a boolean");
      if (input.active === false && input.username === ctx.identity?.userId) {
        throw new BadRequest("cannot deactivate your own account");
      }
      const updated = await usersDb(ctx).update(table, input.username, { active: input.active });
      if (!updated) throw new BadRequest("user not found");
      // KV is not part of the mutation's transaction, so do it after the update succeeds.
      if (input.active === false) await denySession(ctx.kv, input.username, sessionTtlOf(ctx));
      else await allowSession(ctx.kv, input.username);
      return updated;
    }),

    /** Admin: permanently delete a user. ACL-gated by the admin delete policy; a caller
     * cannot delete their own account. Deactivation (setUserActive) is usually preferable. */
    deleteUser: mutation(async (ctx, input: { username: string }) => {
      if (typeof input?.username !== "string" || input.username.length === 0) throw new BadRequest("username is required");
      if (input.username === ctx.identity?.userId) throw new BadRequest("cannot delete your own account");
      const deleted = await usersDb(ctx).delete(table, input.username);
      if (!deleted) throw new BadRequest("user not found");
      // Revoke any outstanding tokens for the now-deleted user (self-expires at the TTL).
      await denySession(ctx.kv, input.username, sessionTtlOf(ctx));
      return { ok: true };
    }),

    /** Self-service: change the caller's contact email. The ACL self policy scopes the
     * write to the caller's own row and permits only the `email` field. Email is unique,
     * so a clash is reported as a clean 400 rather than surfacing the DB constraint as a 500. */
    changeEmail: mutation(async (ctx, input: { email: string }) => {
      const userId = requireOwnUser(ctx, users);
      const { email } = parseEmail(input); // validates + normalizes; 400 on a bad address
      const taken = await ctx.db.exec(`SELECT 1 FROM ${users.sql} WHERE email = ? AND username != ? LIMIT 1`, email, userId);
      if (taken.length > 0) throw new BadRequest("email already in use");
      const updated = await usersDb(ctx).update(table, userId, { email });
      if (!updated) throw new Unauthorized("authentication required");
      // The new address is UNVERIFIED, so clear any prior verification so `emailVerified`
      // never claims an unconfirmed address. Raw (ACL-bypassing) but self-scoped by the
      // verified identity, and it only ever CLEARS the flag (routing it through the self
      // update policy would instead let a user set their own verified state). Any pending
      // verify token for the old address is now dead (verifyEmail's current-email guard).
      await ctx.db.exec(`UPDATE ${users.sql} SET emailVerified = NULL WHERE username = ?`, userId);
      return { ...updated, emailVerified: null };
    }),

    /** Self-service: set or change the caller's password. A credential op: it reads the
     * caller's OWN hash (passwordHash is never ACL-readable) and writes the new one.
     * Self-scoped by the verified identity, so it never touches another row.
     *
     * TWO cases, one rule: **an empty password slot may be filled by the session; a filled
     * one may only be replaced by proving you know it.**
     *
     * - The account HAS a password → `currentPassword` must verify. Unchanged.
     * - The account has NONE (every magic-link / invited user: `inviteUser` and
     *   `loginWithMagicLink` both leave `passwordHash` empty) → `currentPassword` is
     *   ignored and the new one is set. `firstPassword: true` says which happened.
     *
     * That second branch used to be a rejection, and it made "I signed in with a link and
     * now I want a password" IMPOSSIBLE from an authenticated session: the account was
     * asked for a credential it had never had, and told the one it invented was "incorrect".
     * The only way through was the password-RESET email, a flow named for a problem the
     * user does not have, on a page they have to be told about.
     *
     * The security question is whether a session alone should be able to mint a durable
     * credential, and the answer here is yes, for this case only:
     *
     * - The session was itself minted by an emailed capability (the magic link), which is
     *   the same proof a reset link carries. The reset link is only fresher.
     * - The holder of that session already has everything the account can do, for the
     *   session's whole life. A password is not new authority; it is authority that
     *   outlives revocation, which is why the branch is narrow (empty slot only) and why
     *   `refreshSession`'s denylist remains the remedy for a session known to be stolen.
     * - Replacing an EXISTING password from a bare session stays impossible. That is the
     *   property worth keeping, and it is untouched.
     *
     * A deployment that wants the stricter posture keeps `createPasswordReset` and does not
     * surface this branch in its UI; the reset flow still works either way. */
    changePassword: mutation(async (ctx, input: { currentPassword: string; newPassword: string }) => {
      const userId = requireOwnUser(ctx, users);
      const current = typeof input?.currentPassword === "string" ? input.currentPassword : "";
      const next = typeof input?.newPassword === "string" ? input.newPassword : "";
      if (next.length < 8) throw new BadRequest("newPassword must be at least 8 characters");
      const rows = await ctx.db.exec(`SELECT passwordHash FROM ${users.sql} WHERE username = ? LIMIT 1`, userId);
      // No row at all: a token for an account that has since been deleted. Previously this
      // fell into the same `stored === ""` branch as a passwordless user and was rejected as
      // a wrong password, harmless then, but once an empty slot is fillable it would make
      // the UPDATE a silent no-op that reports success.
      if (rows.length === 0) throw new Unauthorized("authentication required");
      const stored = String(rows[0].passwordHash ?? "");
      const firstPassword = stored === "";
      if (!firstPassword && !(await verifyPassword(current, stored))) {
        throw new Unauthorized("current password is incorrect");
      }
      await ctx.db.exec(`UPDATE ${users.sql} SET passwordHash = ? WHERE username = ?`, await hashPassword(next), userId);
      return { ok: true, firstPassword };
    }),
  };
}

/** The default user-management handlers over `auth_users`. Equivalent to
 * `createUserHandlers()`; spread alongside `authHandlers`. */
export const userHandlers = createUserHandlers();

// Fields a self-service caller may see of their own row (never passwordHash/roles).
const SELF_READ_FIELDS = ["username", "email", "emailVerified", "active", "createdAt"];
// Fields an admin may see of any user (never passwordHash).
const ADMIN_READ_FIELDS = ["username", "roles", "email", "emailVerified", "active", "createdAt", "profile"];

/** ACL policy fragments that turn on the user-management handlers. Spread `admin`
 * into your admin role and `self` into your authenticated-user role:
 *
 *   role("admin", [...authPolicies().admin, ...yourAdminPolicies])
 *   role("user",  [...authPolicies().self,  ...yourUserPolicies])
 *
 * `admin` grants read (projected) + update of roles/email/active on every user.
 * `self` grants each user read + email-update of ONLY their own row (matched on the
 * `userId` identity claim). passwordHash is in no policy, so it is never exposed.
 *
 * For a custom table, pass the same `table` you gave `createUserHandlers`, a unique
 * `prefix` (policy names must be unique across roles when you wire more than one
 * instance), and `adminReadFields`/`adminWriteFields` to expose/permit extra columns
 * (e.g. a `tenants` column managed by your own setUserTenants handler). */
export function authPolicies(opts: {
  table?: string;
  identityPath?: string;
  prefix?: string;
  adminReadFields?: string[];
  adminWriteFields?: string[];
  selfReadFields?: string[];
  selfWriteFields?: string[];
} = {}): { admin: Policy[]; self: Policy[] } {
  const table = usersTable(opts.table).name;
  const idPath = opts.identityPath ?? "userId";
  const p = opts.prefix ?? "auth";
  const adminRead = opts.adminReadFields ?? ADMIN_READ_FIELDS;
  const adminWrite = opts.adminWriteFields ?? ["roles", "email", "active"];
  const selfRead = opts.selfReadFields ?? SELF_READ_FIELDS;
  const selfWrite = opts.selfWriteFields ?? ["email"];
  return {
    admin: [
      policy(`${p}:admin:read`, table, "read", { fields: adminRead }),
      policy(`${p}:admin:update`, table, "update", { fields: adminWrite }),
      policy(`${p}:admin:delete`, table, "delete", allow()),
    ],
    self: [
      policy(`${p}:self:read`, table, "read", { where: { username: $identity(idPath) }, fields: selfRead }),
      policy(`${p}:self:update`, table, "update", { where: { username: $identity(idPath) }, fields: selfWrite }),
    ],
  };
}

// --- password reset + email verification -------------------------------------
//
// Two one-time-email-token flows, built on the same machinery as magic-link: mint a
// random token, persist only its SHA-256 HASH + an expiry (in the shared
// `auth_email_tokens` table, spread `emailTokenSchema`), email the raw token from a TASK
// (off the mutation's storage transaction, so a slow send can't hold the store lock), and
// redeem it once. The token is minted INSIDE that task, never in the mutation (see
// "emailed tokens" above). Both are transport-agnostic: you supply `sendEmail`; pramen
// owns the token lifecycle. Wire the returned `tasks` into your app's task map, or the
// request stays pending, no token is ever minted and the email never sends.

const PURPOSE_RESET = "reset";
const PURPOSE_VERIFY = "verify";

/** Revoke every token of `purpose` for `username` (only the latest request works) and
 * record a new pending request for `email`. Returns its id for the send task's payload. */
async function requestEmailToken(ctx: HandlerContext, purpose: string, username: string, email: string, expiresAt: number): Promise<string> {
  const requestId = crypto.randomUUID();
  await ctx.db.exec("DELETE FROM auth_email_tokens WHERE purpose = ? AND username = ?", purpose, username);
  await ctx.db.exec(
    "INSERT INTO auth_email_tokens (tokenHash, purpose, username, email, expiresAt, createdAt, requestId) VALUES (?, ?, ?, ?, ?, ?, ?)",
    pendingHash(requestId),
    purpose,
    username,
    email,
    expiresAt,
    Date.now(),
    requestId,
  );
  return requestId;
}

/** The send task for a reset/verify request: re-check that the account still wants this
 * email (`eligible`), then mint, send and mark it sent. An ineligible request's row is
 * dropped, so it can never be minted later. */
async function sendEmailToken(
  ctx: HandlerContext,
  payload: SendPayload,
  expiresAt: number,
  eligible: (username: string, email: string) => Promise<boolean>,
  send: (args: { email: string; token: string; username: string }) => void | Promise<void>,
): Promise<void> {
  const { email, username = "", requestId, token: legacy } = payload;
  if (requestId === undefined) {
    if (legacy !== undefined && (await legacyTokenIsLive(ctx, "auth_email_tokens", legacy))) await send({ email, token: legacy, username });
    return;
  }
  if (!(await eligible(username, email))) {
    await ctx.db.exec("DELETE FROM auth_email_tokens WHERE requestId = ?", requestId);
    return;
  }
  const token = await mintForRequest(ctx, "auth_email_tokens", requestId, expiresAt);
  if (token === null) return;
  await send({ email, token, username });
  await markSent(ctx, "auth_email_tokens", requestId);
}

/** Validate a token (right purpose, unexpired, unconsumed) and CONSUME it (single-use).
 * Returns the account + address it was minted for. Throws Unauthorized on any failure:
 * the same opaque error for missing / wrong-purpose / expired / already-used, so a caller
 * learns nothing beyond "this token won't work". */
async function redeemEmailToken(ctx: HandlerContext, purpose: string, token: string): Promise<{ username: string; email: string }> {
  const tokenHash = await sha256Hex(token);
  const rows = await ctx.db.exec(
    "SELECT username, email, expiresAt, consumedAt FROM auth_email_tokens WHERE tokenHash = ? AND purpose = ? LIMIT 1",
    tokenHash,
    purpose,
  );
  const row = rows[0];
  if (!row || row.consumedAt != null || Number(row.expiresAt) < Date.now()) throw new Unauthorized("invalid or expired token");
  await ctx.db.exec("UPDATE auth_email_tokens SET consumedAt = ? WHERE tokenHash = ?", Date.now(), tokenHash);
  return { username: String(row.username), email: String(row.email) };
}

/** Parse `{ token, newPassword }` for `resetPassword`. */
function parseResetInput(raw: JsonValue): { token: string; newPassword: string } {
  const o = (raw ?? {}) as JsonObject;
  if (typeof o.token !== "string" || o.token.length === 0) throw new BadRequest("token is required");
  if (typeof o.newPassword !== "string" || o.newPassword.length < 8) throw new BadRequest("newPassword must be at least 8 characters");
  return { token: o.token, newPassword: o.newPassword };
}

export interface PasswordResetOptions {
  /** Deliver the reset link. Receives the ctx + `{ email, token, username }`, so build the
   * URL your app routes to, e.g. `${ctx.env.APP_URL}/reset?token=${token}`. Called from the
   * `sendPasswordResetEmail` TASK (after commit), like magic-link's sendEmail. */
  sendEmail: (ctx: HandlerContext, args: { email: string; token: string; username: string }) => void | Promise<void>;
  /** The users table to reset against (must have `username` PK + `passwordHash`/`email`).
   * Default `auth_users`; pass your own authSchema-shaped table (as with createUserHandlers). */
  table?: string;
  /** How long the reset link stays valid, in seconds. Default 3600 (1h). */
  linkTtlSeconds?: number;
}

/** Build the `requestPasswordReset` / `resetPassword` handler pair + the
 * `sendPasswordResetEmail` task. Both handlers are ANONYMOUS: the emailed token is the
 * capability. `requestPasswordReset` is enumeration-safe (always `{ ok: true }`, sends only
 * when an active account matches the email); `resetPassword` redeems the single-use token
 * and sets the new password. Spread `emailTokenSchema` into your schema and `.tasks` into
 * your task map. */
export function createPasswordReset(opts: PasswordResetOptions): AuthModule {
  const table = usersTable(opts.table).sql;
  const linkTtlMs = (opts.linkTtlSeconds ?? 3600) * 1000;

  const handlers: HandlerMap = {
    /** Anonymous: request a reset link for `email`. Resolves the address to an ACTIVE
     * account and, only then, enqueues the send (which mints the token), but the response is the
     * same `{ ok: true }` whether or not any account matched (no enumeration). */
    requestPasswordReset: mutation(
      async (ctx, input: { email: string }) => {
        const rows = await ctx.db.exec(`SELECT username, active FROM ${table} WHERE email = ? LIMIT 1`, input.email);
        const u = rows[0];
        if (u && isActive(u.active)) {
          const username = String(u.username);
          const requestId = await requestEmailToken(ctx, PURPOSE_RESET, username, input.email, Date.now() + linkTtlMs);
          await ctx.tasks.enqueue({ kind: "sendPasswordResetEmail", payload: { email: input.email, username, requestId } });
        }
        return { ok: true };
      },
      { input: parseEmail },
    ),

    /** Anonymous: redeem a reset token and set the new password. Single-use (the token is
     * consumed first). The account must still exist + be active. Any other pending reset
     * tokens for the user are dropped on success. */
    resetPassword: mutation(
      async (ctx, input: { token: string; newPassword: string }) => {
        const { username, email } = await redeemEmailToken(ctx, PURPOSE_RESET, input.token);
        const rows = await ctx.db.exec(`SELECT active, email FROM ${table} WHERE username = ? LIMIT 1`, username);
        // A link mailed to an address the account no longer holds is dead: after a
        // changeEmail, whoever reads the OLD inbox must not be able to take the account.
        if (!rows[0] || rows[0].email !== email) throw new Unauthorized("invalid or expired token");
        if (!isActive(rows[0].active)) throw new Unauthorized("account is deactivated");
        await ctx.db.exec(`UPDATE ${table} SET passwordHash = ? WHERE username = ?`, await hashPassword(input.newPassword), username);
        await ctx.db.exec("DELETE FROM auth_email_tokens WHERE purpose = ? AND username = ?", PURPOSE_RESET, username);
        return { ok: true };
      },
      { input: parseResetInput },
    ),
  };

  const tasks: AppTaskMap = {
    // The account must still be active and still hold this address: after a changeEmail
    // the old address must not receive a live reset link.
    sendPasswordResetEmail: async (ctx, payload) =>
      sendEmailToken(
        ctx,
        payload as SendPayload,
        Date.now() + linkTtlMs,
        async (username, email) => {
          const rows = await ctx.db.exec(`SELECT active, email FROM ${table} WHERE username = ? LIMIT 1`, username);
          return !!rows[0] && isActive(rows[0].active) && rows[0].email === email;
        },
        (args) => opts.sendEmail(ctx, args),
      ),
  };

  return { handlers, tasks };
}

export interface EmailVerificationOptions {
  /** Deliver the verification link. Receives the ctx + `{ email, token, username }`, so build
   * the URL your app routes to, e.g. `${ctx.env.APP_URL}/verify?token=${token}`. Called from
   * the `sendVerificationEmail` TASK (after commit). */
  sendEmail: (ctx: HandlerContext, args: { email: string; token: string; username: string }) => void | Promise<void>;
  /** The users table (must have `username` PK + `email`/`emailVerified`). Default `auth_users`. */
  table?: string;
  /** How long the verification link stays valid, in seconds. Default 86400 (24h). */
  linkTtlSeconds?: number;
}

/** Build the `requestEmailVerification` / `verifyEmail` handler pair + the
 * `sendVerificationEmail` task. `requestEmailVerification` is AUTHENTICATED (a caller
 * verifies their OWN current email, and runs right after signup, when the client already holds
 * the session token); `verifyEmail` is ANONYMOUS (the token is the capability) and stamps
 * `auth_users.emailVerified`. A token is bound to the address current at request time, so a
 * later `changeEmail` invalidates it (verifyEmail rejects a token whose address no longer
 * matches). Spread `emailTokenSchema` into your schema and `.tasks` into your task map. */
export function createEmailVerification(opts: EmailVerificationOptions): AuthModule {
  const users = usersTable(opts.table);
  const table = users.sql;
  const linkTtlMs = (opts.linkTtlSeconds ?? 86_400) * 1000;

  const handlers: HandlerMap = {
    /** Authenticated: email the caller a verification link for their CURRENT address. A
     * no-op `{ ok: true, alreadyVerified: true }` if already verified; 400 if no email is set. */
    requestEmailVerification: mutation(
      async (ctx) => {
        const userId = requireOwnUser(ctx, users);
        const rows = await ctx.db.exec(`SELECT email, emailVerified FROM ${table} WHERE username = ? LIMIT 1`, userId);
        const u = rows[0];
        const email = u && typeof u.email === "string" ? u.email : "";
        if (!email) throw new BadRequest("no email on file. Set one with changeEmail first");
        if (u.emailVerified != null) return { ok: true, alreadyVerified: true };
        const requestId = await requestEmailToken(ctx, PURPOSE_VERIFY, userId, email, Date.now() + linkTtlMs);
        await ctx.tasks.enqueue({ kind: "sendVerificationEmail", payload: { email, username: userId, requestId } });
        return { ok: true };
      },
      { auth: "authenticated" },
    ),

    /** Anonymous: redeem a verification token and mark the address verified. Guards that the
     * account's CURRENT email still equals the address the token was minted for: a stale
     * token (email changed since request) is rejected, never verifying the new address. */
    verifyEmail: mutation(
      async (ctx, input: { token: string }) => {
        const { username, email } = await redeemEmailToken(ctx, PURPOSE_VERIFY, input.token);
        const rows = await ctx.db.exec(`SELECT email FROM ${table} WHERE username = ? LIMIT 1`, username);
        const current = rows[0] && typeof rows[0].email === "string" ? String(rows[0].email) : null;
        if (current == null || current !== email) throw new Unauthorized("invalid or expired token");
        await ctx.db.exec(`UPDATE ${table} SET emailVerified = ? WHERE username = ?`, Date.now(), username);
        // Nothing left to verify: a still-pending request must not mint a link later.
        await ctx.db.exec("DELETE FROM auth_email_tokens WHERE purpose = ? AND username = ?", PURPOSE_VERIFY, username);
        return { ok: true, email };
      },
      { input: parseLinkToken },
    ),
  };

  const tasks: AppTaskMap = {
    // Still unverified and still this address, or there is nothing to verify.
    sendVerificationEmail: async (ctx, payload) =>
      sendEmailToken(
        ctx,
        payload as SendPayload,
        Date.now() + linkTtlMs,
        async (username, email) => {
          const rows = await ctx.db.exec(`SELECT email, emailVerified FROM ${table} WHERE username = ? LIMIT 1`, username);
          return !!rows[0] && rows[0].email === email && rows[0].emailVerified == null;
        },
        (args) => opts.sendEmail(ctx, args),
      ),
  };

  return { handlers, tasks };
}

// --- OIDC (authorization code + PKCE) ---------------------------------------
export { createOidcAuth, defaultOidcProfile, oidcHandlers, OIDC_UPSERT_HANDLER, type OidcOptions } from "./oidc.js";
