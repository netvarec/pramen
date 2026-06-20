# pramen — status & architecture

A reactive backend runtime for TypeScript **on Cloudflare**. You define a schema
and handlers; you get a complete, ACL-enforced, real-time backend deployed as a
Worker + Durable Object. See [DESIGN.md](./DESIGN.md) for the architecture and
rationale.

Status: **working end-to-end, fully tested**, now a Bun-workspace **monorepo**:
the server/runtime (root `src/`) plus publishable client libraries
(`@pramen/client`, `@pramen/react`) and a `pramen` CLI. Active development; WIP; no
backward-compat constraints.

## The spine — one request

```
client ──HTTP /rpc/<h> or WS /live──►  Worker (src/index.ts)
                                        │  auth.ts: verify HS256 JWT -> Identity
                                        │  route per tenant: idFromName(x-pramen-tenant)
                                        ▼
                                   PramenDO  (one Durable Object per tenant)
                                        │  boot: migrate() reconciles schema (no data loss)
                                        │  dispatch(handler):
                                        │    • warmup() dynamic ACL resolvers (system db)
                                        │    • run handler with a fresh, ACL-scoped Db
                                        │    • mutations wrapped in storage.transaction()
                                        ▼
                                   ctx.storage.sql  (in-process SQLite = the database)
                                        │  every find/insert/update/delete is ACL-checked
                                        ▼
   on a committed mutation: broadcast() re-runs each subscription whose touched
   tables changed, under that socket's identity, and pushes only when the
   result digest changed (row-level invalidation).
```

The **Durable Object is the database**: SQLite storage in-process, single-writer
by the platform (one request at a time), per-tenant via `idFromName`. That single
fact gives pramen — for free — single-writer serialization, transactional
mutations, and a place that sees every write (so live-query invalidation is
exact).

## Subsystems

| Area | What it does | Files |
|---|---|---|
| **Auth** | Verify HS256 bearer JWT (WebCrypto) → Identity; forward to DO. Client can't spoof identity. | `src/auth.ts` |
| **Schema/SDK** | `Entity()/defineSchema()` with field + relation builders; `createApp(schema)` → typed `query/mutation`. Portable, no platform dep. | `src/sdk/{schema,app,handlers}.ts` |
| **Typed inference** | `InferRow/WhereInput/InferInsert/InferUpdate/RelationsResult` derived from the schema; `ctx.db` fully typed. | `src/sdk/infer.ts` |
| **ACL** | Deny-by-default; roles/policies; row-level `where` scopes (with operators + `$identity`), field projection, relation/`directAccess` traversal, dynamic `resolve()`, write-side `set`/`validate`. Per-identity. | `src/sdk/acl.ts`, `src/runtime/acl.ts` |
| **Read engine** | `SqlExpr` AST + `compileWhere/compileSelect/compileCount/compileAggregate`. Operators, AND/OR, multi-orderBy, limit/offset, keyset cursor, count/aggregates. Identifiers validated; values parameterized. | `src/runtime/read-engine.ts` |
| **Repository** | The single ACL chokepoint: `find/page/count/aggregate/insert/update/delete`, eager relation loads (batched `IN`), field projection. | `src/runtime/db.ts` |
| **KV (ctx.kv)** | Handlers get a prefixed (`app:`) KV wrapper for GLOBAL (cross-tenant) config/flags/cache — not per-tenant, not transactional. | `src/runtime/kv.ts` |
| **Reactivity** | Live queries over Hibernatable WebSockets; per-socket identity + subscriptions in `serializeAttachment`; table-prefilter + per-subscription result digest for row-level pushes; sub cap. | `src/durable-object.ts`, `src/runtime/{protocol,digest}.ts` |
| **Migrations** | On DO boot: create tables + additive `ADD COLUMN`, gated by a schema hash in `_pramen_meta`. No data loss. | `src/runtime/{migrate,ddl}.ts` |
| **Errors** | Typed envelope `{ ok, error, code }` + status; internal errors logged, returned as generic 500. | `src/runtime/errors.ts` |
| **Dispatch** | Resolve handler, optional input validator (→400), warmup, run, report `touched` tables. | `src/runtime/dispatch.ts` |
| **Tenancy** | Worker authorizes `x-pramen-tenant` against the identity (`authorizeTenant`). DOs aren't enumerable, so each tenant self-registers in a KV registry on first touch; admin `GET /tenants` lists them. | `src/auth.ts`, `src/durable-object.ts`, `src/index.ts` |
| **Recovery** | 30-day point-in-time recovery (platform). Admin `POST /admin/recover {tenant,timestamp}` arms a restore, returns the `undo` bookmark. Local dev → 501 (PITR is platform-only). | `src/durable-object.ts`, `src/index.ts` |
| **Deploy (IaC)** | `oblaka.ts` is source of truth → generates `wrangler.jsonc`; `oblaka --remote` provisions, `wrangler deploy` ships code. | `oblaka.ts` |
| **Client** | `@pramen/client` — typed `call()` (RPC/HTTP) + `subscribe()` (live queries over a reconnecting WS). Generic over `typeof app.handlers`; no runtime dep on the server. | `packages/client` |
| **React** | `@pramen/react` — `useLiveQuery` (re-renders on every push) + `useMutation`. | `packages/react` |
| **CLI** | `pramen` — help, init, token, and schema sql/hash/snapshot/diff/status (additive-aware diff; status vs a deployed tenant). | `scripts/cli.ts`, `src/runtime/schema-diff.ts` |
| **Tests/CI** | `bun test` boots one `wrangler dev`, runs all e2e suites on isolated tenants + the client lib + CLI/migrate/diff units. CI on push/PR. | `test/**`, `.github/workflows/ci.yml` |

## What's done (17 commits)

Scaffold → live queries → row-level invalidation → ACL (roles/policies/scopes) →
dynamic resolvers → typed inference → verified JWT auth → relations + nested ACL
(directAccess) → write-side ACL (set/validate) → oblaka deploy → test harness +
CI → query operators/OR-AND/pagination → schema migrations → hardening (safe
errors, input validation, batched relations, WS limits) → cursor pagination →
count + aggregates → operators in ACL where rules → tenant registry → tenant
authorization + admin point-in-time recovery → ctx.kv + per-project naming →
monorepo + @pramen/client + @pramen/react + pramen CLI.

Every feature is verified by an e2e suite (`test/suites/*`) and, where it's
type-level, by `example/inference-check.ts` (`@ts-expect-error` cases). All green.

## Known limitations (honest)

- **ACL field permissions are row-agnostic** — fields union across OR'd policies.
  Per-row field coupling is unimplemented.
- **Aggregate results are loosely typed** (dynamic keys) — `count` is typed.
- **Field projection is statically unsound** — a projected row is narrower than
  its inferred type.
- **Migrations are additive only** — no drops/renames/type changes (orphan
  columns remain); no destructive/explicit migration story.
- **App is statically imported** by the DO — no dynamic bundle deploy; a new app
  means a redeploy.
- **Read engine is TS, not WASM** — fine (no perf problem); a zero-JS read path is
  future work.
- **Auth is HS256 shared-secret** — RS256/EdDSA + JWKS is a localized swap.
- **PITR can't be tested locally** — point-in-time recovery is platform-only, so
  `bun test` covers only the recovery endpoint's auth/validation; the actual
  restore is verifiable only against a deployed DO.

## Roadmap (none pressing)

`having`/ordered aggregates · count-aware live queries · cell-level conditional
fields / hard-deny ACL · destructive migrations · dynamic bundle deploy ·
ReadEngine → WASM · local dev via **lopata**.

## Commands

```bash
bun install        # links workspace packages (@pramen/client, @pramen/react)
bun run dev        # oblaka generates wrangler.jsonc, then wrangler dev
bun test           # boot one server, run every suite + units (no CF creds; miniflare)
bun run typecheck  # server + @pramen/client + @pramen/react
bun run deploy     # oblaka --remote (provision) + wrangler deploy (code)
bun run pramen help  # the CLI (init / token / schema sql|diff|status …)
```

## Layout

```
src/                server runtime + SDK (the deployable Worker)
example/            demo app (schema + handlers + ACL)
scripts/cli.ts      the `pramen` CLI
packages/client/    @pramen/client   (typed RPC + live queries)
packages/react/     @pramen/react    (useLiveQuery / useMutation)
test/               e2e suites + units (bun test)
oblaka.ts           IaC source of truth → wrangler.jsonc
```
