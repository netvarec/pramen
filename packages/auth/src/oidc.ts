// OIDC login — authorization code + PKCE, exchanged for a PRAMEN session.
//
// pramen's core stays verify-only (BYO-IdP): `JwksStrategy` already verifies an RS256 token
// against a remote JWKS, so a deployment whose frontend already holds an IdP token needs
// nothing from this file. What was missing is the FLOW — the redirect dance that turns a
// browser with no token into a session — and the claim mapping that makes an IdP's idea of
// a user into pramen's.
//
// WHY IT MINTS A PRAMEN TOKEN rather than passing the IdP's through. The rest of the system
// is built on pramen sessions: `refreshSession` re-reads roles without a re-login, the KV
// denylist can revoke one mid-flight, and the ACL reads roles off the token. Forwarding a
// provider token would give up all three and put role resolution on the hot path of every
// request. So: the IdP proves WHO you are, once; pramen owns the session from there. Same
// shape as `createMagicLinkAuth`, which exchanges a one-time link for the same thing.
//
// WHERE ROLES COME FROM, which differs per provider and is the part that silently fails:
//   - Entra puts app roles in a top-level `roles` claim,
//   - Auth0/Okta put them in a NAMESPACED claim (`https://example.com/roles`),
//   - Google Workspace has none in the token at all.
// So roles resolve in this order: `mapRoles(claims)` if you supply one (the IdP is
// authoritative), else the roles stored on the user's row (pramen is authoritative — the
// only workable answer for Google), else `defaultRoles` for a first login.

import { JwksStrategy, Kv, mutation } from "@pramen/server";
import type { EnvBag, HandlerContext, HandlerMap, JsonObject, Row } from "@pramen/server";
import type { PublicRoute, RouteContext } from "@pramen/server/worker";
// The package's OWN HS256 signer — `@pramen/server`'s `signToken` mints the opaque
// file/preview token, which the request verifier does not accept as a session.
import { signToken } from "./index.js";

/** An OpenID Provider's discovery document — the fields this flow uses. */
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface OidcOptions {
  /** The provider's issuer URL. `/.well-known/openid-configuration` is fetched from it, so
   * the endpoints and the JWKS location are never hand-copied. */
  issuer: string;
  clientId: string;
  /** Confidential clients only. Omit for a public client — the exchange then relies on
   * PKCE alone, which is the correct configuration for a SPA. */
  clientSecret?: string;
  /** Must match the redirect URI registered with the provider, exactly. */
  redirectUri: string;
  /** Where to send the browser after a successful login. The session token arrives in the
   * URL FRAGMENT (`#token=…`), which — unlike a query parameter — is never sent to a
   * server, kept in server logs, or included in a `Referer` header. */
  successRedirect: string;
  /** Default `["openid", "email", "profile"]`. */
  scopes?: readonly string[];
  /** The users table. Default `auth_users` (the `authSchema` shape). */
  table?: string;
  /** Roles for a first-time login when `mapRoles` yields none. Default `["user"]`. */
  defaultRoles?: readonly string[];
  /**
   * Read roles out of the ID token's claims, for providers where the IdP is authoritative:
   *
   *   mapRoles: (c) => c["https://acme.com/roles"] as string[]   // Auth0/Okta
   *   mapRoles: (c) => c.roles as string[]                       // Entra
   *
   * Return `undefined` to fall back to the roles stored on the user's row. Google Workspace
   * ships no roles in the token, so omit this and manage them in pramen.
   */
  mapRoles?: (claims: JsonObject) => readonly string[] | undefined;
  /**
   * What identifies the account across logins.
   *
   * `"email"` (default) matches how the rest of `@pramen/auth` keys users, so an OIDC login
   * lands on the SAME row as a magic-link or password login for that address. It is only
   * honored when the provider asserts `email_verified` — an IdP that lets a user set an
   * unverified address would otherwise be an account-takeover path into any existing
   * email-keyed account.
   *
   * `"sub"` keys on the provider's opaque subject, namespaced by issuer. Immune to an email
   * change, and to the above, but it will not link up with accounts created another way.
   */
  accountKey?: "email" | "sub";
  sessionTtlSeconds?: number;
  /** Where the flow is mounted. Defaults `/auth/oidc/start` and `/auth/oidc/callback`. */
  startPath?: string;
  callbackPath?: string;
  /** How long an in-flight login may take. Default 600s. */
  stateTtlSeconds?: number;
}

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const randomB64 = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** PKCE S256: the verifier stays server-side, only its hash goes to the provider, so an
 * intercepted authorization code cannot be redeemed by whoever intercepted it. */
async function challengeFor(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

/** Discovery, cached per issuer for the isolate's life. The document is static in practice,
 * and a fetch on every login would put the provider's availability on the login path twice. */
const discoveryCache = new Map<string, Promise<Discovery>>();
function discover(issuer: string): Promise<Discovery> {
  const base = issuer.replace(/\/+$/, "");
  let cached = discoveryCache.get(base);
  if (!cached) {
    cached = (async () => {
      const res = await fetch(`${base}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`@pramen/auth: OIDC discovery failed for ${base} (HTTP ${res.status})`);
      const doc = (await res.json()) as Partial<Discovery>;
      for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
        if (typeof doc[field] !== "string") throw new Error(`@pramen/auth: OIDC discovery document from ${base} has no ${field}`);
      }
      // The document's own `issuer` is what ID tokens will carry, and it is what we verify
      // against — a provider whose discovery URL and issuer differ (a tenant alias, say) is
      // legitimate; a document claiming a DIFFERENT issuer than it was fetched from is not.
      return doc as Discovery;
    })();
    discoveryCache.set(base, cached);
    void cached.catch(() => discoveryCache.delete(base)); // never cache a failure
  }
  return cached;
}

/** One in-flight login. Held in KV under a random key so the browser carries only the
 * lookup key, never the verifier. */
interface PendingLogin {
  verifier: string;
  nonce: string;
  returnTo?: string;
}

const html = (status: number, message: string): Response =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Sign-in</title><p>${message}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * OIDC login for a pramen app. Spread the routes into `app.routes` (they are PRE-AUTH by
 * design — a caller arriving here has no session yet):
 *
 *   const oidc = createOidcAuth({ issuer, clientId, clientSecret, redirectUri, successRedirect });
 *   export const app = { schema, handlers, acl, routes: [...oidc.routes] };
 *
 * The browser goes to `/auth/oidc/start`, comes back to `/auth/oidc/callback`, and lands on
 * `successRedirect#token=<pramen session>`.
 */
export function createOidcAuth(opts: OidcOptions): { routes: PublicRoute[] } {
  const scopes = opts.scopes ?? ["openid", "email", "profile"];
  const table = opts.table ?? "auth_users";
  const defaultRoles = opts.defaultRoles ?? ["user"];
  const accountKey = opts.accountKey ?? "email";
  const startPath = opts.startPath ?? "/auth/oidc/start";
  const callbackPath = opts.callbackPath ?? "/auth/oidc/callback";
  const stateTtl = opts.stateTtlSeconds ?? 600;
  const sessionTtl = opts.sessionTtlSeconds ?? 3600;

  // One verifier per issuer, so the JWKS cache and its key-rotation handling are shared
  // across logins rather than rebuilt per request.
  let verifier: JwksStrategy | undefined;
  const idTokenVerifier = (jwksUri: string, issuer: string): JwksStrategy =>
    (verifier ??= new JwksStrategy(jwksUri, undefined, { requireExp: true, issuer, audience: opts.clientId }));

  const start: PublicRoute = {
    method: "GET",
    path: startPath,
    handler: async (request: Request, env: EnvBag) => {
      const doc = await discover(opts.issuer);
      const kv = new Kv((env as EnvBag & { KV: KVNamespace }).KV);
      const state = randomB64();
      const pending: PendingLogin = {
        verifier: randomB64(64),
        nonce: randomB64(),
        // Where the user was going before they were bounced to sign in. Only ever a PATH:
        // an absolute URL here would make this an open redirect.
        returnTo: new URL(request.url).searchParams.get("returnTo") ?? undefined,
      };
      await kv.put(`oidc:${state}`, JSON.stringify(pending), { expirationTtl: stateTtl });

      const url = new URL(doc.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", opts.clientId);
      url.searchParams.set("redirect_uri", opts.redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", pending.nonce);
      url.searchParams.set("code_challenge", await challengeFor(pending.verifier));
      url.searchParams.set("code_challenge_method", "S256");
      return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } });
    },
  };

  const callback: PublicRoute = {
    method: "GET",
    path: callbackPath,
    handler: async (request: Request, env: EnvBag, ctx: RouteContext) => {
      const url = new URL(request.url);
      const kv = new Kv((env as EnvBag & { KV: KVNamespace }).KV);

      // A provider that refuses (consent declined, unauthorized client) redirects back with
      // `error` rather than `code`. Surface it instead of reporting "no code".
      const providerError = url.searchParams.get("error");
      if (providerError) return html(400, `Sign-in was refused by the provider (${providerError}).`);

      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code) return html(400, "Sign-in link is incomplete. Start again.");

      // SINGLE USE: read and delete before anything else, so a replayed callback — or two
      // tabs racing the same code — cannot both proceed.
      const pending = (await kv.get(`oidc:${state}`, "json")) as PendingLogin | null;
      await kv.delete(`oidc:${state}`);
      if (!pending) return html(400, "Sign-in expired or was already used. Start again.");

      const doc = await discover(opts.issuer);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: opts.redirectUri,
        client_id: opts.clientId,
        code_verifier: pending.verifier,
      });
      if (opts.clientSecret) body.set("client_secret", opts.clientSecret);
      const tokenRes = await fetch(doc.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
      });
      const tokens = (await tokenRes.json().catch(() => ({}))) as { id_token?: string; error?: string };
      if (!tokenRes.ok || typeof tokens.id_token !== "string") {
        console.error(`pramen/auth: OIDC token exchange failed (HTTP ${tokenRes.status}${tokens.error ? `, ${tokens.error}` : ""})`);
        return html(502, "Sign-in could not be completed. Try again.");
      }

      // Signature, issuer, audience and expiry — then the nonce, which is what binds this
      // ID token to the authorization request WE started. Without it a token minted for a
      // different session of the same client would be accepted here.
      const claims = await idTokenVerifier(doc.jwks_uri, doc.issuer).verify(tokens.id_token);
      if (!claims) return html(401, "Sign-in token could not be verified.");
      if (claims.nonce !== pending.nonce) return html(401, "Sign-in token does not match this sign-in attempt.");

      const sub = typeof claims.sub === "string" ? claims.sub : "";
      const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
      const emailVerified = claims.email_verified === true;
      if (!sub) return html(401, "Sign-in token carries no subject.");

      // See `accountKey`: keying on an UNVERIFIED email would let a provider that permits
      // arbitrary addresses take over an existing account. Fail rather than silently
      // falling back to `sub`, which would quietly create a second account for the user.
      let username: string;
      if (accountKey === "email") {
        if (!email || !emailVerified) {
          return html(401, "This provider did not assert a verified email address, which this app uses to identify accounts.");
        }
        username = email;
      } else {
        username = `${doc.issuer}#${sub}`;
      }

      const mapped = opts.mapRoles?.(claims);
      const res = await ctx.callPrivileged({
        name: OIDC_UPSERT_HANDLER,
        input: { table, username, email: email || null, roles: mapped ? [...mapped] : null, defaultRoles: [...defaultRoles] },
      });
      const upserted = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { roles?: string[]; active?: boolean } };
      if (upserted.ok !== true || !upserted.result) return html(500, "Sign-in could not be completed.");
      // A deactivated account must not be revived by logging in through the IdP — the
      // provider knows nothing about pramen's `active` flag.
      if (upserted.result.active === false) return html(403, "This account is deactivated.");

      const secret = (env as EnvBag).AUTH_SECRET;
      if (typeof secret !== "string" || secret.length === 0) {
        console.error("pramen/auth: OIDC callback cannot mint a session — AUTH_SECRET is not configured");
        return html(500, "Sign-in could not be completed.");
      }
      const token = await signToken({ sub: username, roles: upserted.result.roles ?? [] }, secret, { ttlSeconds: sessionTtl });
      const target = new URL(opts.successRedirect);
      if (pending.returnTo?.startsWith("/") && !pending.returnTo.startsWith("//")) target.searchParams.set("returnTo", pending.returnTo);
      // FRAGMENT, not query: a fragment is never sent to a server, so the session token
      // stays out of access logs, proxies and `Referer`.
      target.hash = `token=${encodeURIComponent(token)}`;
      return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
    },
  };

  return { routes: [start, callback] };
}

/** The name of the privileged handler the callback route calls. A route has no `ctx.db` — it
 * runs in the Worker, before any tenant DO — so the write goes through `callPrivileged`,
 * exactly as the CMS's preview route does. */
export const OIDC_UPSERT_HANDLER = "__oidcUpsertUser";

/** Handlers for `createOidcAuth`'s routes. Spread into `app.handlers`:
 *
 *   handlers: { ...authHandlers, ...oidcHandlers }
 *
 * `__oidcUpsertUser` is SYSTEM-only: `callPrivileged` reaches it from inside the Worker, and
 * `auth: []` means no role satisfies it over `/rpc`, so it cannot be called from outside. */
export const oidcHandlers: HandlerMap = {
  [OIDC_UPSERT_HANDLER]: mutation(
    async (ctx: HandlerContext, input: { table: string; username: string; email: string | null; roles: string[] | null; defaultRoles: string[] }) => {
      const rows = (await ctx.db.exec(`SELECT username, roles, active FROM ${quoteIdent(input.table)} WHERE username = ? LIMIT 1`, input.username)) as Row[];
      const existing = rows[0];
      if (!existing) {
        // First login. `passwordHash` is empty — the column is NOT NULL in `authSchema` and
        // an empty hash never verifies, which is exactly how a magic-link user is created.
        const roles = input.roles ?? input.defaultRoles;
        await ctx.db.exec(
          `INSERT INTO ${quoteIdent(input.table)} (username, passwordHash, roles, email, emailVerified, active, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          input.username,
          "",
          JSON.stringify(roles),
          input.email,
          // The IdP asserted it (the route refuses an unverified address when keying on
          // email), so it is verified here in a way a self-service signup never is.
          input.email ? Date.now() : null,
          1,
          Date.now(),
        );
        return { roles, active: true };
      }
      // Returning user. Roles the IdP asserts overwrite the stored ones — that is what
      // "the IdP is authoritative" means, including a role being REMOVED there. With no
      // `mapRoles`, the stored roles stand and pramen owns them.
      const stored = parseRoles(existing.roles);
      const roles = input.roles ?? stored;
      const active = existing.active !== 0 && existing.active !== false;
      if (input.roles && JSON.stringify(roles) !== JSON.stringify(stored)) {
        await ctx.db.exec(`UPDATE ${quoteIdent(input.table)} SET roles = ? WHERE username = ?`, JSON.stringify(roles), input.username);
      }
      return { roles, active };
    },
    // No role can satisfy an empty allow-list, so /rpc always 403s; callPrivileged runs as
    // SYSTEM and bypasses it. The handler writes roles, so it must never be callable.
    { auth: [] },
  ),
};

/** The table name comes from the app's own options, never from a request — but it is
 * interpolated into SQL, so it is quoted and constrained rather than trusted by convention. */
function quoteIdent(table: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`@pramen/auth: invalid table name ${JSON.stringify(table)}`);
  return `"${table}"`;
}

function parseRoles(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}
