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

The core is **verify-only** — bring your own identity provider (any HS256/JWKS
issuer). When you don't want a third-party IdP, the optional **`@pramen/auth`**
package issues tokens the verifier accepts (see [Login with @pramen/auth](#login-with-pramenauth)).

## Verification strategies

Verification is pluggable via `VerifyStrategy` (`src/auth.ts`), selected from env:

### HS256 — shared secret (default)

`HmacStrategy` verifies with the symmetric secret in `AUTH_SECRET` (dev value in
`wrangler.jsonc`; production via `wrangler secret put AUTH_SECRET`). Good for
internal services and the test suite.

### RS256 — JWKS

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
accepts — so an app can have logins without standing up a third-party IdP. Spread its
schema fragment into your schema and its handlers into your handler map:

```ts
import { authSchema, authHandlers } from "@pramen/auth";

const schema = defineSchema({ ...authSchema, notes: Entity(/* … */) });
const handlers = { ...authHandlers, ...yourHandlers };
```

It needs `AUTH_SECRET` in the environment. The `auth_users` table stores `username`
(the PK and JWT `sub`), a PBKDF2 `passwordHash` (a [`hidden()`](/docs/schema-and-handlers#hidden-columns)
column — never returned by a read), `roles`, a mutable unique `email`, and an
`active` flag.

- **`signup({ username, password })`** → `{ token, user }`. Roles are assigned
  server-side (default `["user"]`); a client never picks its own roles.
- **`login({ username, password })`** → `{ token, user }`. A wrong password, unknown
  user, or **deactivated** account all return `401` (no account enumeration).
- **`me()`** → the caller's `Identity`.

Token lifetime defaults to 1h; set `AUTH_SESSION_TTL_SECONDS` to tune it (a shorter
TTL tightens the window before a role change or deactivation takes effect — see
[user management](#user-management)).

### Magic link (passwordless)

`createMagicLinkAuth({ sendEmail })` adds a one-time, single-use, time-boxed email
link flow. Transport is **your** choice — you supply `sendEmail`; pramen owns the
token lifecycle (a 256-bit token stored only as a SHA-256 hash, default 15-min TTL).

```ts
import { magicLinkSchema, createMagicLinkAuth } from "@pramen/auth";

const magic = createMagicLinkAuth({
  // Deliver via ctx.mail — Cloudflare Email Sending when configured (MAIL_FROM + the
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

Magic-link users are keyed by their **`username`** (their email address *is* their
username) — login never resolves identity by the mutable `email` column. Declare the
`send_email` binding in `oblaka.ts` (`EmailService`); see
[Quick start — Workers binding](https://developers.cloudflare.com/email-service/).

### User management

`createUserHandlers()` + `authPolicies()` add admin + self-service account management
over `auth_users`, authorized **declaratively by the ACL** (not imperative role
checks). The handlers are inert until you grant access — spread `authPolicies().admin`
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
  `deleteUser`. Reads are projected — `passwordHash` is never returned.
- **Self:** `changeEmail` (unique, validated), `changePassword` (verifies the current
  one).

Role and `active` changes take effect on the user's **next login** — the verify-only
core has no session store, so a token stays valid until it expires. Shorten
`AUTH_SESSION_TTL_SECONDS` to narrow that window, or keep a per-user denylist in
`ctx.kv` for immediate revocation.

**Custom table.** `createUserHandlers({ table })` points the same handlers at your own
`auth_users`-shaped table — e.g. one with an extra `tenants` column for multi-tenant
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

> PITR is platform-only — unavailable in local dev (returns 501). pramen arms the
> restore and returns an `undo` bookmark; it completes on the DO's next restart.
