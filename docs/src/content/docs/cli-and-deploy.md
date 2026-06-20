---
title: CLI & Deploy
order: 9
summary: The mrak CLI, and deploying to Cloudflare via oblaka + wrangler.
---

## CLI

```bash
bun run mrak help
bun run mrak init my-app                        # scaffold app.ts + oblaka.ts
bun run mrak token alice author --tenant acme   # mint a dev JWT
bun run mrak schema sql                         # CREATE TABLE for the schema
bun run mrak schema snapshot                    # baseline in .mrak/schema.json
bun run mrak schema diff                        # additive vs destructive changes
bun run mrak schema status --tenant acme        # is a deployed tenant caught up?
```

## Configuration: oblaka

Cloudflare topology is declared in **`oblaka.ts`** (the source of truth) — the
Worker, the `MRAK` Durable Object, its SQLite migration, vars, and observability.
`oblaka` generates `wrangler.jsonc` from it (git-ignored; never edit by hand).

Each project sets a unique `PROJECT` in `oblaka.ts`, which names the Worker, the DO,
and the KV namespace — so multiple projects in one Cloudflare account never collide.

## Deploy

```bash
bun run config         # oblaka oblaka.ts          -> generate wrangler.jsonc (local)
bun run dev            # regenerate + lopata dev (local runtime)
bun run dev:wrangler   # regenerate + wrangler dev (workerd-parity check)
bun run plan           # oblaka --remote --dry-run  -> preview remote changes

# Real deploy: provision resources via oblaka, then ship the code via wrangler.
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
wrangler secret put AUTH_SECRET     # production auth secret (overrides the dev var)
bun run deploy --env production     # oblaka --remote (provision) && wrangler deploy
```

`oblaka --remote` provisions the Worker + Durable Object (and the SQLite DO
migration) on Cloudflare and writes the config; `wrangler deploy` bundles and
uploads `src/index.ts`.

## Testing

`bun test` generates the config from `oblaka.ts`, boots a single `wrangler dev`
against fresh local state, and runs every suite (each on its own tenant) — ACL,
cell-level ACL, relations, live-query invalidation, pagination, aggregates, auth,
migrations, and more. CI runs typecheck + `bun test` on every push/PR; no Cloudflare
credentials are needed (miniflare).
