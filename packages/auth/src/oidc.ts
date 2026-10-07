// OIDC login: authorization code + PKCE, exchanged for a PRAMEN session.
//
// pramen's core stays verify-only (BYO-IdP): `JwksStrategy` already verifies an RS256 token
// against a remote JWKS, so a deployment whose frontend already holds an IdP token needs
// nothing from this file. What was missing is the FLOW: the redirect dance that turns a
// browser with no token into a session, and the claim mapping that makes an IdP's idea of
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
// authoritative), else the roles stored on the user's row (pramen is authoritative, the
// only workable answer for Google), else `defaultRoles` for a first login.
//
// SILENT SIGN-IN (`/auth/oidc/start?prompt=none`). A browser that already holds a session at
// the provider can be signed in here without seeing anything: the provider redirects straight
// back with a code. When it cannot (no session there, or a step would need the user), OIDC
// Core §3.1.2.6 says it answers with an `error` instead of showing a screen. A silent attempt
// runs on page load, unattended, so that answer must not strand the user on an error page:
// the callback sends the browser on to `successRedirect` with `#error=<code>` and no token,
// and the app shows its ordinary sign-in. The same goes for OUR side failing after the
// provider said yes (a deactivated account, an unverified email, a failed exchange): every
// failure past the state check of a silent attempt redirects, with a pramen code
// (`account_deactivated`, `email_not_verified`, `invalid_token`, `server_error`). A provider
// code outside the four that `prompt=none` exists to produce is redirected too, but LOGGED,
// since it means a misconfigured client or an outage. The app must try silently at most ONCE per visit
// (a `sessionStorage` flag) and never when the fragment already carries `error=`: otherwise
// a user with no provider session loops between the two origins forever.

import { isSystemRole, JwksStrategy, Kv, mutation } from "@pramen/server";
import type { EnvBag, HandlerContext, HandlerMap, JsonObject, Row } from "@pramen/server";
import type { PublicRoute, RouteContext } from "@pramen/server/worker";
// The package's OWN HS256 signer. `@pramen/server`'s `signToken` mints the opaque
// file/preview token, which the request verifier does not accept as a session.
import { signToken } from "./index.js";
import { tableClaim, usersTable } from "./users-table.js";

/** An OpenID Provider's discovery document: the fields this flow uses. */
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  /** RP-Initiated Logout 1.0. Optional: a provider without it cannot end its session for us. */
  end_session_endpoint?: string;
}

export interface OidcOptions {
  /** The provider's issuer URL. `/.well-known/openid-configuration` is fetched from it, so
   * the endpoints and the JWKS location are never hand-copied. */
  issuer: string;
  clientId: string;
  /** Confidential clients only. Omit for a public client: the exchange then relies on
   * PKCE alone, which is the correct configuration for a SPA. */
  clientSecret?: string;
  /** Must match the redirect URI registered with the provider, exactly. */
  redirectUri: string;
  /** Where to send the browser after a successful login. The session token arrives in the
   * URL FRAGMENT (`#token=…`), which (unlike a query parameter) is never sent to a
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
   * What to remember about the person from the ID token's claims, stored on the user's row
   * (`auth_users.profile`) at EVERY sign-in and returned by `me` as `profile`. The provider is
   * authoritative here as it is for roles: each sign-in overwrites the stored value, and
   * `null` (or `undefined`) clears it.
   *
   * Default: {@link defaultOidcProfile}, the standard `name` and `picture` claims. Map more
   * when your provider sends something the app should show:
   *
   *   mapProfile: (c) => ({ ...defaultOidcProfile(c), team: c["https://acme.com/team"] })
   *
   * The value is shown to the signed-in user and to admins listing users; keep secrets and
   * tokens out of it.
   */
  mapProfile?: (claims: JsonObject) => JsonObject | null | undefined;
  /**
   * What identifies the account across logins.
   *
   * `"email"` (default) matches how the rest of `@pramen/auth` keys users, so an OIDC login
   * lands on the SAME row as a magic-link or password login for that address. It is only
   * honored when the provider asserts `email_verified`: an IdP that lets a user set an
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
  /**
   * Let signing out here end the session at the provider too (OpenID Connect RP-Initiated
   * Logout 1.0). Without it, an app that signs in through the provider silently, as soon as
   * its sign-in page loads, signs the user straight back in after they sign out.
   *
   * When true, the success fragment also carries `id_token=<the provider's ID token>` next
   * to `token=`, for the browser to keep with its session, and `routes` gains a third route,
   * `POST {logoutPath}` with body `{ "idToken": "…" }`. It verifies that ID token (signature,
   * issuer, audience; NOT expiry, since it is hours old by then) and calls the provider's
   * `end_session_endpoint` server to server with it as `id_token_hint`. Only a request from
   * the app's own origin (`Origin` = that of `successRedirect`/`redirectUri`) is served, and
   * only a token issued within `sessionTtlSeconds` (+5 min). It answers `{ ok: true, provider:
   * "signed_out" }` and nothing else as success; every other outcome is `ok: false` with
   * `error`: `forbidden_origin` (403), `invalid_token` / `stale_token` (400), `unsupported`
   * (501, no `end_session_endpoint`), `provider_failed` with `status` or `server_error` (502).
   * The pramen session is not touched: it is a stateless token the browser drops. Default false.
   */
  endSession?: boolean;
  /** Where the logout route is mounted when `endSession` is on. Default `/auth/oidc/logout`. */
  logoutPath?: string;
  /** How long the logout route waits for the provider. Default 5000 ms. */
  endSessionTimeoutMs?: number;
}

/**
 * The profile `createOidcAuth` stores when `mapProfile` is not given: the standard `name` and
 * `picture` claims (OpenID Connect Core 5.1), strings only, and `picture` only as an absolute
 * `https:` URL, since the editor puts it straight into an `<img src>`. `null` when neither is
 * there, so a provider that stops sending them clears what an earlier sign-in stored.
 */
export function defaultOidcProfile(claims: JsonObject): JsonObject | null {
  const out: JsonObject = {};
  if (typeof claims.name === "string" && claims.name.trim() !== "") out.name = claims.name.trim();
  if (typeof claims.picture === "string" && isHttpsUrl(claims.picture)) out.picture = claims.picture;
  return Object.keys(out).length > 0 ? out : null;
}

const isHttpsUrl = (v: string): boolean => {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

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
      // against: a provider whose discovery URL and issuer differ (a tenant alias, say) is
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
  /** Started with `prompt=none`. A provider error then goes back to the app as `#error=`,
   * not to an error page: see SILENT SIGN-IN at the top of this file. */
  silent?: boolean;
  /** SHA-256 of the binder cookie handed to the browser that STARTED this login.
   *
   * Without it, `state` is just a random string an attacker can obtain by starting a login
   * of their own: they then trick the victim's browser into loading the callback with their
   * code+state, and the victim is silently signed in AS THE ATTACKER, so everything the victim
   * subsequently writes lands in the attacker's account. Requiring the cookie means the
   * callback only completes in the browser the flow began in. */
  binderHash: string;
}

const sha256Hex = async (v: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** One binder cookie PER STATE, not one per browser. Silent sign-in runs unattended on page
 * load in every tab, so two tabs start overlapping attempts; under a single cookie name the
 * second start overwrote the first's binder and the first came back as a mismatch. The name
 * carries a hash of the state (bounded length, cookie-name-safe), never the state itself. */
const binderCookieName = async (state: string): Promise<string> => `pramen_oidc_${(await sha256Hex(state)).slice(0, 16)}`;

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** `SameSite=Lax` is what makes this work at all: the callback is a TOP-LEVEL GET navigation
 * from the provider's origin, which Lax allows, while a cross-site POST or subresource would
 * not carry it. `Secure` is set whenever the request is https, and omitted on plain-http local
 * dev, where the browser would otherwise drop the cookie entirely. */
const binderCookie = (name: string, url: URL, path: string, value: string, maxAge: number): string =>
  `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`;

/** `returnTo` as a same-origin PATH, or undefined. `startsWith("/") && !startsWith("//")` was
 * not enough: browsers normalize `\` to `/` in special-scheme URLs, so `/\evil.com` became the
 * protocol-relative `//evil.com`. Resolving against a placeholder origin and requiring it to
 * survive catches every spelling of that, and the explicit `\`/control-character refusal
 * covers what an app might do with the raw string before it ever resolves it. */
const safeReturnTo = (raw: string | null | undefined): string | undefined => {
  if (!raw?.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(raw)) return undefined;
  const base = "https://return-to.invalid";
  return new URL(raw, base).origin === base ? raw : undefined;
};

/** What `prompt=none` exists to produce (OIDC Core §3.1.2.6): the provider needs the user. */
const SILENT_EXPECTED = new Set(["login_required", "interaction_required", "consent_required", "account_selection_required"]);

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** An error page. The message is ESCAPED here rather than at the call sites: this route is
 * public, pre-auth, and reachable with arbitrary query parameters, so anything interpolated
 * into it is attacker-controlled until proven otherwise. Escaping centrally means a future
 * caller cannot reintroduce the hole by forgetting. */
const html = (status: number, message: string): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Sign-in</title><p>${message.replace(/[&<>"']/g, (c) => ESCAPES[c]!)}</p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

/** OAuth error codes are a constrained vocabulary (RFC 6749 §4.1.2.1). Anything outside it
 * is not a provider error worth echoing: it is someone probing this endpoint. */
const safeErrorCode = (raw: string): string => (/^[a-z_]{1,64}$/.test(raw) ? raw : "unspecified");

/**
 * OIDC login for a pramen app. Spread the routes into `app.routes` (they are PRE-AUTH by
 * design, since a caller arriving here has no session yet):
 *
 *   const oidc = createOidcAuth({ issuer, clientId, clientSecret, redirectUri, successRedirect });
 *   export const app = { schema, handlers, acl, routes: [...oidc.routes] };
 *
 * The browser goes to `/auth/oidc/start`, comes back to `/auth/oidc/callback`, and lands on
 * `successRedirect#token=<pramen session>`. `/auth/oidc/start?prompt=none` tries silently and
 * lands on `successRedirect#error=login_required` (or another OIDC error code) when the
 * provider would need the user: see SILENT SIGN-IN above.
 */
export function createOidcAuth(opts: OidcOptions): { routes: PublicRoute[] } {
  const scopes = opts.scopes ?? ["openid", "email", "profile"];
  const users = usersTable(opts.table);
  const table = users.name;
  const defaultRoles = opts.defaultRoles ?? ["user"];
  const accountKey = opts.accountKey ?? "email";
  const startPath = opts.startPath ?? "/auth/oidc/start";
  const callbackPath = opts.callbackPath ?? "/auth/oidc/callback";
  const stateTtl = opts.stateTtlSeconds ?? 600;
  const sessionTtl = opts.sessionTtlSeconds ?? 3600;

  /** `successRedirect`, carrying the path the user was headed for. Only ever a PATH: an
   * absolute or protocol-relative `returnTo` would make this an open redirect. Checked again
   * here, not only at start, because a silent error hands it back with no sign-in at all. */
  const successTarget = (pending: PendingLogin): URL => {
    const target = new URL(opts.successRedirect);
    const returnTo = safeReturnTo(pending.returnTo);
    if (returnTo) target.searchParams.set("returnTo", returnTo);
    return target;
  };

  // One verifier per issuer, so the JWKS cache and its key-rotation handling are shared
  // across logins rather than rebuilt per request.
  let verifier: JwksStrategy | undefined;
  const idTokenVerifier = (jwksUri: string, issuer: string): JwksStrategy =>
    (verifier ??= new JwksStrategy(jwksUri, undefined, { requireExp: true, issuer, audience: opts.clientId }));
  // Logout verifies the SAME tokens as evidence of a past sign-in, hours later, so expiry is
  // not checked. A separate instance because the options differ; it never authenticates a
  // request, and nothing it accepts is trusted beyond "this provider issued it to us".
  let logoutVerifier: JwksStrategy | undefined;
  const hintVerifier = (jwksUri: string, issuer: string): JwksStrategy =>
    (logoutVerifier ??= new JwksStrategy(jwksUri, undefined, { ignoreExpiry: true, issuer, audience: opts.clientId }));

  const start: PublicRoute = {
    method: "GET",
    path: startPath,
    handler: async (request: Request, env: EnvBag) => {
      const query = new URL(request.url).searchParams;
      // Only `none` is passed through. `login`, `consent` and `select_account` would each need
      // the app to know what the provider supports and to handle its answer; refusing them is
      // clearer than forwarding a value whose failure the app was never written to expect.
      const prompt = query.get("prompt");
      if (prompt !== null && prompt !== "none") return html(400, "Unsupported sign-in option.");
      const doc = await discover(opts.issuer);
      const kv = new Kv((env as EnvBag & { KV: KVNamespace }).KV);
      const state = randomB64();
      const binder = randomB64();
      const pending: PendingLogin = {
        verifier: randomB64(64),
        nonce: randomB64(),
        binderHash: await sha256Hex(binder),
        // Where the user was going before they were bounced to sign in. Only ever a PATH:
        // an absolute URL here would make this an open redirect.
        returnTo: safeReturnTo(query.get("returnTo")),
        silent: prompt === "none" || undefined,
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
      if (pending.silent) url.searchParams.set("prompt", "none");
      return new Response(null, {
        status: 302,
        headers: {
          location: url.toString(),
          "cache-control": "no-store",
          "set-cookie": binderCookie(await binderCookieName(state), new URL(request.url), callbackPath, binder, stateTtl),
        },
      });
    },
  };

  const callback: PublicRoute = {
    method: "GET",
    path: callbackPath,
    handler: async (request: Request, env: EnvBag, ctx: RouteContext) => {
      const url = new URL(request.url);
      const kv = new Kv((env as EnvBag & { KV: KVNamespace }).KV);
      const state = url.searchParams.get("state");
      // A provider that refuses (consent declined, unauthorized client) redirects back with
      // `error` rather than `code`. Surface it instead of reporting "no code".
      const rawError = url.searchParams.get("error");
      const providerError = rawError ? safeErrorCode(rawError) : null;
      const refused = () => html(400, `Sign-in was refused by the provider (${providerError}).`);
      if (!state) return providerError ? refused() : html(400, "Sign-in link is incomplete. Start again.");

      // The state must belong to THIS browser. An attacker who starts their own login holds
      // a perfectly valid state+code; without this check, feeding them to a victim's browser
      // signs the victim in as the attacker. The cookie is read BEFORE KV: a request without
      // one can never complete, so it costs no KV round trip.
      const cookieName = await binderCookieName(state);
      const binder = readCookie(request, cookieName);
      if (!binder) return providerError ? refused() : html(400, "This sign-in did not start in this browser. Start again.");

      // SINGLE USE: read and delete before anything else, so a replayed callback, or two
      // tabs racing the same code, cannot both proceed. Not run concurrently: KV gives no
      // ordering between two in-flight operations, and a delete landing first would fail a
      // legitimate login.
      const pending = (await kv.get(`oidc:${state}`, "json")) as PendingLogin | null;
      await kv.delete(`oidc:${state}`);
      const clearBinder = binderCookie(cookieName, url, callbackPath, "", 0);
      if (!pending) return html(400, "Sign-in expired or was already used. Start again.");
      if ((await sha256Hex(binder)) !== pending.binderHash) return html(400, "This sign-in did not start in this browser. Start again.");

      // From here the attempt is known to be this browser's own. Every failure goes through
      // `fail`, so a SILENT attempt can never strand the user on an error page, whichever
      // step refused it: see SILENT SIGN-IN.
      const redirect = (hash: string): Response => {
        const target = successTarget(pending);
        // FRAGMENT, not query: a fragment is never sent to a server, so the session token
        // stays out of access logs, proxies and `Referer`.
        target.hash = hash;
        // The binder is spent with the state it protected.
        return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store", "set-cookie": clearBinder } });
      };
      const fail = (status: number, message: string, errorCode: string): Response => {
        if (!pending.silent) {
          const res = html(status, message);
          res.headers.set("set-cookie", clearBinder);
          return res;
        }
        console.warn(`pramen/auth: silent OIDC sign-in failed (${errorCode}): ${message}`);
        return redirect(`error=${errorCode}`);
      };

      if (providerError) {
        // A silent attempt the provider answered with one of its expected codes is the normal
        // outcome for a user with no session there, not a failure. Any OTHER code still goes
        // back to the app (the user must not be stranded) but is logged as an error: it means
        // a misconfigured client or a provider outage that nobody would otherwise see.
        if (pending.silent) {
          if (!SILENT_EXPECTED.has(providerError)) console.error(`pramen/auth: silent OIDC sign-in got an unexpected provider error (${providerError})`);
          return redirect(`error=${providerError}`);
        }
        return fail(400, `Sign-in was refused by the provider (${providerError}).`, providerError);
      }
      const code = url.searchParams.get("code");
      if (!code) return fail(400, "Sign-in link is incomplete. Start again.", "invalid_request");

      // Discovery, the exchange and the upsert can THROW (network, a provider outage), which
      // would otherwise surface as a bare 500 and strand a silent attempt all the same.
      const complete = async (): Promise<Response> => {
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
          return fail(502, "Sign-in could not be completed. Try again.", "server_error");
        }

        // Signature, issuer, audience and expiry, then the nonce, which is what binds this
        // ID token to the authorization request WE started. Without it a token minted for a
        // different session of the same client would be accepted here.
        const claims = await idTokenVerifier(doc.jwks_uri, doc.issuer).verify(tokens.id_token);
        if (!claims) return fail(401, "Sign-in token could not be verified.", "invalid_token");
        if (claims.nonce !== pending.nonce) return fail(401, "Sign-in token does not match this sign-in attempt.", "invalid_token");

        const sub = typeof claims.sub === "string" ? claims.sub : "";
        const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
        const emailVerified = claims.email_verified === true;
        if (!sub) return fail(401, "Sign-in token carries no subject.", "invalid_token");

        // See `accountKey`: keying on an UNVERIFIED email would let a provider that permits
        // arbitrary addresses take over an existing account. Fail rather than silently
        // falling back to `sub`, which would quietly create a second account for the user.
        let username: string;
        if (accountKey === "email") {
          if (!email || !emailVerified) {
            return fail(401, "This provider did not assert a verified email address, which this app uses to identify accounts.", "email_not_verified");
          }
          username = email;
        } else {
          username = `${doc.issuer}#${sub}`;
        }

        // A SYSTEM role can never be held by a session (the verifier strips it), so an IdP
        // group that happens to be named like one must not be stored as if it meant something.
        // `mapRoles` hands the provider's claim straight through, so this is where it lands.
        const mapped = opts.mapRoles?.(claims)?.filter((r) => !isSystemRole(r));
        // Not a reason to refuse the sign-in: a profile is decoration, and a mapper that throws
        // on a claim it did not expect must not lock the person out. It is logged and stored as
        // no profile.
        let profile: JsonObject | null;
        try {
          profile = (opts.mapProfile ?? defaultOidcProfile)(claims) ?? null;
        } catch (err) {
          console.error("pramen/auth: OIDC mapProfile threw; storing no profile", err);
          profile = null;
        }
        const res = await ctx.callPrivileged({
          name: OIDC_UPSERT_HANDLER,
          input: { table, username, email: email || null, roles: mapped ? [...mapped] : null, defaultRoles: [...defaultRoles], profile },
          roles: [OIDC_SYSTEM_ROLE],
        });
        const upserted = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { roles?: string[]; active?: boolean } };
        if (upserted.ok !== true || !upserted.result) return fail(500, "Sign-in could not be completed.", "server_error");
        // A deactivated account must not be revived by logging in through the IdP: the
        // provider knows nothing about pramen's `active` flag.
        if (upserted.result.active === false) return fail(403, "This account is deactivated.", "account_deactivated");

        const secret = (env as EnvBag).AUTH_SECRET;
        if (typeof secret !== "string" || secret.length === 0) {
          console.error("pramen/auth: OIDC callback cannot mint a session, because AUTH_SECRET is not configured");
          return fail(500, "Sign-in could not be completed.", "server_error");
        }
        const token = await signToken({ sub: username, roles: upserted.result.roles ?? [], ...tableClaim(users) }, secret, { ttlSeconds: sessionTtl });
        // With `endSession`, the ID token rides along so the browser can hand it back to the
        // logout route. Same fragment, so it stays out of logs and `Referer` like the session.
        return redirect(`token=${encodeURIComponent(token)}${opts.endSession ? `&id_token=${encodeURIComponent(tokens.id_token)}` : ""}`);
      };
      try {
        return await complete();
      } catch (err) {
        console.error("pramen/auth: OIDC callback failed", err);
        return fail(500, "Sign-in could not be completed.", "server_error");
      }
    },
  };

  if (!opts.endSession) return { routes: [start, callback] };

  const json = (status: number, body: JsonObject): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  const endSessionTimeout = opts.endSessionTimeoutMs ?? 5000;

  // Only pages of THIS app may ask: the route ends a session at the provider, so a foreign
  // page posting a token it got hold of must not be able to. Browsers always send `Origin` on
  // a POST with a JSON body, so a missing one is refused too (a server-side caller has no
  // business here). The app's origin is where the callback lands and where the browser is.
  const appOrigins = new Set([new URL(opts.successRedirect).origin, new URL(opts.redirectUri).origin]);
  // How old an ID token may be and still name a live sign-in: a pramen session lives
  // `sessionTtl`, so a token older than that (plus clock skew) belongs to a session that is
  // already gone. Without the bound, an `exp`-ignoring check would make every ID token ever
  // issued a permanent "sign this person out" capability.
  const maxTokenAge = sessionTtl + 300;

  const logout: PublicRoute = {
    // POST, not GET: the ID token is in the BODY, so it never lands in an access log or a
    // browser history entry on our side. It goes to the provider as a query parameter only
    // because RP-Initiated Logout defines it that way, and only server to server.
    method: "POST",
    path: opts.logoutPath ?? "/auth/oidc/logout",
    handler: async (request: Request) => {
      // Every answer but `signed_out` is `ok: false`: the page must never read a failure as
      // "the provider session is gone", or it would hand the user to a sign-in page that
      // silently signs them straight back in while claiming they were signed out.
      try {
        const origin = request.headers.get("origin");
        if (!origin || !appOrigins.has(origin)) return json(403, { ok: false, error: "forbidden_origin" });
        const body = (await request.json().catch(() => null)) as { idToken?: unknown } | null;
        const idToken = typeof body?.idToken === "string" ? body.idToken : "";
        if (!idToken) return json(400, { ok: false, error: "invalid_token" });
        const doc = await discover(opts.issuer);
        // Verified BEFORE it goes anywhere: this route is public, and without the check it would
        // relay whatever a caller posted to the provider under our client id.
        const claims = await hintVerifier(doc.jwks_uri, doc.issuer).verify(idToken);
        if (!claims) return json(400, { ok: false, error: "invalid_token" });
        const iat = typeof claims.iat === "number" ? claims.iat : null;
        if (iat === null || Math.floor(Date.now() / 1000) - iat > maxTokenAge) return json(400, { ok: false, error: "stale_token" });
        if (!doc.end_session_endpoint) return json(501, { ok: false, error: "unsupported" });

        const url = new URL(doc.end_session_endpoint);
        url.searchParams.set("id_token_hint", idToken);
        url.searchParams.set("client_id", opts.clientId);
        let res: Response;
        try {
          res = await fetch(url.toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(endSessionTimeout) });
        } catch (err) {
          console.error("pramen/auth: OIDC end_session_endpoint could not be reached", err instanceof Error ? err.name : "error");
          return json(502, { ok: false, error: "provider_failed", status: 0 });
        }
        if (res.status >= 200 && res.status < 400) return json(200, { ok: true, provider: "signed_out" });
        // Logged without the URL: it carries the ID token.
        console.error(`pramen/auth: OIDC end_session_endpoint answered HTTP ${res.status}`);
        return json(502, { ok: false, error: "provider_failed", status: res.status });
      } catch (err) {
        // Discovery down, JWKS unreachable, anything unexpected. Never a 200.
        console.error("pramen/auth: OIDC logout failed", err instanceof Error ? err.message : "error");
        return json(502, { ok: false, error: "server_error" });
      }
    },
  };

  return { routes: [start, callback, logout] };
}

/** The name of the privileged handler the callback route calls. A route has no `ctx.db`: it
 * runs in the Worker, before any tenant DO, so the write goes through `callPrivileged`,
 * exactly as the CMS's preview route does. */
export const OIDC_UPSERT_HANDLER = "__oidcUpsertUser";

/** The role the OIDC callback presents when it calls {@link OIDC_UPSERT_HANDLER}, and the
 * only role that handler's `auth` accepts.
 *
 * It is deliberately not a role anything else grants: roles reach an identity either from a
 * user row (`auth_users.roles`) or from an IdP claim mapping, and nothing writes this one.
 * The Worker also overwrites or deletes the `x-pramen-identity` header on every proxied
 * request (`worker.ts`), so a caller cannot supply it from outside either. */
export const OIDC_SYSTEM_ROLE = "__oidc_system";

/** Handlers for `createOidcAuth`'s routes. Spread into `app.handlers`:
 *
 *   handlers: { ...authHandlers, ...oidcHandlers }
 *
 * `__oidcUpsertUser` is SYSTEM-only: the callback reaches it through `callPrivileged`
 * presenting {@link OIDC_SYSTEM_ROLE}, which no token issued to a user can carry, so it
 * cannot be called over `/rpc` by anyone, admins included. */
export const oidcHandlers: HandlerMap = {
  [OIDC_UPSERT_HANDLER]: mutation(
    async (ctx: HandlerContext, input: { table: string; username: string; email: string | null; roles: string[] | null; defaultRoles: string[]; profile?: JsonObject | null }) => {
      // `undefined` from a caller that predates the profile (it is optional in the input) is
      // treated as "nothing to say", which on this path means clearing it, the same as `null`.
      const profile = input.profile ? JSON.stringify(input.profile) : null;
      const rows = (await ctx.db.exec(`SELECT username, roles, active FROM ${usersTable(input.table).sql} WHERE username = ? LIMIT 1`, input.username)) as Row[];
      const existing = rows[0];
      if (!existing) {
        // First login. `passwordHash` is empty: the column is NOT NULL in `authSchema` and
        // an empty hash never verifies, which is exactly how a magic-link user is created.
        const roles = input.roles ?? input.defaultRoles;
        await ctx.db.exec(
          `INSERT INTO ${usersTable(input.table).sql} (username, passwordHash, roles, email, emailVerified, active, createdAt, profile) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          input.username,
          "",
          JSON.stringify(roles),
          input.email,
          // The IdP asserted it (the route refuses an unverified address when keying on
          // email), so it is verified here in a way a self-service signup never is.
          input.email ? Date.now() : null,
          1,
          Date.now(),
          profile,
        );
        return { roles, active: true };
      }
      // Returning user. Roles the IdP asserts overwrite the stored ones: that is what
      // "the IdP is authoritative" means, including a role being REMOVED there. With no
      // `mapRoles`, the stored roles stand and pramen owns them.
      const stored = parseRoles(existing.roles);
      const roles = input.roles ?? stored;
      const active = existing.active !== 0 && existing.active !== false;
      if (input.roles && JSON.stringify(roles) !== JSON.stringify(stored)) {
        await ctx.db.exec(`UPDATE ${usersTable(input.table).sql} SET roles = ? WHERE username = ?`, JSON.stringify(roles), input.username);
      }
      // The provider is authoritative for the profile too: every sign-in rewrites it, so a
      // changed name or picture shows up at the next sign-in and a removed one disappears.
      await ctx.db.exec(`UPDATE ${usersTable(input.table).sql} SET profile = ? WHERE username = ?`, profile, input.username);
      return { roles, active };
    },
    // Gated on a role NO issued token can carry, because `callPrivileged` does not bypass
    // this check: it sends an ordinary identity (`{ roles: [...] }`) through the same
    // `dispatch` gate as any other caller. An empty allow-list, which this used to be, is
    // satisfied by nobody INCLUDING the callback, so every OIDC sign-in 403'd at the upsert
    // and reported "Sign-in could not be completed." `createPramen` now rejects that
    // spelling at boot rather than letting it fail silently at runtime.
    //
    // `["admin"]` would work (that is `callPrivileged`'s default identity) and is wrong:
    // this handler WRITES ROLES, so any admin could hand themselves a role set over /rpc.
    { auth: [OIDC_SYSTEM_ROLE] },
  ),
};

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
