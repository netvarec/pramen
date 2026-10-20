---
title: CLI & Deploy
order: 12
summary: The pramen CLI, and deploying to Cloudflare via oblaka + wrangler.
---

## CLI

```bash
bun run pramen help
bun run pramen init my-app                        # scaffold app.ts + oblaka.ts
bun run pramen token alice author --tenant acme   # mint a dev JWT
bun run pramen schema sql                         # CREATE TABLE for the schema
bun run pramen schema snapshot                    # baseline in .pramen/schema.json
bun run pramen schema diff                        # additive vs destructive changes
bun run pramen schema status --tenant acme        # is a deployed tenant caught up?
bun run pramen migrations list                    # declared data migration ids, in order
bun run pramen migrations status --tenant acme    # applied vs pending data migrations
bun run pramen migrations status --all-tenants    # the whole fleet (fans out over /tenants)
```

`migrations status` is the "is it safe to delete this migration?" answer: migration is
lazy and per-DO, so an untouched tenant is still unmigrated and no local artifact knows
it. See [Migrations](/docs/migrations#data-migrations).

## Configuration: oblaka

Cloudflare topology is declared in **`oblaka.ts`** (the source of truth): the
Worker, the `PRAMEN` Durable Object, its SQLite migration, vars, and observability.
`oblaka` generates `wrangler.jsonc` from it (git-ignored; never edit by hand).

Each project sets a unique `PROJECT` in `oblaka.ts`, which names the Worker, the DO,
and the KV namespace, so multiple projects in one Cloudflare account never collide.

## Deploy

```bash
bun run config         # oblaka oblaka.ts          -> generate wrangler.jsonc (local)
bun run dev            # regenerate + lopata dev (local runtime)
bun run dev:wrangler   # regenerate + wrangler dev (workerd-parity check)
bun run plan           # oblaka --remote --env production --dry-run  -> preview remote changes

# Real deploy: provision resources via oblaka, then ship the code via wrangler.
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
bun run deploy                      # oblaka --remote --env production (provision) && wrangler deploy
wrangler secret put AUTH_SECRET     # then the real secret, on the script the deploy created
```

**The env has to reach oblaka, not just wrangler.** oblaka falls back to the `local` env
when it is given neither `--env` nor `CLOUDFLARE_ENV`, even with `--remote`, and the local
block in `oblaka.ts` carries a published `AUTH_SECRET`, `CORS_ORIGINS=*` and the dev-account
seed. `bun run deploy --env production` does NOT pass the flag to oblaka: bun appends extra
arguments to the last command of the `&&` chain only, which is `wrangler deploy`. So the
`deploy` and `plan` scripts name `--env production` on the oblaka command themselves, and
`oblaka.ts` throws if it is asked to render `local` for `--remote`, so a missing env fails
the deploy instead of shipping dev values. To deploy another env, run the two halves
yourself: `oblaka oblaka.ts --remote --env staging --state-namespace pramen-iac-state &&
wrangler deploy`.

**Set secrets after the deploy, on the script it created.** oblaka names the remote Worker
`${env}-${PROJECT}` (`production-pramen`) and writes that name into `wrangler.jsonc`, which is
what a plain `wrangler secret put` then targets. Run it before the first deploy and it lands
on whatever name the local config had, never on the deployed script. Until `AUTH_SECRET` is
set the deployed Worker rejects every token (auth fails closed), and a short-lived window
like that is the safe direction to be wrong in.

The dev-account seed (`pramen@local`) is registered only by `example/dev-worker.ts`, the
entry the `local` env points `main` at. The deployed entry, `example/worker.ts`, never
registers it, whatever vars a deploy carries.

`oblaka --remote` provisions the Worker + Durable Object (and the SQLite DO
migration) on Cloudflare and writes the config; `wrangler deploy` bundles and
uploads the Worker entry (`worker.ts`, your `createPramen(app)` call).

## Testing

`bun test` generates the config from `oblaka.ts`, boots a single `wrangler dev`
against fresh local state, and runs every suite (each on its own tenant): ACL,
cell-level ACL, relations, live-query invalidation, pagination, aggregates, auth,
migrations, and more. CI runs typecheck + `bun test` on every push/PR; no Cloudflare
credentials are needed (miniflare).
