---
title: Auth & Tenancy
order: 6
summary: JWT verification (HS256 or RS256/JWKS), the optional @pramen/auth login package (password, magic link, user management), and per-tenant authorization.
---

The Worker verifies a **bearer JWT** (WebCrypto), checks `exp`/`nbf`, and maps
claims to an `Identity`: `sub` → `userId`, `roles`/`role` → roles, and any custom
claims pass through. A forged or unsigned request gets no identity (and is denied by
the deny-by-default ACL). The trusted identity is forwarded to the DO, which never
re-derives it.

The core is **verify-only**: bring your own identity provider (any HS256/JWKS
issuer). When you don't want a third-party IdP, the optional **`@pramen/auth`**
package issues tokens the verifier accepts (see [Login with @pramen/auth](#login-with-pramenauth)).

## Verification strategies

Verification is pluggable via `VerifyStrategy` (`src/auth.ts`), selected from env:

### HS256: shared secret (default)

`HmacStrategy` verifies with the symmetric secret in `AUTH_SECRET` (dev value in
`wrangler.jsonc`; production via `wrangler secret put AUTH_SECRET`). Good for
internal services and the test suite.

### RS256 via JWKS

Set `JWKS_URL` to your identity provider's JWKS endpoint (Auth0, Clerk, Cognito, …).
`JwksStrategy` then verifies tokens asymmetrically against the fetched public keys:

- keys are **cached** (TTL) and selected by the token's `kid`
- an unknown `kid` triggers one forced refetch to pick up **key rotation**
- stale keys are kept if a refetch fails

When `JWKS_URL` is set it takes over from `AUTH_SECRET`.

```jsonc
// wrangler vars / secrets
{ "JWKS_URL": "https://your-tenant.auth0.com/.well-known/jwks.json" }
```

## Login with @pramen/auth

`@pramen/auth` is an **optional** package that issues HS256 tokens the core verifier
accepts, so an app can have logins without standing up a third-party IdP. Spread its
schema fragment into your schema and its handlers into your handler map:

```ts
import { authSchema, authHandlers } from "@pramen/auth";

const schema = defineSchema({ ...authSchema, notes: Entity(/* … */) });
const handlers = { ...authHandlers, ...yourHandlers };
```

It needs `AUTH_SECRET` in the environment. The `auth_users` table stores `username`
(the PK and JWT `sub`), a PBKDF2 `passwordHash` (a [`hidden()`](/docs/schema-and-handlers#hidden-columns)
column, never returned by a read), `roles`, a mutable unique `email`, and an
`active` flag.

- **`signup({ username, password })`** → `{ token, user }`. Roles are assigned
  server-side (default `["user"]`); a client never picks its own roles.
- **`login({ username, password })`** → `{ token, user }`. A wrong password, unknown
  user, or **deactivated** account all return `401` (no account enumeration).
- **`me()`** → the caller's `Identity`.
- **`refreshSession()`** (authenticated) → `{ token, user }` with **freshly read**
  roles and `active`, at the configured TTL.

Token lifetime defaults to 1h; set `AUTH_SESSION_TTL_SECONDS` to tune it. Because
`refreshSession` lets a client renew silently, a short TTL costs nothing in UX. See
[Sessions & revocation](#sessions-revocation).

### OIDC (Entra, Auth0/Okta, Google Workspace)

`createOidcAuth()` adds the login flow (authorization code + PKCE) and exchanges it for a
**pramen session**, exactly as the magic link does. The IdP proves who you are once; pramen
owns the session from there, so `refreshSession`, the KV revocation denylist and role-based
ACL all keep working unchanged.

```ts
import { authSchema, createOidcAuth, oidcHandlers } from "@pramen/auth";

const oidc = createOidcAuth({
  issuer: "https://login.microsoftonline.com/<tenant>/v2.0",  // discovery does the rest
  clientId: "…",
  clientSecret: "…",                       // omit for a public client (PKCE only)
  redirectUri: "https://app.example.com/auth/oidc/callback",
  successRedirect: "https://app.example.com/signed-in",
});

export const app = {
  schema: defineSchema({ ...authSchema /* … */ }),
  handlers: { ...authHandlers, ...oidcHandlers },
  routes: [...oidc.routes],                // PRE-AUTH: a caller here has no session yet
  acl,
};
```

The browser hits `/auth/oidc/start`, comes back to `/auth/oidc/callback`, and lands on
`successRedirect#token=<session>`. The token arrives in the URL **fragment**, which is never
sent to a server, so it stays out of access logs, proxies and `Referer` headers.

**Silent sign-in.** `/auth/oidc/start?prompt=none` signs in a browser that already has a
session at the provider without showing it anything: the provider redirects straight back
and the browser lands on `successRedirect#token=…` as usual. When the provider would need the
user (no session there, consent, account choice), it answers with an OIDC error instead of a
screen, and the browser lands on `successRedirect#error=login_required` (or
`interaction_required`, `consent_required`, `account_selection_required`) with **no token**.
Show your ordinary sign-in button then. A silent attempt that fails on pramen's side after the
provider said yes lands there too, with a pramen code: `account_deactivated`,
`email_not_verified`, `invalid_token` or `server_error`. Any other provider code (a
misconfigured client, an outage) is handed back the same way and logged as an error on the
server. Treat every `error=` as "show sign-in". Any `prompt` other than `none` is refused.

```ts
// On load, when there is no stored session:
const hash = new URLSearchParams(location.hash.slice(1));
if (!hash.has("token") && !hash.has("error") && !sessionStorage.getItem("oidcSilentTried")) {
  sessionStorage.setItem("oidcSilentTried", "1");
  location.assign(`/auth/oidc/start?prompt=none&returnTo=${encodeURIComponent(location.pathname + location.search)}`);
}
```

The `sessionStorage` flag is not optional: try silently **once per visit**, and never when the
fragment already carries `error=`. Without it a user with no provider session bounces between
your app and the provider forever. The error redirect is only issued to the browser that
started the attempt (the binder cookie below); a crafted callback URL gets the ordinary error
page.

**Signing out at the provider too (`endSession: true`).** An app that signs in silently on
page load has a catch: signing out of the app only drops the pramen session, the provider
session lives on, and the very next sign-in page signs the user straight back in. OpenID
Connect RP-Initiated Logout fixes that, and `endSession` wires it:

- the success fragment also carries `id_token=<the provider's ID token>` next to `token=`; keep
  it with the session (it is the provider's proof of this sign-in, needed to end it);
- `routes` gains a third route, `POST /auth/oidc/logout` (`logoutPath` to move it), with body
  `{ "idToken": "…" }`. It serves only the app's own pages (the `Origin` header must be the
  origin of `successRedirect` or `redirectUri`; a missing one is refused) and only a token
  issued within `sessionTtlSeconds` plus five minutes, so an old ID token is not a lasting
  "sign this person out" capability. It verifies the token's signature, issuer and audience
  (not `exp`: by logout it has usually expired), then calls the provider's
  `end_session_endpoint` server to server with it as `id_token_hint`. The pramen session is
  untouched: drop it in the browser as before.

| Answer | Meaning |
| --- | --- |
| 200 `{ ok: true, provider: "signed_out" }` | the provider ended its session (2xx or 3xx) |
| 403 `{ ok: false, error: "forbidden_origin" }` | not a page of this app |
| 400 `{ ok: false, error: "invalid_token" }` | missing, forged, or for another client or issuer |
| 400 `{ ok: false, error: "stale_token" }` | older than any session it could belong to, or no `iat` |
| 501 `{ ok: false, error: "unsupported" }` | no `end_session_endpoint` in discovery |
| 502 `{ ok: false, error: "provider_failed", status }` | the provider refused or was unreachable (`status: 0`), see `endSessionTimeoutMs` |
| 502 `{ ok: false, error: "server_error" }` | anything else, e.g. discovery down |

Only `signed_out` means the provider session is gone. Treat every `ok: false` as "still signed
in at the provider" and tell the user, rather than sending them to a sign-in page that would
sign them straight back in. Failures are logged without the token.

The provider decides which of its sessions ends from the token's `sid` claim, so the client
must be registered with logout enabled there. Point the editor's `signOutUrl` (see
`@pramen/cms-astro`) at a page of yours that posts the stored ID token here and then goes on
to your sign-in page; expiry still goes to `signInUrl`, so only a deliberate sign-out ends the
provider session.

**Where roles come from** is the part that differs per provider, and the part that fails
quietly if you get it wrong:

| Provider | Roles in the ID token | What to configure |
| --- | --- | --- |
| Microsoft Entra | top-level `roles` | `mapRoles: (c) => c.roles as string[]` |
| Auth0 / Okta | a namespaced claim | `mapRoles: (c) => c["https://acme.com/roles"] as string[]` |
| Google Workspace | **none** | omit `mapRoles` and manage roles in pramen |

With `mapRoles` the IdP is authoritative and its answer overwrites the stored roles on every
login, including a removal. Without it, roles live on the user's row and a first login gets
`defaultRoles`.

**Accounts are keyed on the verified email** by default, so an OIDC login lands on the same
row as a magic-link or password login for that address. A provider that does not assert
`email_verified` is refused rather than trusted, because otherwise an IdP allowing arbitrary
addresses would be a takeover path into any existing account. Use `accountKey: "sub"` to key
on the provider's opaque subject (namespaced by issuer) instead; that survives an email
change but will not link up with accounts created another way.

Deactivating a user in pramen still holds: `active = false` blocks the login even though the
IdP knows nothing about that flag.

**The profile.** Every sign-in also stores what the provider says about the person on the
user's row (`auth_users.profile`, JSON), and `me` returns it as `profile` next to `userId` and
`roles` (`null` for a user without one; an anonymous `me` is unchanged). By default it is the
standard `name` and `picture` claims, with `picture` kept only as an absolute `https:` URL;
`mapProfile` replaces that when your provider sends something else worth showing:

```ts
createOidcAuth({
  // ...
  mapProfile: (c) => ({ ...defaultOidcProfile(c), team: c["https://acme.com/team"] ?? null }),
});
```

Like roles under `mapRoles`, the provider is authoritative: each sign-in overwrites the stored
profile, and a mapper returning `null` clears it. A mapper that throws is logged and stores no
profile rather than blocking the sign-in. The editor shows `profile.name` and
`profile.picture` in its account menu (see the `account` slot in `@pramen/cms-editor`). The
profile is visible to the user and to admins, so keep tokens and secrets out of it. The column
is additive: an existing `auth_users` table gains it on the next migrate.

When using a custom users table, pass the same `table` to **every** auth factory you use:
`createAuthHandlers`, `createMagicLinkAuth`, `createOidcAuth`, `createUserHandlers`,
`createPasswordReset`, `createEmailVerification` and `authPolicies`. A factory left on the
default reads `auth_users`, finds nobody, and fails quietly: a password reset answers
`{ ok: true }` and sends nothing. Mind `refreshSession` in particular: both
`createAuthHandlers` and `createMagicLinkAuth` export one, and whichever you spread last
serves every caller. The table must have the `authSchema.auth_users` shape, including the
`profile` column. The default admin read policy includes `profile`; a custom
`adminReadFields` list must include it explicitly to expose it through `listUsers`.

A session minted from a custom table carries a `usersTable` claim, and `refreshSession`, `me`
and the self-service handlers (`changeEmail`, `changePassword`, `requestEmailVerification`)
honor a session only from their own table (no claim means `auth_users`). The JWT `sub`
is a bare username, so without it a `members` handler would reissue `auth_users`' "ada" a
token with `members`' "ada"'s roles. The KV denylist is still keyed by username alone:
deactivating or deleting "ada" in one table revokes every "ada" session, whichever table it
came from. That errs toward revoking too much, but if you run two tables, keep their
usernames disjoint.

**The flow sets one cookie per sign-in attempt**, `pramen_oidc_<hash of the state>`: HttpOnly,
SameSite=Lax, scoped to the callback path, cleared when the attempt ends. Per attempt, not
per browser, because silent sign-in runs in every tab and overlapping attempts must not
overwrite each other's binder. It binds the `state` to the browser that started the
login, which is what stops login CSRF: an attacker holding a valid `state` + `code` from
their own login can otherwise feed them to a victim's browser and sign that victim in **as
the attacker**, so everything the victim then writes lands in the attacker's account. These are
the only cookies pramen uses; sessions remain bearer tokens. `Secure` is set on https and
omitted on plain http, so local dev still completes.

If your frontend **already** holds an IdP token, you do not need any of this. Set
`JWKS_URL` (plus `AUTH_ISSUER` / `AUTH_AUDIENCE`) and the core verifies it directly. See
[Verification strategies](#verification-strategies).

### Magic link (passwordless)

`createMagicLinkAuth({ sendEmail })` adds a one-time, single-use, time-boxed email
link flow. Transport is **your** choice: you supply `sendEmail`; pramen owns the
token lifecycle (a 256-bit token stored only as a SHA-256 hash, default 15-min TTL).

```ts
import { magicLinkSchema, createMagicLinkAuth } from "@pramen/auth";

const magic = createMagicLinkAuth({
  // Deliver via ctx.mail: Cloudflare Email Sending when configured (MAIL_FROM + the
  // EMAIL binding), captured in dev. See the Deferred Tasks page for ctx.mail.
  sendEmail: async (ctx, { email, token }) => {
    const link = `${ctx.env.APP_URL}/auth?token=${token}`;
    await ctx.mail.send({ to: email, subject: "Your sign-in link", text: `Sign in: ${link}` });
  },
});

const schema = defineSchema({ ...authSchema, ...magicLinkSchema /* … */ });
const handlers = { ...authHandlers, ...magic /* … */ };
```

- **`requestMagicLink({ email })`** → always `{ ok: true }` (no enumeration); mints a
  token, persists its hash, and calls `sendEmail`.
- **`loginWithMagicLink({ token })`** → `{ token, user }`. Validates (unexpired,
  unconsumed), consumes single-use, and find-or-creates the user.
- **`refreshSession()`**: the same handler `authHandlers` exposes, at this factory's
  configured TTL. Passwordless users renew without a new email round-trip.

Magic-link users are keyed by their **`username`** (their email address *is* their
username), so login never resolves identity by the mutable `email` column. Declare the
`send_email` binding in `oblaka.ts` (`EmailService`); see
[Quick start: Workers binding](https://developers.cloudflare.com/email-service/).

### Migrating in existing password hashes

Moving users in from another system means importing hashes that are not PBKDF2:
bcrypt from Contember or Rails, `pbkdf2_sha256$` from Django, and so on. They cannot be
converted (that needs the plaintext), so the alternative would be forcing every user to
reset their password.

Instead, store the foreign hash under its own **scheme prefix** and register a verifier
for it. Login accepts it, then **upgrades the row to PBKDF2** on the first successful
sign-in, the one moment the plaintext is in hand:

```ts
import bcrypt from "bcryptjs";
import { registerPasswordVerifier } from "@pramen/auth";

// Call once at module scope, before any login can run.
registerPasswordVerifier("bcrypt", (password, payload) => bcrypt.compare(password, payload));
```

Import rows with the prefix applied. A bcrypt hash is itself `$2b$10$…`, so the stored
value reads `bcrypt$$2b$10$…`:

```sql
INSERT INTO auth_users (username, passwordHash, roles, email, createdAt)
VALUES (?, 'bcrypt$' || ?, '["user"]', ?, ?);
```

Nothing else changes. Users log in with their existing passwords, each row converts
silently as its owner returns, and the scheme drains away: accounts that never come
back simply keep their old hash, which costs nothing.

pramen does **not** bundle a bcrypt implementation. WebCrypto has none, so it would
mean a pure-JS library in every bundle, including the apps that never import anything.
The verifier is yours to supply.

Notes:

- **Unregistered schemes fail closed.** An unknown prefix never verifies, the same as
  before the hook existed. A verifier that throws is also treated as a failed
  verification, never a 500.
- **Only successful logins upgrade.** A wrong password, or a deactivated account,
  leaves the row untouched.
- **Timing.** The not-found path is equalized against PBKDF2. A foreign scheme with a
  different cost profile (bcrypt cost 10 is cheaper than PBKDF2-600k) is
  distinguishable by timing, which leaks *which scheme a given account uses*, roughly
  whether the account predates the migration. Usually acceptable; worth knowing.
- `resetPassword` and `changePassword` always write PBKDF2, so those paths upgrade too.

### User management

`createUserHandlers()` + `authPolicies()` add admin + self-service account management
over `auth_users`, authorized **declaratively by the ACL** (not imperative role
checks). The handlers are inert until you grant access: spread `authPolicies().admin`
into your admin role and `.self` into your authenticated-user role:

```ts
import { userHandlers, authPolicies } from "@pramen/auth";

const handlers = { ...authHandlers, ...userHandlers /* … */ };

const acl = [
  role("admin", [...authPolicies().admin, /* your other admin policies */]),
  role("user",  [...authPolicies().self,  /* your other user policies  */]),
];
```

- **Admin:** `listUsers`, `setUserRoles`, `setUserActive` (deactivate/reactivate),
  `deleteUser`. Reads are projected, so `passwordHash` is never returned.
- **Self:** `changeEmail` (unique, validated), `changePassword`.

`changePassword` follows one rule: **an empty password slot may be filled by the session, a
filled one only by proving you know it.** An account created by `inviteUser` or a magic-link
login has no `passwordHash`, so it passes an empty `currentPassword` and gets its FIRST
password; the response says `firstPassword: true`. An account that already has one still has
to send the current password, and a wrong or empty one is a 401, so a stolen session can
never *replace* a credential, only fill a slot that was empty anyway.

Without that first branch, "I signed in with a link and now I want a password" had no answer
at all: the account was asked for a credential it had never had, and told the one it invented
was incorrect. The password-RESET flow was the only way through, which is a flow named for a
problem the user does not have.

Deactivating or deleting a user **revokes their outstanding tokens immediately**: the
handlers write a KV denylist entry the Worker enforces. A `setUserRoles` change is
softer: it lands on the user's next `refreshSession` (or login). Both are covered in
[Sessions & revocation](#sessions-revocation).

**Custom table.** `createUserHandlers({ table })` points the same handlers at your own
`auth_users`-shaped table, e.g. one with an extra `tenants` column for multi-tenant
accounts. Pair it with `authPolicies({ table, prefix, adminReadFields, adminWriteFields })`
to give the instance unique policy names and to expose/permit the extra columns:

```ts
const accounts = createUserHandlers({ table: "org_accounts" });
const policies = authPolicies({
  table: "org_accounts",
  prefix: "org",
  adminReadFields: ["username", "roles", "email", "active", "tenants", "createdAt"],
  adminWriteFields: ["roles", "email", "active", "tenants"],
});
```

The table must have a `username` PK (and, for `changeEmail`/`changePassword`,
`email`/`passwordHash` columns); extra columns are ignored by the built-ins and
managed by your own handlers.

## Sessions & revocation

Tokens are **stateless**: roles and `active` are baked in at login, and the Worker does
no per-request database lookup. That is what keeps the core verify-only and reads
cheap, but it means a token outlives a change to the account behind it. pramen closes
that gap two ways, still with no session store.

### Silent refresh

**`refreshSession()`** (authenticated; in both `authHandlers` and
`createMagicLinkAuth`) re-reads `roles` and `active` for the caller and reissues a
token: `{ token, user }`, the same shape as `login`. It throws `401` if the account
is gone or deactivated, so a refresh can never launder a revoked session into a new,
longer-lived one.

Refreshing at **~half the TTL** lets you keep `AUTH_SESSION_TTL_SECONDS` short without
ever logging the user out, which bounds how long a stale role can linger. It also
works in the granting direction: a new role applies **immediately**, with no re-login.
call it right after a subscription checkout or plan upgrade.

```ts
// after the purchase that granted the role
const { token } = await pramen.call("refreshSession");
pramen.setToken(token); // also reconnects the live socket under the new identity
```

### Hard revocation (denylist)

For a deactivation, deletion, or credential compromise, waiting out the TTL is not
good enough. `setUserActive(false)` and `deleteUser` write a **KV denylist** entry
(`authDenied:<username>`) that the Worker checks immediately after resolving identity:
before any handler, and before both the DO and D1 paths, so it covers HTTP and the
WebSocket upgrade alike. A denied token fails **closed** with `401` (it is *not*
downgraded to anonymous), so revocation takes effect on the **next request** rather
than the next login.

The entry carries an `expirationTtl` equal to the session TTL, so it self-expires
exactly when the last token that could have been outstanding at revocation time does, so
the denylist only ever holds recently-revoked users and never grows unbounded.
Reactivating (`setUserActive(true)`) lifts the entry: the key is username-scoped, so a
stale entry would otherwise lock out even a fresh login.

The helpers are exported from `@pramen/server` so an app can revoke on its own signals
(a compromise report, a fraud check) without going through `createUserHandlers`:

```ts
import { denySession, allowSession, isSessionDenied } from "@pramen/server";

await denySession(ctx.kv, username, 3600); // block every token for this user, up to 1h
```

> KV is eventually consistent: a denylist write can take up to ~60s to become visible
> in every region, and the entry TTL is clamped to KV's 60s minimum. Treat it as a kill
> switch, not a transactional gate. Routine role changes belong on `refreshSession`.

### Live connections

A WebSocket verifies its token **once, at upgrade**, and the identity is then fixed for
the life of the socket, so a long-lived or hibernating connection could otherwise
outlive its TTL indefinitely. The DO therefore re-checks the token's `exp` on every
message: an expired socket receives an `unauthorized` error frame, is closed with
**4401**, and stops receiving subscription pushes. The client should re-authenticate
and reconnect (`@pramen/client`'s `setToken` does this for you). See
[Live Queries](/docs/live-queries).

## Tenancy

Each tenant is a Durable Object addressed by the `X-Pramen-Tenant` header (default
`main`). Durable Objects can't be enumerated, so a tenant's name is recorded in a KV
registry on its first touch; admins can list them at `GET /tenants`.

Before reaching the DO, the Worker **authorizes the tenant** against the caller
(`authorizeTenant` in `src/auth.ts`): by default admins may access any tenant, and
everyone else only the tenants listed in their `tenants` claim. Customize this for
your tenancy model (e.g. `tenant === identity.org`).

## Point-in-time recovery

SQLite-backed DOs have 30-day point-in-time recovery. An admin can restore a tenant
to a past moment:

```bash
curl -s -X POST http://localhost:8787/admin/recover \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"tenant":"acme","timestamp":1718000000000}'
```

> PITR is platform-only, unavailable in local dev (returns 501). pramen arms the
> restore and returns an `undo` bookmark; it completes on the DO's next restart.
