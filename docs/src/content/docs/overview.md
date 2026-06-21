---
title: Overview
order: 1
summary: What pramen is, and how the Worker + Durable Object architecture works.
---

**pramen** is a reactive backend runtime for TypeScript on Cloudflare. You define a
schema and handlers; pramen gives you a complete backend deployed as a **Worker** in
front of a per-tenant **Durable Object** whose in-process SQLite *is* the database.

## Architecture

```
createPramen(app) -> { fetch, PramenDO }
  Worker (fetch)  ->  PramenDO (per-tenant Durable Object)
                        ├─ ctx.storage.sql   in-process SQLite (the DB)
                        ├─ schemaDDL on boot (blockConcurrencyWhile)
                        └─ dispatch: query -> run; mutation -> storage.transaction()
```

The runtime ships as `@pramen/server`; your project is just `app.ts`, `oblaka.ts`,
and a 3-line `worker.ts` that calls `createPramen(app)`.

- **The DO is the database.** A Durable Object handles one request at a time, so
  single-writer serialization is free. Each tenant is its own DO, addressed by
  `idFromName` (the `X-Pramen-Tenant` header; default `main`).
- **The Worker is the stateless front door.** It verifies the bearer JWT,
  authorizes the tenant, and forwards a trusted identity to the DO — which never
  re-derives it.
- **The SDK (`@pramen/server`, `packages/server/src/sdk/`) is platform-agnostic** —
  the portable product surface. `packages/server/src/runtime/` is the Cloudflare glue.

## What you get

- A typed query/mutation layer over the schema (`ctx.db`), with no hand-written SQL.
- **Deny-by-default ACL** with row-level scopes and **cell-level (per-row) field
  permissions**.
- **Live queries** over WebSockets — the server pushes fresh results whenever a
  mutation writes a table a subscription reads.
- **Pluggable auth** (HS256 shared secret, or RS256 against a JWKS).
- **File storage** on R2 — a `fileRef` column + `ctx.files` signed URLs, with
  direct-to-storage uploads that never touch the database.
- **Automatic migrations** on every boot — additive and destructive.
- Typed end-to-end clients (`@pramen/client`, `@pramen/react`) and a CLI.

## Local development

```bash
bun install
bun run dev   # lopata dev — fast reload + a dashboard at /__dashboard
```

`bun run dev` runs on [lopata](https://github.com/contember/lopata), a Bun-based
Cloudflare runtime that fully emulates DO SQLite and WebSocket hibernation. Run
`bun run dev:wrangler` once before deploying to check workerd parity.
