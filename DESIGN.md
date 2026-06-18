# mrak — design

**the prior runtime, re-architected onto Cloudflare primitives.** The TypeScript SDK (schema,
handlers, ACL, ORM) is the portable product; the substrate changes from
Rust + Turso + a hand-built single-writer/replication stack to **Workers +
Durable Objects**, where the platform already provides most of that stack.

## Core insight

the prior runtime builds from scratch what Cloudflare hands you as primitives:

| the prior runtime (Rust) | mrak (Cloudflare) | Status in v0 |
|---|---|---|
| V8 workers (deno_core, !Send) | Workers isolates | platform |
| Single-writer serialization (manual invariant) | Durable Object (one request at a time) | ✅ free |
| In-process Turso | DO SQLite storage (`ctx.storage.sql`) | ✅ wired |
| `the platform sync layer` (WAL repl, snapshots, archiving, failover) | DO point-in-time recovery + platform durability | platform |
| axum + flume dispatch | Worker `fetch` → DO stub | ✅ wired |
| Rust ReadEngine (zero-JS SQL compile) | `src/runtime/read-engine.ts` (→ WASM later) | ✅ TS now |
| ACL resolver, schema, ORM, handlers | TS SDK (`src/sdk/`) | partial (schema + handlers) |
| KV | Workers KV | not yet |

## What the platform gives us for free

- **Single-writer** — a DO processes one request at a time. the prior runtime's hardest-won
  invariant is the default here, and it's *per-tenant* instead of global: writes
  serialize within a tenant and parallelize across tenants.
- **Durability / failover / replication** — DO storage has point-in-time
  recovery and platform-managed durability. Most of the prior runtime's chaos/failover test
  surface (T01–T34, RPO/RTO drills) becomes "trust the platform."
- **Multi-tenancy** — one DO per tenant is a cleaner sharding model than a single
  Turso instance with global single-writer contention.

## The real tensions (tracked, not yet solved)

1. **Zero-JS read path.** the prior runtime's Rust ReadEngine keeps JS out of the hot path.
   In a DO we're in JS-land. Plan: compile `read-engine.ts` (+ the where-AST
   compiler) to **WASM** so SQL compilation leaves JS. Until then, TS + cached
   prepared statements.
2. **CPU/memory limits.** DOs relax the Worker CPU cap but aren't a dedicated OS
   thread. Heavy eager-loading needs budgeting.
3. **D1's role.** D1 is *not* the write path (it's over-RPC, not in-process). It
   fits read-replicas / cross-tenant analytics. The trap is "use D1 as the DB" —
   the DO's SQLite is the database.

## v0 architecture (this skeleton)

```
Worker (src/index.ts)            stateless HTTP front door
  └─ /rpc/<name> ──► MrakDO       per-tenant DO, idFromName(tenant)
        ├─ boot: schemaDDL(app.schema) under blockConcurrencyWhile
        ├─ dispatch(name, input)  query → run; mutation → BEGIN/COMMIT/ROLLBACK
        └─ Db over ctx.storage.sql (read-engine compiles SELECTs)
```

Request: `POST /rpc/createNote` with `{ "title": "...", "body": "..." }`,
header `X-Mrak-Tenant` selects the store (default `main`).

## Roadmap

- [x] ACL: `role()`/`policy()`/`allow()`/`deny()`/`$identity()` in `sdk/acl.ts`; resolution in
      `runtime/acl.ts`. Deny-by-default; grants OR-merge across an identity's roles. Enforced at the
      `Db` chokepoint — row-level `where` scopes AND-merge into find/update/delete, `fields` restrict
      read projection and writable columns. Identity is resolved at the edge (`auth.ts`, bearer-token
      demo map) and forwarded to the DO; for a WebSocket it's fixed at connect time, so live queries
      are per-identity.
- [x] Dynamic policy resolvers: `resolve(fn)` rules computed once per request in a `warmup()` pass,
      reading through a SYSTEM-mode db (ACL bypassed, so no recursion) and returning allow/deny/rules.
      Lets access flip on live DB state. Next: relation/nested ACL, cell-level (conditional per-field),
      `set`/`validate` on writes, hard-deny override, path-aware resolvers, verified-token auth.
- [x] Reactivity: live queries over Hibernatable WebSockets on the DO. Subscriptions
      declare a table-level read-set (tracked in `runtime/db.ts`); a committed
      mutation re-runs only the subscriptions whose read-set intersects its writes.
- [x] Row-level invalidation: re-run is gated by a per-subscription result digest
      (`runtime/digest.ts`), so a write pushes only to subscriptions whose visible
      rows actually changed — inserting a note wakes `listNotes` but not a
      `getNote({id})` view of another row. Correct under arbitrary where/orderBy/limit.
      Next: avoid the re-run for provably-independent subs (predicate/row-key analysis);
      delta payloads (send changed rows, not the whole result).
- [ ] Dynamic deploy: ship the app bundle to the DO instead of static import (cf. the prior runtime `/deploy`).
- [ ] ReadEngine → WASM.
- [ ] Deploy via **oblaka** (CF IaC DSL); local dev via **lopata**.
- [x] Typed query/insert inference: field builders preserve literals (`as const`); `sdk/infer.ts`
      derives `InferRow`/`WhereInput`/`InferInsert`/`InferUpdate` (mirroring the schema layer). `Db<S>` is
      generic, and `createApp(schema)` binds the handler factories so `ctx.db` is fully typed — table
      names, where columns/values, row results, insert/patch shapes. Compile-time proof in
      `example/inference-check.ts` (9 `@ts-expect-error` cases). Note: ACL field projection can drop
      columns at runtime, so a projected row is narrower than its static type — known unsoundness.
