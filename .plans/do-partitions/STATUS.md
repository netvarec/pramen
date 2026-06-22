# Status

Feature: optionally split a tenant's Durable Object by **entity partition**.
See `issues/01-design-spec.md` for the spec and the decisions every other issue
depends on. Key invariant threaded through the plan: **the default partition keeps the
bare `idFromName(tenant)` routing key** (backward-compat); only non-default partitions
use `idFromName(`${tenant}:${partition}`)`.

## Pending

## In Progress

## Completed

- [x] 01 — DESIGN.md: Partitions spec & decisions
- [x] 02 — Schema: `partition` on Entity + `partitionOf` helper
- [x] 11 — DO registry: track & enumerate all (tenant, partition) DOs
- [x] 03 — Schema validation: reject cross-partition relations
- [x] 04 — Partition-aware migrate (DDL scoped to a partition)
- [x] 05 — Handler partition declaration + Worker routing key
- [x] 06 — DO partition awareness + runtime table-access guard
- [x] 07 — Admin surface per-partition
- [x] 09 — Example partitioned entity + e2e tests
- [x] 10 — CLI / codegen + docs
- [x] 08 — Type-level cross-partition rejection — runtime-only by decision (see below)

## Discoveries

- e2e flake (environment, not code): a failed `test/e2e.test.ts` run leaks a `bun`
  child holding port 8788 (afterAll kills the `bunx wrangler` wrapper, not its child),
  so subsequent runs hang on "wrangler dev did not become ready in time". Recovery:
  `lsof -iTCP:8788` → `kill -9 <pid>`. Check this before blaming an e2e regression.
- Issue 05 wired `partition` into the standalone `query`/`mutation` (sdk/handlers.ts) but
  NOT the typed `createApp` factories (sdk/app.ts) the example uses — partitioned handlers
  routed to the default DO. Caught by the issue-09 integration suite; fixed in sdk/app.ts.
- Issue 08 deferred to runtime-only: a compile-time cross-partition relation/`with`
  rejection needs the entity `partition` to survive inference as a string literal, but
  `EntityDef.partition` is widened to `string` at the `Entity()` factory. Doing it means
  threading a `P extends string` generic through EntityDef/Entity/SchemaDef + all
  consumers (FieldsOf/RelationsOf/RelValue/WhereClause/RelationsResult) — out of scope
  and would destabilize the depth-bounded WhereClause. Enforcement stays at runtime/boot
  (validateSchema) + e2e. Candidate future issue if the type-level guard is wanted.

- Two distinct keyspaces, do not conflate: `registryKey(t,p)` → `tenant:<t>[:<p>]` (KV
  registry) vs `partitionDoName(t,p)` → `<t>[:<p>]` (DO `idFromName`). Issue 07's admin
  routing must use `partitionStubFor`/`partitionDoName` (in worker.ts), NOT `registryKey`,
  or it addresses the wrong (empty) DO. Both live in `runtime/registry.ts`.
