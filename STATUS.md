# mrak — status & architecture

A reactive backend runtime for TypeScript **on Cloudflare**. You define a schema
and handlers; you get a complete, ACL-enforced, real-time backend deployed as a
Worker + Durable Object. Sibling of the prior runtime (Rust + Turso),
re-architected onto Cloudflare primitives — see [DESIGN.md](./DESIGN.md) for the
mapping and rationale.

Status: **working end-to-end, fully tested** (~1.9k LOC of `src`, 19 commits).
Active development; WIP; no backward-compat constraints.

## The spine — one request

```
client ──HTTP /rpc/<h> or WS /live──►  Worker (src/index.ts)
                                        │  auth.ts: verify HS256 JWT -> Identity
                                        │  route per tenant: idFromName(x-mrak-tenant)
                                        ▼
                                   MrakDO  (one Durable Object per tenant)
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
fact gives mrak — for free — what the prior runtime builds by hand: single-writer
serialization, transactional mutations, and a place that sees every write (so
live-query invalidation is exact).

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
| **Migrations** | On DO boot: create tables + additive `ADD COLUMN`, gated by a schema hash in `_mrak_meta`. No data loss. | `src/runtime/{migrate,ddl}.ts` |
| **Errors** | Typed envelope `{ ok, error, code }` + status; internal errors logged, returned as generic 500. | `src/runtime/errors.ts` |
| **Dispatch** | Resolve handler, optional input validator (→400), warmup, run, report `touched` tables. | `src/runtime/dispatch.ts` |
| **Tenancy** | Worker authorizes `x-mrak-tenant` against the identity (`authorizeTenant`). DOs aren't enumerable, so each tenant self-registers in a KV registry on first touch; admin `GET /tenants` lists them. | `src/auth.ts`, `src/durable-object.ts`, `src/index.ts` |
| **Recovery** | 30-day point-in-time recovery (platform). Admin `POST /admin/recover {tenant,timestamp}` arms a restore, returns the `undo` bookmark. Local dev → 501 (PITR is platform-only). | `src/durable-object.ts`, `src/index.ts` |
| **Deploy (IaC)** | `oblaka.ts` is source of truth → generates `wrangler.jsonc`; `oblaka --remote` provisions, `wrangler deploy` ships code. | `oblaka.ts` |
| **Tests/CI** | `bun test` boots one `wrangler dev`, runs all suites on isolated tenants + a SQLite migrate unit test. CI on push/PR. | `test/**`, `.github/workflows/ci.yml` |

## What's done (17 commits)

Scaffold → live queries → row-level invalidation → ACL (roles/policies/scopes) →
dynamic resolvers → typed inference → verified JWT auth → relations + nested ACL
(directAccess) → write-side ACL (set/validate) → oblaka deploy → test harness +
CI → query operators/OR-AND/pagination → schema migrations → hardening (safe
errors, input validation, batched relations, WS limits) → cursor pagination →
count + aggregates → operators in ACL where rules → tenant registry → tenant
authorization + admin point-in-time recovery → ctx.kv + per-project naming.

Every feature is verified by an e2e suite (`test/suites/*`) and, where it's
type-level, by `example/inference-check.ts` (`@ts-expect-error` cases). All green.

## Known limitations (honest)

- **ACL field permissions are row-agnostic** — fields union across OR'd policies
  (matches the prior runtime v1). Per-row field coupling is unimplemented.
- **Aggregate results are loosely typed** (dynamic keys) — `count` is typed.
- **Field projection is statically unsound** — a projected row is narrower than
  its inferred type.
- **Migrations are additive only** — no drops/renames/type changes (orphan
  columns remain); no destructive/explicit migration story.
- **App is statically imported** by the DO — no dynamic bundle deploy (the prior runtime
  `/deploy` analog); a new app means a redeploy.
- **Read engine is TS, not WASM** — fine (no perf problem), but not the prior runtime's
  zero-JS read path.
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
bun install
bun run dev        # oblaka generates wrangler.jsonc, then wrangler dev
bun test           # boot one server, run every suite (no CF creds; miniflare)
bun run typecheck
bun run deploy     # oblaka --remote (provision) + wrangler deploy (code)
```
