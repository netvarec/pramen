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
import type { HandlerContext, Policy } from "@pramen/server";

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

const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

/** Constant-time string compare (avoids leaking the hash via timing). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2" || !saltB64 || !hashB64) return false;
  const key = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unb64(saltB64), iterations: Number(iterStr), hash: "SHA-256" },
    key,
    256,
  );
  return constantTimeEqual(b64(new Uint8Array(bits)), hashB64);
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
  signup: mutation(
    async (ctx, input: { username: string; password: string }) => {
      const existing = await ctx.db.exec("SELECT 1 FROM auth_users WHERE username = ? LIMIT 1", input.username);
      if (existing.length > 0) throw new BadRequest("username is taken");
      const roles = DEFAULT_ROLES;
      await ctx.db.exec(
        "INSERT INTO auth_users (username, passwordHash, roles, createdAt) VALUES (?, ?, ?, ?)",
        input.username,
        await hashPassword(input.password),
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
      if (!u || !(await verifyPassword(input.password, String(u.passwordHash)))) {
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
   * (see example/app.ts + oblaka.ts). Throwing rolls back the mutation, so a delivery
   * failure leaves no orphan token and surfaces to the caller to retry. */
  sendEmail: (ctx: HandlerContext, args: { email: string; token: string }) => void | Promise<void>;
  /** How long the emailed link stays valid, in seconds. Default 900 (15 min). */
  linkTtlSeconds?: number;
  /** TTL of the session JWT minted on successful login, in seconds. Default 3600 (1h). */
  sessionTtlSeconds?: number;
  /** Roles assigned when a magic-link login first creates the user. Default `["user"]`. */
  defaultRoles?: string[];
}

/** Build the `requestMagicLink` / `loginWithMagicLink` handler pair. Spread the
 * result into your handler map (and `magicLinkSchema` into your schema). Both are
 * anonymous — gate nothing; the token is the capability. */
export function createMagicLinkAuth(opts: MagicLinkOptions) {
  const linkTtlMs = (opts.linkTtlSeconds ?? 900) * 1000;
  const sessionTtl = opts.sessionTtlSeconds ?? TOKEN_TTL_SECONDS;
  const defaultRoles = opts.defaultRoles ?? DEFAULT_ROLES;

  return {
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
        // Inside the mutation transaction: a throw here rolls the token back.
        await opts.sendEmail(ctx, { email: input.email, token });
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
// can't import — so address auth_users through a minimal structural view of the ACL'd
// Db. This is the same ctx.db at runtime: row-scope + field projection still apply.
interface AuthUsersDb {
  update(table: "auth_users", id: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  delete(table: "auth_users", id: string): Promise<boolean>;
}
const usersDb = (ctx: HandlerContext): AuthUsersDb => ctx.db as unknown as AuthUsersDb;

/** Admin + self-service handlers over `auth_users`. Spread into your handler map
 * alongside `authHandlers`; gate them by spreading `authPolicies()` into your roles. */
export const userHandlers = {
  /** Admin: list users (ACL projects out passwordHash). A non-admin caller granted
   * only the self policy sees just their own row; ungranted callers get a 403. */
  listUsers: query(async (ctx, input: { limit?: number; offset?: number }) => {
    const limit = Math.min(Math.max(Math.trunc(Number(input?.limit ?? 50)) || 50, 1), 200);
    const offset = Math.max(Math.trunc(Number(input?.offset ?? 0)) || 0, 0);
    return ctx.db.find({ from: "auth_users", orderBy: { column: "createdAt", dir: "desc" }, limit, offset });
  }),

  /** Admin: replace a user's roles. The ACL admin update policy permits writing
   * `roles`; a self-only caller can't (so this is admin-gated declaratively). */
  setUserRoles: mutation(async (ctx, input: { username: string; roles: string[] }) => {
    if (typeof input?.username !== "string" || input.username.length === 0) throw new BadRequest("username is required");
    if (!Array.isArray(input.roles) || !input.roles.every((r) => typeof r === "string" && r.length > 0)) {
      throw new BadRequest("roles must be a non-empty string[]");
    }
    const updated = await usersDb(ctx).update("auth_users", input.username, { roles: input.roles });
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
    const updated = await usersDb(ctx).update("auth_users", input.username, { active: input.active });
    if (!updated) throw new BadRequest("user not found");
    return updated;
  }),

  /** Admin: permanently delete a user. ACL-gated by the admin delete policy; a caller
   * cannot delete their own account. Deactivation (setUserActive) is usually preferable. */
  deleteUser: mutation(async (ctx, input: { username: string }) => {
    if (typeof input?.username !== "string" || input.username.length === 0) throw new BadRequest("username is required");
    if (input.username === ctx.identity?.userId) throw new BadRequest("cannot delete your own account");
    const deleted = await usersDb(ctx).delete("auth_users", input.username);
    if (!deleted) throw new BadRequest("user not found");
    return { ok: true };
  }),

  /** Self-service: change the caller's contact email. The ACL self policy scopes the
   * write to the caller's own row and permits only the `email` field. Email is unique,
   * so a clash is reported as a clean 400 rather than surfacing the DB constraint as a 500. */
  changeEmail: mutation(async (ctx, input: { email: string }) => {
    const userId = requireUserId(ctx);
    const { email } = parseEmail(input); // validates + normalizes; 400 on a bad address
    const taken = await ctx.db.exec("SELECT 1 FROM auth_users WHERE email = ? AND username != ? LIMIT 1", email, userId);
    if (taken.length > 0) throw new BadRequest("email already in use");
    const updated = await usersDb(ctx).update("auth_users", userId, { email });
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
    const rows = await ctx.db.exec("SELECT passwordHash FROM auth_users WHERE username = ? LIMIT 1", userId);
    const stored = rows[0] ? String(rows[0].passwordHash ?? "") : "";
    if (stored === "" || !(await verifyPassword(current, stored))) {
      throw new Unauthorized("current password is incorrect");
    }
    await ctx.db.exec("UPDATE auth_users SET passwordHash = ? WHERE username = ?", await hashPassword(next), userId);
    return { ok: true };
  }),
};

// Fields a self-service caller may see of their own row (never passwordHash/roles).
const SELF_READ_FIELDS = ["username", "email", "active", "createdAt"];
// Fields an admin may see of any user (never passwordHash).
const ADMIN_READ_FIELDS = ["username", "roles", "email", "active", "createdAt"];

/** ACL policy fragments that turn on `userHandlers`. Spread `admin` into your admin
 * role and `self` into your authenticated-user role:
 *
 *   role("admin", [...authPolicies().admin, ...yourAdminPolicies])
 *   role("user",  [...authPolicies().self,  ...yourUserPolicies])
 *
 * `admin` grants read (projected) + update of roles/email/active on every user.
 * `self` grants each user read + email-update of ONLY their own row (matched on the
 * `userId` identity claim). passwordHash is in no policy, so it is never exposed. */
export function authPolicies(opts: { table?: string; identityPath?: string } = {}): { admin: Policy[]; self: Policy[] } {
  const table = opts.table ?? "auth_users";
  const idPath = opts.identityPath ?? "userId";
  return {
    admin: [
      policy("auth:admin:read", table, "read", { fields: ADMIN_READ_FIELDS }),
      policy("auth:admin:update", table, "update", { fields: ["roles", "email", "active"] }),
      policy("auth:admin:delete", table, "delete", allow()),
    ],
    self: [
      policy("auth:self:read", table, "read", { where: { username: $identity(idPath) }, fields: SELF_READ_FIELDS }),
      policy("auth:self:update", table, "update", { where: { username: $identity(idPath) }, fields: ["email"] }),
    ],
  };
}
