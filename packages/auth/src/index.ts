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

import { Entity, mutation, query, BadRequest, Unauthorized } from "@pramen/server";
import type { HandlerContext } from "@pramen/server";

// --- schema fragment: spread into your defineSchema so the table is migrated ---

export const authSchema = {
  auth_users: Entity((t) => ({
    username: t.textId(),
    passwordHash: t.text(),
    roles: t.json(), // string[]
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
      const token = await signToken({ sub: input.username, roles }, secretOf(ctx), { ttlSeconds: TOKEN_TTL_SECONDS });
      return { token, user: { username: input.username, roles } };
    },
    { input: parseCreds },
  ),

  login: mutation(
    async (ctx, input: { username: string; password: string }) => {
      const rows = await ctx.db.exec(
        "SELECT username, passwordHash, roles FROM auth_users WHERE username = ? LIMIT 1",
        input.username,
      );
      const u = rows[0];
      if (!u || !(await verifyPassword(input.password, String(u.passwordHash)))) {
        throw new Unauthorized("invalid username or password");
      }
      const roles = JSON.parse(String(u.roles)) as string[];
      const token = await signToken({ sub: String(u.username), roles }, secretOf(ctx), { ttlSeconds: TOKEN_TTL_SECONDS });
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
        const existing = await ctx.db.exec("SELECT roles FROM auth_users WHERE username = ? LIMIT 1", email);
        let roles: string[];
        if (existing.length > 0) {
          roles = JSON.parse(String(existing[0].roles)) as string[];
        } else {
          roles = defaultRoles;
          await ctx.db.exec(
            // Empty passwordHash can never verify → the user stays passwordless.
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
