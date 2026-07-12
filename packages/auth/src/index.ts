// @pramen/auth — optional credential→JWT login for pramen, so an app can issue
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

import { Entity, mutation, query, defaultTo, unique, hidden, policy, allow, $identity, BadRequest, Unauthorized } from "@pramen/server";
import type { AppTaskMap, HandlerContext, HandlerMap, Policy } from "@pramen/server";

// --- schema fragment: spread into your defineSchema so the table is migrated ---

export const authSchema = {
  auth_users: Entity((t) => ({
    username: t.textId(), // stable identity / PK (= the JWT `sub`); not the email
    passwordHash: hidden(t.text()), // never readable via the ORM; empty for passwordless users
    roles: t.json(), // string[]
    email: unique(t.text()), // mutable contact email (nullable, unique); the magic-link key
    active: defaultTo(t.bool(), true), // deactivation flag — false blocks login (additive, backfills 1)
    createdAt: t.int(),
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

// OWASP 2026 guidance for PBKDF2-HMAC-SHA256 is ~600k iterations. The iteration
// count (and hash alg) are ENCODED in the stored string — `pbkdf2$sha256$<iters>$
// <saltB64>$<hashB64>` — and verifyPassword parses them from the stored hash, so a
// future bump here keeps verifying older hashes; only NEW hashes use the new count.
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = "SHA-256";

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    key,
    256,
  );
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
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
  // 4 parts: pbkdf2 $ iters $ salt $ hash            (legacy — implicit sha256)
  const [algSeg, iterStr, saltB64, hashB64] = parts.length === 5 ? parts.slice(1) : ["sha256", ...parts.slice(1)];
  const iterations = Number(iterStr);
  if (!saltB64 || !hashB64 || !Number.isFinite(iterations) || iterations <= 0) return null;
  const hash = algSeg === "sha512" ? "SHA-512" : "SHA-256";
  return { iterations, hash, saltB64, hashB64 };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const key = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unb64(parsed.saltB64), iterations: parsed.iterations, hash: parsed.hash },
    key,
    256,
  );
  return constantTimeEqual(b64(new Uint8Array(bits)), parsed.hashB64);
}

// A fixed placeholder hash (current params), computed once and reused, so a login for a
// NON-EXISTENT username can still run a full PBKDF2 verify. That equalizes the timing of
// the "no such user" and "wrong password" paths — neither short-circuits — closing the
// user-existence timing oracle. Lazily initialized (top-level await isn't available here).
let dummyHashPromise: Promise<string> | undefined;
function dummyPasswordHash(): Promise<string> {
  return (dummyHashPromise ??= hashPassword("pramen-login-timing-equalizer-placeholder"));
}

// --- HS256 token signing (matches the verifier in @pramen/server auth.ts) ---

export async function signToken(
  claims: Record<string, unknown>,
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

function parseCreds(raw: unknown): { username: string; password: string } {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.username !== "string" || o.username.length === 0) throw new Error("username is required");
  if (typeof o.password !== "string" || o.password.length < 8) throw new Error("password must be at least 8 characters");
  return { username: o.username, password: o.password };
}

/** signup / login / me. Roles are assigned server-side (default `["user"]`) — the
 * client never picks its own roles. Spread into your handler map. */
export const authHandlers = {
  // NOTE on username enumeration: signup returns a distinct "username is taken" error,
  // which is an enumeration oracle. This is INHERENT to systems where the username is a
  // user-chosen, publicly-visible identifier — the caller learns "taken" the moment the
  // name shows up anywhere, so hiding it at signup buys little. What we CAN close is the
  // timing side channel: both the taken and the available paths run the same expensive
  // PBKDF2 hash before responding, so response time doesn't leak which path was taken.
  // The enumeration-SAFE flow is the passwordless / magic-link path (createMagicLinkAuth),
  // which keys on the email and always returns the same `{ ok: true }`.
  signup: mutation(
    async (ctx, input: { username: string; password: string }) => {
      const existing = await ctx.db.exec("SELECT 1 FROM auth_users WHERE username = ? LIMIT 1", input.username);
      if (existing.length > 0) {
        // Equalize timing with the available path (which hashes below) so the taken vs.
        // available decision isn't a fast timing oracle on top of the response-body one.
        await hashPassword(input.password);
        throw new BadRequest("username is taken");
      }
      const roles = DEFAULT_ROLES;
      const passwordHash = await hashPassword(input.password);
      await ctx.db.exec(
        "INSERT INTO auth_users (username, passwordHash, roles, createdAt) VALUES (?, ?, ?, ?)",
        input.username,
        passwordHash,
        JSON.stringify(roles),
        Date.now(),
      );
      const token = await signToken({ sub: input.username, roles }, secretOf(ctx), { ttlSeconds: sessionTtlOf(ctx) });
      return { token, user: { username: input.username, roles } };
    },
    { input: parseCreds },
  ),

  login: mutation(
    async (ctx, input: { username: string; password: string }) => {
      const rows = await ctx.db.exec(
        "SELECT username, passwordHash, roles, active FROM auth_users WHERE username = ? LIMIT 1",
        input.username,
      );
      const u = rows[0];
      if (!u) {
        // No such user: still run a full PBKDF2 verify against a fixed dummy hash so the
        // not-found path costs the same as a wrong-password path — no timing oracle that
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
      const roles = JSON.parse(String(u.roles)) as string[];
      const token = await signToken({ sub: String(u.username), roles }, secretOf(ctx), { ttlSeconds: sessionTtlOf(ctx) });
      return { token, user: { username: String(u.username), roles } };
    },
    { input: parseCreds },
  ),

  me: query((ctx) => ctx.identity),
};

// --- magic link (passwordless) login ---------------------------------------
//
// A one-time, single-use, time-boxed link emailed to the user. The flow is two
// anonymous mutations:
//   requestMagicLink({ email })  -> mints a token, persists its HASH + expiry, and
//                                   calls your sendEmail. Always returns { ok: true }
//                                   (no account enumeration — the response is the
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
  })),
};

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 256 bits of entropy, url-safe — the raw link token. */
function mintToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

function parseEmail(raw: unknown): { email: string } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const email = typeof o.email === "string" ? o.email.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequest("a valid email is required");
  return { email };
}

function parseLinkToken(raw: unknown): { token: string } {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.token !== "string" || o.token.length === 0) throw new BadRequest("token is required");
  return { token: o.token };
}

export interface MagicLinkOptions {
  /** Deliver the link to the recipient. Receives the handler ctx and the raw token —
   * build the URL however your app routes it, e.g. `${ctx.env.APP_URL}/auth?token=${token}`.
   * On Cloudflare the recommended transport is Cloudflare Email Sending — a
   * `send_email` binding (no API keys), e.g.
   * `await (ctx.env.EMAIL as SendEmail).send({ to, from: { email, name }, subject, text, html })`
   * (see example/app.ts + oblaka.ts). Called from the `sendMagicLinkEmail` TASK, not
   * inline in the mutation — a slow SMTP/API call can't hold the mutation's storage
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
 * The `requestMagicLink` handler writes the token and ENQUEUES a task (atomic with
 * the write via the transactional outbox); the drainer runs `sendMagicLinkEmail`
 * AFTER commit, outside the mutation's storage transaction. This avoids the class
 * of failure where a slow SMTP/API call holds the storage lock long enough for the
 * store to time out and reset the underlying object.
 *
 * You MUST spread `magicLink.tasks` into your app's task map — without it, tokens
 * get written but the email never sends (the drainer retries then dead-letters).
 * Both handlers are anonymous — gate nothing; the token is the capability. */
export function createMagicLinkAuth(opts: MagicLinkOptions): { handlers: HandlerMap; tasks: AppTaskMap } {
  const linkTtlMs = (opts.linkTtlSeconds ?? 900) * 1000;
  const sessionTtl = opts.sessionTtlSeconds ?? TOKEN_TTL_SECONDS;
  const defaultRoles = opts.defaultRoles ?? DEFAULT_ROLES;

  const handlers: HandlerMap = {
    requestMagicLink: mutation(
      async (ctx, input: { email: string }) => {
        const token = mintToken();
        const tokenHash = await sha256Hex(token);
        const now = Date.now();
        // Invalidate any prior pending links for this email — only the latest works.
        await ctx.db.exec("DELETE FROM auth_magic_links WHERE email = ?", input.email);
        await ctx.db.exec(
          "INSERT INTO auth_magic_links (tokenHash, email, expiresAt, createdAt) VALUES (?, ?, ?, ?)",
          tokenHash,
          input.email,
          now + linkTtlMs,
          now,
        );
        // Defer the actual email send. Enqueue is a DB write into the outbox, so it
        // commits atomically with the token insert. If commit fails, the task never
        // runs. If the task fails, retries + eventual dead-letter; the token expires
        // (linkTtl) and the user re-requests.
        await ctx.tasks.enqueue({ kind: "sendMagicLinkEmail", payload: { email: input.email, token } });
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
        // field (which would let a changeEmail squat another address — and would miss
        // pre-`email`-column users on upgrade, colliding on the username PK).
        const existing = await ctx.db.exec("SELECT roles, active FROM auth_users WHERE username = ? LIMIT 1", email);
        let roles: string[];
        if (existing.length > 0) {
          if (!isActive(existing[0].active)) throw new Unauthorized("account is deactivated");
          roles = JSON.parse(String(existing[0].roles)) as string[];
        } else {
          roles = defaultRoles;
          // No email column set: it stays a pure contact attribute (set via changeEmail),
          // so a new passwordless user can never collide with a password user's contact email.
          await ctx.db.exec(
            "INSERT INTO auth_users (username, passwordHash, roles, createdAt) VALUES (?, ?, ?, ?)",
            email,
            "",
            JSON.stringify(roles),
            Date.now(),
          );
        }
        const token = await signToken({ sub: email, roles }, secretOf(ctx), { ttlSeconds: sessionTtl });
        return { token, user: { username: email, roles } };
      },
      { input: parseLinkToken },
    ),
  };

  const tasks: AppTaskMap = {
    sendMagicLinkEmail: async (ctx, payload) => {
      const p = payload as { email: string; token: string };
      await opts.sendEmail(ctx, { email: p.email, token: p.token });
    },
  };

  return { handlers, tasks };
}

// --- user management ---------------------------------------------------------
//
// Admin + self-service operations over `auth_users`, built the pramen way: ordinary
// handlers over `ctx.db` whose authorization is the ACL, not imperative `if (admin)`
// checks. They are inert until you grant access — spread `authPolicies()` into your
// roles (admin manages everyone; the authenticated user manages only itself). Because
// the admin read policy restricts `fields`, `passwordHash` is never projected back.
//
// Role/active changes are baked into the JWT at login, so setUserRoles / setUserActive
// take effect on the user's NEXT login — not instantly. That lag is the cost of the
// stateless, verify-only core (no session store, by design). Tune the revocation window
// with the AUTH_SESSION_TTL_SECONDS env var (default 3600); for immediate revocation an
// app can keep a per-user denylist in ctx.kv and check it in a route/middleware —
// deliberately left to the app rather than building a session store into the core.

/** SQLite has no bool: `active` is stored 0/1 (NULL on a pre-column row = active). */
function isActive(v: unknown): boolean {
  return v == null || Number(v) !== 0;
}

function requireUserId(ctx: HandlerContext): string {
  const id = ctx.identity?.userId;
  if (typeof id !== "string" || id.length === 0) throw new Unauthorized("authentication required");
  return id;
}

// `ctx.db` is schema-typed against the *app's* composed schema, which this package
// can't import — so address the users table through a minimal structural view of the
// ACL'd Db. This is the same ctx.db at runtime: row-scope + field projection still apply.
interface UsersDb {
  update(table: string, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  delete(table: string, id: string): Promise<boolean>;
}
const usersDb = (ctx: HandlerContext): UsersDb => ctx.db as unknown as UsersDb;

// The users table must be a valid SQL identifier (it's interpolated into the raw exec
// strings below). It's app config, never request input, but guard it anyway.
function assertIdentifier(table: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`@pramen/auth: invalid table name ${JSON.stringify(table)}`);
  return table;
}

/** Build admin + self-service handlers over a users table (default `auth_users`).
 * Pass `table` to operate over your OWN authSchema-shaped table — e.g. one with an
 * extra `tenants` column — without renaming it: the handlers manage username/roles/
 * email/active/delete and ignore any extra columns. Spread the result into your
 * handler map and gate it with the matching `authPolicies({ table })`. The table must
 * have a `username` primary key and (for changeEmail/changePassword) `email`/
 * `passwordHash` columns. */
export function createUserHandlers(opts: { table?: string } = {}) {
  const table = assertIdentifier(opts.table ?? "auth_users");
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
      const updated = await usersDb(ctx).update(table, input.username, { roles: input.roles });
      if (!updated) throw new BadRequest("user not found"); // (or out of the caller's update scope)
      return updated;
    }),

    /** Admin: activate / deactivate a user. Deactivating blocks future logins (and
     * token refresh); existing tokens still expire naturally within the TTL. */
    setUserActive: mutation(async (ctx, input: { username: string; active: boolean }) => {
      if (typeof input?.username !== "string" || input.username.length === 0) throw new BadRequest("username is required");
      if (typeof input?.active !== "boolean") throw new BadRequest("active must be a boolean");
      if (input.active === false && input.username === ctx.identity?.userId) {
        throw new BadRequest("cannot deactivate your own account");
      }
      const updated = await usersDb(ctx).update(table, input.username, { active: input.active });
      if (!updated) throw new BadRequest("user not found");
      return updated;
    }),

    /** Admin: permanently delete a user. ACL-gated by the admin delete policy; a caller
     * cannot delete their own account. Deactivation (setUserActive) is usually preferable. */
    deleteUser: mutation(async (ctx, input: { username: string }) => {
      if (typeof input?.username !== "string" || input.username.length === 0) throw new BadRequest("username is required");
      if (input.username === ctx.identity?.userId) throw new BadRequest("cannot delete your own account");
      const deleted = await usersDb(ctx).delete(table, input.username);
      if (!deleted) throw new BadRequest("user not found");
      return { ok: true };
    }),

    /** Self-service: change the caller's contact email. The ACL self policy scopes the
     * write to the caller's own row and permits only the `email` field. Email is unique,
     * so a clash is reported as a clean 400 rather than surfacing the DB constraint as a 500. */
    changeEmail: mutation(async (ctx, input: { email: string }) => {
      const userId = requireUserId(ctx);
      const { email } = parseEmail(input); // validates + normalizes; 400 on a bad address
      const taken = await ctx.db.exec(`SELECT 1 FROM ${table} WHERE email = ? AND username != ? LIMIT 1`, email, userId);
      if (taken.length > 0) throw new BadRequest("email already in use");
      const updated = await usersDb(ctx).update(table, userId, { email });
      if (!updated) throw new Unauthorized("authentication required");
      return updated;
    }),

    /** Self-service: change the caller's password. A credential op — it reads the
     * caller's OWN hash (passwordHash is never ACL-readable) to verify the current
     * password, then writes the new one. Self-scoped by the verified identity, so it
     * never touches another row; passwordless (magic-link) users have no current
     * password and are rejected. */
    changePassword: mutation(async (ctx, input: { currentPassword: string; newPassword: string }) => {
      const userId = requireUserId(ctx);
      const current = typeof input?.currentPassword === "string" ? input.currentPassword : "";
      const next = typeof input?.newPassword === "string" ? input.newPassword : "";
      if (next.length < 8) throw new BadRequest("newPassword must be at least 8 characters");
      const rows = await ctx.db.exec(`SELECT passwordHash FROM ${table} WHERE username = ? LIMIT 1`, userId);
      const stored = rows[0] ? String(rows[0].passwordHash ?? "") : "";
      if (stored === "" || !(await verifyPassword(current, stored))) {
        throw new Unauthorized("current password is incorrect");
      }
      await ctx.db.exec(`UPDATE ${table} SET passwordHash = ? WHERE username = ?`, await hashPassword(next), userId);
      return { ok: true };
    }),
  };
}

/** The default user-management handlers over `auth_users`. Equivalent to
 * `createUserHandlers()`; spread alongside `authHandlers`. */
export const userHandlers = createUserHandlers();

// Fields a self-service caller may see of their own row (never passwordHash/roles).
const SELF_READ_FIELDS = ["username", "email", "active", "createdAt"];
// Fields an admin may see of any user (never passwordHash).
const ADMIN_READ_FIELDS = ["username", "roles", "email", "active", "createdAt"];

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
  const table = opts.table ?? "auth_users";
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
