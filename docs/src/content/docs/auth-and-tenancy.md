---
title: Auth & Tenancy
order: 6
summary: Pluggable JWT verification (HS256 or RS256/JWKS), identity mapping, and per-tenant authorization.
---

The Worker verifies a **bearer JWT** (WebCrypto), checks `exp`/`nbf`, and maps
claims to an `Identity`: `sub` → `userId`, `roles`/`role` → roles, and any custom
claims pass through. A forged or unsigned request gets no identity (and is denied by
the deny-by-default ACL). The trusted identity is forwarded to the DO, which never
re-derives it.

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

## Tenancy

Each tenant is a Durable Object addressed by the `X-Mrak-Tenant` header (default
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

> PITR is platform-only — unavailable in local dev (returns 501). mrak arms the
> restore and returns an `undo` bookmark; it completes on the DO's next restart.
