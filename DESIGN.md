# pramen — design

**A reactive backend runtime built on Cloudflare primitives.** The TypeScript SDK
(schema, handlers, ACL, ORM) is the portable product; the substrate is **Workers +
Durable Objects**, where the platform already provides the single-writer / storage /
replication stack a stateful backend like this would otherwise build by hand.

## Core insight

Cloudflare hands you, as platform primitives, the pieces a stateful reactive
backend would otherwise build from scratch:

| Concern | pramen (Cloudflare) | Status in v0 |
|---|---|---|
| Sandboxed execution | Workers isolates | platform |
| Single-writer serialization | Durable Object (one request at a time) | ✅ free |
| In-process datastore | DO SQLite storage (`ctx.storage.sql`) | ✅ wired |
| WAL replication, snapshots, failover | DO point-in-time recovery + platform durability | platform |
| Request dispatch | Worker `fetch` → DO stub | ✅ wired |
| Zero-JS SQL compile | `packages/server/src/runtime/read-engine.ts` (→ WASM later) | ✅ TS now |
| ACL resolver, schema, ORM, handlers | TS SDK (`packages/server/src/sdk/`) | ✅ |
| Global config/cache | Workers KV | ✅ |
| File / object storage | R2 + `ctx.files` (signed urls) | ✅ wired |

## What the platform gives us for free

- **Single-writer** — a DO processes one request at a time, so the hardest-won
  invariant of a stateful backend is the default here, and it's *per-tenant*
  instead of global: writes serialize within a tenant and parallelize across them.
- **Durability / failover / replication** — DO storage has point-in-time
  recovery and platform-managed durability, so the whole chaos/failover surface
  (replication drills, RPO/RTO) becomes "trust the platform."
- **Multi-tenancy** — one DO per tenant is a clean sharding model, with no global
  single-writer contention. **Partitions** (see below) generalize this: a tenant's
  data can span several DOs keyed by `(tenant, partition)`, with "one DO per tenant"
  being the degenerate single-`default`-partition case, and an entity alone in its
  own partition the other end of the spectrum.

## Partitions

Routing is one DO per tenant today: `env.PRAMEN.get(env.PRAMEN.idFromName(tenant))`.
Every entity for a tenant shares that DO's in-process SQLite — which is exactly what
makes atomic cross-entity transactions, in-SQL relation traversal (`acl.ts` compiles
`{ owner: {...} }` to a subquery), `with` hydration, and reactivity (the DO's
broadcast) free.

A **partition** lets a schema author move an entity (or group) into its own DO — to
relieve a hot/append-only entity (events, audit log, telemetry) that otherwise
serializes the whole tenant, or to scale past the per-DO SQLite size limit — at the
cost of those cross-entity guarantees *for the partitioned entity*. The contract:

1. **`partition` is a schema concept.** An entity declares it via the third
   `Entity` argument: `Entity(build, relations, { partition: "name" })`. The default
   partition name is `"default"`, and an entity lives in exactly one partition.
2. **Routing key.** A partition-DO is addressed by `idFromName(`${tenant}:${partition}`)`
   — **except the default partition, which keeps the bare `idFromName(tenant)` key.**
   This is a hard backward-compat requirement (not a WIP "redesign freely" case): every
   tenant's existing data already lives under `idFromName(tenant)`, and changing that key
   would orphan it. The default partition therefore *must* stay on the bare key.
3. **Boundary rules — cross-partition is forbidden, enforced not degraded.**
   - A relation (`belongsTo`/`hasMany`) whose target is in a different partition is a
     **schema-validation error**, caught at boot/codegen (relations are static).
   - `with` and relation-traversal `where` consequently cannot cross partitions — no
     such relation can exist to traverse.
   - A handler may only touch tables in **one** partition; touching another partition's
     table is a **runtime error** — no silent cross-DO RPC, no distributed transaction,
     no cross-DO live query.
4. **Handler → partition association for routing.** The Worker must pick the
   partition-DO *before* dispatch, without running the handler, so the partition is
   declared statically in handler opts: `query(fn, { partition })` /
   `mutation(fn, { partition })`, defaulting to `"default"`. The rationale is
   static, server-side routing — the Worker can't introspect which tables a handler
   will touch. The invariant: a handler's declared partition must match the partition
   of every table it touches, enforced at runtime by the table-access guard (rule 3).
5. **DDL placement.** Each partition-DO migrates **only its own partition's tables** —
   the other partitions' tables don't exist in that DO, so `migrate` reconciles a
   per-partition slice of the schema.
6. **DO enumeration via a self-maintained registry.** A `DurableObjectNamespace` has
   no list API (only `idFromName`/`idFromString`/`newUniqueId`/`get`) — the platform
   cannot tell you which DOs exist. So a KV registry is the source of truth: each DO
   self-registers on first touch (today `tenant:<t>`; with partitions a
   `(tenant, partition)` pair). The distinction matters: the **tenant** is dynamic
   (runtime-supplied), the **partition** is static (from the schema). The registry
   tracks *actually-instantiated* pairs, so a partition later renamed or removed from
   the schema — an orphan DO that still holds data — stays discoverable.
7. **Admin surface becomes per-partition.** `/tenants` enumerates `tenant:partition`
   pairs, and `/admin/schema`, `/admin/recover`, `/admin/data` take an optional
   `partition` argument — absent ⇒ the default partition, so today's calls keep working
   unchanged.
8. **Out of scope.** Cross-partition transactions/sagas, cross-DO live queries, and
   automatic re-partitioning / data movement between partitions are explicitly not
   covered — the boundary is enforced, not bridged.

## The real tensions (tracked, not yet solved)

1. **Zero-JS read path.** Ideally SQL compilation stays out of the JS hot path,
   but in a DO we're in JS-land. Plan: compile `read-engine.ts` (+ the where-AST
   compiler) to **WASM** so SQL compilation leaves JS. Until then, TS + cached
   prepared statements.
2. **CPU/memory limits.** DOs relax the Worker CPU cap but aren't a dedicated OS
   thread. Heavy eager-loading needs budgeting.
3. **D1's role.** D1 is *not* the write path (it's over-RPC, not in-process). It
   fits read-replicas / cross-tenant analytics. The trap is "use D1 as the DB" —
   the DO's SQLite is the database.

## v0 architecture (this skeleton)

The runtime is the `@pramen/server` package; a project's entry is
`createPramen(app)` (see `example/worker.ts`), which returns `{ fetch, PramenDO }`.

```
Worker (createPramen(app).fetch)  stateless HTTP front door
  └─ /rpc/<name> ──► PramenDO       per-tenant DO, idFromName(tenant)
        ├─ boot: schemaDDL(app.schema) under blockConcurrencyWhile
        ├─ dispatch(name, input)  query → run; mutation → BEGIN/COMMIT/ROLLBACK
        └─ Db over ctx.storage.sql (read-engine compiles SELECTs)
```

Request: `POST /rpc/createNote` with `{ "title": "...", "body": "..." }`,
header `X-Pramen-Tenant` selects the store (default `main`).

## Testing

`bun test` (`test/e2e.test.ts`) generates the config from `oblaka.ts`, boots one
`wrangler dev` against fresh local state, and runs every suite (`test/suites/*`)
against it, each on its own tenant: ACL + write rules + per-identity live queries,
dynamic resolvers, relations/nested ACL, and live-query row-level invalidation.
CI (`.github/workflows/ci.yml`) runs typecheck + `bun test` on push/PR — fully
local (miniflare), no Cloudflare credentials. Compile-time inference is proven
separately in `example/inference-check.ts` via `@ts-expect-error` cases.

## Roadmap

- [x] ACL: `role()`/`policy()`/`allow()`/`deny()`/`$identity()` in `sdk/acl.ts`; resolution in
      `runtime/acl.ts`. Deny-by-default; grants OR-merge across an identity's roles. Enforced at the
      `Db` chokepoint — row-level `where` scopes AND-merge into find/update/delete, `fields` restrict
      read projection and writable columns. Identity is resolved at the edge (`auth.ts`, bearer-token
      demo map) and forwarded to the DO; for a WebSocket it's fixed at connect time, so live queries
      are per-identity.
- [x] Dynamic policy resolvers: `resolve(fn)` rules computed once per request in a `warmup()` pass,
      reading through a SYSTEM-mode db (ACL bypassed, so no recursion) and returning allow/deny/rules.
      Lets access flip on live DB state.
- [x] Relations + nested ACL: `belongsTo`/`hasMany` on entities (`Entity(fields, relations)`), eager
      loaded via `find({ with: { rel: true } })`. Each traversal is independently ACL-checked by
      `resolveRelationScope`: the related entity's own read scope OR a parent read policy's relation
      rule with `directAccess` (a traversal-only grant), with per-relation `where`/`fields`.
      Typed `with` + nested row inference.
- [x] Write-side ACL — `set` and `validate`: a write policy may force server-controlled column values
      (`set: { ownerId: (i) => i?.userId }`, overrides client input and bypasses field restriction) and
      run server-side validation (`validate: ({ identity, values }) => { … throw … }`) on the final
      values. Resolved in `resolveWriteRules` and applied by `Db` on insert/update. Next: cell-level
      (conditional per-field), hard-deny override, path-aware resolvers; perf: batch relation loads (avoid N+1).
- [x] Verified-token auth: the Worker verifies an HS256 bearer JWT (WebCrypto) against
      `env.AUTH_SECRET`, checks exp/nbf, and maps claims (`sub`->userId, `roles`/`role`->roles, custom
      claims pass through) to an Identity forwarded to the DO. The client-supplied X-Pramen-Identity
      header is stripped unless a token verified, so a validly-signed JWT is the only path to an
      identity (`auth.ts`). Next: RS256/EdDSA + JWKS (asymmetric, key rotation) — a localized change
      to verifyJwt.
- [x] Reactivity: live queries over Hibernatable WebSockets on the DO. Subscriptions
      declare a table-level read-set (tracked in `runtime/db.ts`); a committed
      mutation re-runs only the subscriptions whose read-set intersects its writes.
- [x] Row-level invalidation: re-run is gated by a per-subscription result digest
      (`runtime/digest.ts`), so a write pushes only to subscriptions whose visible
      rows actually changed — inserting a note wakes `listNotes` but not a
      `getNote({id})` view of another row. Correct under arbitrary where/orderBy/limit.
      Next: avoid the re-run for provably-independent subs (predicate/row-key analysis);
      delta payloads (send changed rows, not the whole result).
- [x] Hardening pass: a typed error envelope (`runtime/errors.ts`) — client-fault errors carry
      `{ status, code, message }` (`AclDenied` -> 403 `forbidden`, `BadRequest` -> 400), everything
      else is logged and returned as a generic 500 (no internal leakage). Optional per-handler `input`
      validator runs at the boundary (400 on reject); `validate` throws become 400s. Relation loads
      are batched with a single `IN` query (no N+1). WebSockets gain `webSocketError` handling and a
      per-socket subscription cap (64). NOT changed: ACL field permissions union across OR'd policies
      (row-agnostic at the root) — intentional; per-row field coupling is future work.
- [x] Tenant registry: Durable Objects aren't enumerable, so a forgotten tenant name = orphaned
      (still durable, but unreachable). Each tenant now records its name in a `TENANTS` KV namespace on
      its DO's first touch — once, guarded by a `_pramen_meta` flag (no per-request writes; the DO learns
      its name from the Worker-forwarded `x-pramen-tenant` header). Admin `GET /tenants` lists them.
- [x] Tenant authorization: the Worker gates `x-pramen-tenant` against the caller (`authorizeTenant` in
      `auth.ts`) before reaching the DO — admins → any tenant; others → only tenants in their `tenants`
      claim. Closes the arbitrary-tenant addressing/registration hole. Pluggable for other tenancy models.
- [x] Point-in-time recovery: SQLite-backed DOs have 30-day PITR (`getBookmarkForTime` →
      `onNextSessionRestoreBookmark`), per-tenant. Admin `POST /admin/recover {tenant,timestamp}` arms a
      restore and returns the `undo` bookmark (reversible); it does NOT auto-`abort()`, so the call can
      return the bookmark — the restore completes on the DO's next restart. PITR is platform-only
      (local dev → 501 `unavailable`); the happy path is verified only against a deployed DO.
- [x] ctx.kv + multi-project naming: handlers get `ctx.kv`, a prefixed (`app:`) wrapper over the
      project's KV namespace, for GLOBAL (cross-tenant) config/flags/cache — distinct from per-tenant
      `ctx.db`, and not part of mutation transactions. Two-level namespacing: across projects, a
      `PROJECT` constant in `oblaka.ts` names every resource (Worker/DO/KV) so projects coexist in one
      account; within a project's single KV namespace, key prefixes separate internal (`tenant:`) from
      app (`app:`) data. Next: per-tenant KV scope option; let handlers throw clean HTTP errors (e.g.
      forbidden) so KV/app-level auth checks don't surface as 500s.
- [x] Monorepo + client libraries: Bun workspaces. `@pramen/client` (`packages/client`) — typed
      `call()` (HTTP RPC) + `subscribe()` (live queries over a multiplexed, auto-reconnecting
      WebSocket), generic over `typeof app.handlers` with no runtime dep on the server. Browser
      WebSockets can't set headers, so /live also accepts token+tenant via the query string.
      `@pramen/react` (`packages/react`) — `useLiveQuery` (re-renders on each push) + `useMutation`.
- [x] CLI (`pramen`): help, init (scaffold), token (dev JWT), and schema sql/hash/snapshot/diff/status.
      `schema diff` classifies changes safe (additive) vs unsafe; `schema status` compares a deployed
      tenant's applied schema (admin `GET /admin/schema` → DO introspection) to the local schema.
- [x] File storage (R2): a `fileRef` column type stores small JSON metadata (a `FileRef`:
      `{ key, size, contentType, filename?, uploadedAt? }`) in a TEXT column — never the bytes; the
      object-store seam (`StorageAdapter`: `R2Adapter`/`MemoryAdapter` in `runtime/storage.ts`) mirrors
      the Driver/Dialect seam so the engine is store-agnostic, R2 being the CF default. Handlers get
      `ctx.files`: `signUpload()` mints a tenant-scoped key + a signed PUT url; `signDownload()` mints a
      signed GET url (call only AFTER an ACL'd read — knowing a key isn't authorization); `head()`/
      `delete()` for verify/cascade. The Worker serves `/files/upload` + `/files/download`, authorized
      purely by an HMAC token (`FILES_SECRET`, falls back to `AUTH_SECRET`) in the url — no S3 creds, and
      the bytes stream in the Worker so they never touch the DO. URLs are relative (the client resolves
      them). The `fileRef` codec (object↔JSON) lives at the `Db` chokepoint, so reads/writes/relations
      see objects. ACL: the column is an ordinary field (projected per policy); blob access is gated by the
      handler choosing to sign. Verified end-to-end in miniflare (`test/suites/files.ts`): upload→attach→
      download round-trip, fileRef DB round-trip, row-level download ACL, and token hardening. Declared in
      `oblaka.ts` (`R2Bucket`). A size-capped upload must declare a content-length (R2 needs a known
      length for a streamed body anyway), checked before the put with a post-put safety net; downloads
      send `nosniff` and an attachment disposition with a sanitized filename. Next: single-use upload tokens (a key is
      currently re-PUTtable within the token's TTL — random key + short TTL + attachment/nosniff
      bound the risk, but a KV-backed nonce would close it); delete-on-row-delete + orphan sweeper
      (wants a durable job queue); content-type allow-lists on `fileRef`; per-tenant buckets.
- [~] More Cloudflare service seams (same shape as `ctx.files`): email + Queues as `ctx.queue`, etc. —
      a small pluggable adapter + a `ctx.<service>` facade + Worker glue. Lean on platform primitives
      rather than reimplementing them. Email is partly here: `@pramen/auth`'s `createMagicLinkAuth`
      takes a pluggable `sendEmail(ctx, {email, token})` and the example/oblaka wire **Cloudflare Email
      Sending** (the `send_email`/`EMAIL` binding, no API keys). Still future: a first-class `ctx.mail`
      facade (so delivery moves off the DO's single-writer write path), and `ctx.queue`.
- [x] Deferred tasks (transactional outbox): `ctx.tasks.enqueue({ kind, payload, delayMs? })` writes a
      `_pramen_outbox` row through the SAME Driver as the mutation (atomic — no dual-write window);
      `app.tasks[kind]` runs it after commit, off the single-writer write path. This is how a side effect
      like a notification email is done without blocking the transaction. `drainOutbox` (`runtime/outbox.ts`)
      is substrate-agnostic: at-least-once with retry/exponential-backoff + dead-letter; a `claim` step
      (pending→processing via UPDATE…RETURNING) makes concurrent drainers safe and reclaims a crashed
      drainer's batch after a stale window; handlers get a `meta.id` idempotency key. Two wake-ups: the DO
      self-drains via an alarm scheduled at the next due `runAt` (a backed-off retry re-arms itself); the
      D1/Worker store (no alarm) drains via a Cron Trigger (`createPramen().scheduled`) or
      `POST /admin/tasks/drain`. Admin `/admin/tasks/drain` + `/admin/tasks/list` (both stores); 'done' rows
      are pruned. Next: a `ctx.mail` facade as the first built-in target.
- [x] Declarative triggers (layered on the outbox): an entity declares
      `triggers: [trigger({ task, on: { create?, update?: true | string[], delete? } })]`; the `Db` write
      path auto-enqueues `task` (payload `{ entity, op, id, row }`) in the write's transaction — no
      `ctx.tasks.enqueue` in the handler. A field-filtered update fires only on an actual value change (the
      update path fetches the prior row to compare); `hidden()` columns are stripped from the payload
      (the hidden guarantee holds here too); only ORM writes fire triggers, and the task-drain context sets
      `suppressTriggers` so a task's writes can't cascade into a trigger loop; `createPramen` rejects a
      trigger whose `task` has no `app.tasks` handler. Next: a relation-aware `selection` payload (vs the
      flat row); value-change for `update: true`.
- [x] Server library entry: the runtime is the publishable `@pramen/server` package (was `packages/server/src/`).
      `createPramen(app)` returns `{ fetch, PramenDO }`, so a project is just `app.ts` + `oblaka.ts` +
      a 3-line `worker.ts` (`export default { fetch }; export const PramenDO = …`). The DO + Worker are
      parameterized by the app — no more static `../example/app` import. Split entries: `@pramen/server`
      is authoring-only (schema/handlers/ACL/files/errors/substrate), while the deploy half — createPramen
      + the Durable Object — is `@pramen/server/worker`, isolated because it imports `cloudflare:workers`
      (so the CLI/tests/codegen can load an app.ts for its schema without pulling in the DO runtime).
      `pramen init` scaffolds the 3-line entry; the full e2e suite boots wrangler against `example/worker.ts`.
- [x] `ctx.env` for handlers: the Worker/DO environment (bindings + vars + secrets) is threaded into the
      handler context (`dispatch` takes it, the DO/Worker pass theirs), so handlers can call external APIs
      (Stripe, Resend, …) without a vendored runtime edit. Loosely typed (`Readonly<Record<string,unknown>>`);
      cast at the use site. The "embrace CF services" path: a handler can hit any binding/secret directly.
- [x] `t.json()` column: arbitrary JSON stored in a TEXT column, typed as `JsonValue`, with the same
      object↔string codec as `fileRef` at the `Db` chokepoint (read/write/relations see parsed values).
      Aggregating/grouping a json/fileRef column is rejected (the codec only runs on row reads).
- [x] CORS: an opt-in allowlist (`CORS_ORIGINS` — comma-separated origins or `*`) on `/rpc` + `/live`.
      The Worker answers the preflight before auth and merges the headers into responses, so a browser
      client can call a cross-origin Worker directly. Unset = same-origin only (unchanged).
- [x] Public (pre-auth) routes (P4): `app.routes = [{ method, path, handler }]`, matched in the Worker
      before identity resolution — for signature-authed endpoints (Stripe-style webhooks) that don't fit
      the JWT-gated `/rpc` surface. The handler gets `(request, env, ctx)` and can `ctx.callPrivileged({...})`
      to forward a privileged mutation into the DO (no deploy-side import in `app.ts`, which stays
      authoring-only). `callPrivileged` is also exported from `@pramen/server/worker`.
- [x] Anonymous role + capability read (P7/P9): an unauthenticated caller is evaluated as the `anonymous`
      role (define it to grant public reads/writes; absent ⇒ deny-by-default, unchanged). `authorizeTenant`
      now lets anonymous reach the default `main` tenant (ACL still gates the data). A new `$input("path")`
      marker in a policy `where` resolves against the request input — a capability / by-unguessable-key
      grant (read a row only by presenting its secret id; can't enumerate). Threaded through ACL resolution
      alongside `$identity`.
- [x] Mutation echo projection (P6): `insert`/`update` now project the RETURNING row through the
      caller's readable fields PLUS the columns they just wrote PLUS the primary key — so the echo never
      leaks a field a `find` wouldn't show (e.g. a teammate editing another's note title no longer gets
      `body` back), yet never collapses to `{}` (a write-only caller still gets the generated id + the
      fields it wrote). Full read access ⇒ the whole row; SYSTEM ⇒ unprojected.
- [x] Field-DSL modifiers (P2): `notNull()`, `unique()`, `indexed()`, `defaultTo(value)` — wrapper helpers
      (compose, like `renamedFrom`). UNIQUE/index emit `CREATE [UNIQUE] INDEX IF NOT EXISTS` (added to an
      existing table without a rebuild); DEFAULT is inline (and `ADD COLUMN ... NOT NULL DEFAULT` backfills),
      and a defaulted column is optional on insert. (`t.json()` already landed; chained `.method()` syntax
      remains.)
- [x] `hidden()` column modifier: a column marked `hidden()` is stripped from every ORM read projection —
      `find`/`get`, mutation echoes, relation loads, and the SYSTEM-mode `/admin/data` — even under a full
      `allow()`/SYSTEM scope, while staying writable and visible to raw `ctx.db.exec`. Enforced at the `Db`
      chokepoint (`finishRows` + `projectWrite`). For secrets like `@pramen/auth`'s `passwordHash`. Same pass
      fixed `Db.update`/`delete`/belongsTo-load to resolve the real PK via `pkOf()` (they hardcoded `id`), so
      an entity with a non-`id` `textId`/`primaryKey()` PK (e.g. `auth_users` keyed by `username`) works.
- [x] SQL-expression defaults (mirrors kvalt's `expr`): `defaultTo(field, expr.now())` / `expr.raw(sql)` —
      an `ExprDefault` wraps raw SQL, rendered UNQUOTED and parenthesized (`DEFAULT (datetime('now'))`) so a
      function-call default is legal in SQLite; `expr.now()` is the current UTC timestamp as TEXT
      (`CURRENT_TIMESTAMP`-shaped). Expr-default columns are optional on insert (DB-filled). SQLite forbids
      `ALTER ADD COLUMN` with a non-constant default, so adding one to an existing table falls back to a
      table rebuild — additive (the rebuild's INSERT omits the column, so SQLite backfills existing rows via
      the column's DEFAULT) and ungated by `PRAMEN_ALLOW_DESTRUCTIVE`. Unblocks a future `timestamps()` helper.
- [x] `t.uuid()` column + `generated()`/`primaryKey()` modifiers (mirrors kvalt): a TEXT column typed as
      `string`. `generated()` auto-mints a v4 via `crypto.randomUUID()` on insert when omitted (uuid-only —
      rejected at schema construction otherwise) and makes the column optional on insert; the minted value
      is treated like a forced `set` (bypasses the writable-field check). `primaryKey()` marks any column the
      PK (implies NOT NULL). A caller-supplied uuid is validated (`isValidUuid`) on insert/update and rejected
      (400) if malformed. Canonical PK: `id: primaryKey(generated(t.uuid()))`.
- [x] Go-live hardening (1/3): destructive migrations are gated. The boot migrator applies additive
      changes always, but drops/rebuilds/type-changes/table-drops only when `PRAMEN_ALLOW_DESTRUCTIVE=true`
      (off by default). Skipped ops are logged and the schema hash is left unwritten so a later opt-in
      deploy retries; local dev sets the flag on. Closes the "a fat-fingered schema edit silently drops a
      column on next deploy" footgun.
- [x] Go-live hardening (2/3): file tokens fail closed. A FILES_SECRET shorter than 16 chars (e.g. unset
      under JWKS auth, where AUTH_SECRET is empty) ⇒ signing throws and the `/files` route returns 503,
      instead of minting/accepting tokens HMAC'd with an empty key. The DO falls back FILES_SECRET → AUTH_SECRET.
- [x] Go-live hardening (3/3): publishable packages. `@pramen/server`/`client`/`react` build to `dist`
      (JS + `.d.ts`) via `tsc` — no extra bundler (bun's bundler mangles pure re-export barrels and can't
      emit types). Conditional `exports`: `development`/`bun`/`workerd` → `src` (in-repo typecheck/tests/
      dev/deploy need no build; tsconfigs set `customConditions: ["development"]`), while published Node
      consumers fall through to `types`/`default` → `dist`. No `publishConfig` field overrides (npm is
      deprecating those). v0.0.1, MIT license, CI builds the artifacts; `src` is shipped too so a
      consumer's wrangler (`workerd`) bundles source directly.
- [x] Real-Cloudflare deploy smoke: provisioned via `oblaka --remote` (OAuth) and verified the full stack
      on workerd (DO SQLite + RETURNING, ACL, R2 upload/download, signed urls), then torn down. Confirmed
      a real go-live path beyond the miniflare suite.
- [x] Admin data API (primitives): `POST /admin/data { tenant, table, op }` (list/get/create/update/
      delete/count) forwards to the DO's `/__admin/data`, run through a SYSTEM-mode `Db` — ACL bypassed
      (admin-gated at the Worker), json/fileRef codec + transactions + live broadcast intact. The backend
      a dashboard sits on; extends the existing `/tenants`, `/admin/recover`, `/admin/schema` endpoints.
- [x] `@pramen/auth` (optional login issuance): `authSchema` + `authHandlers` (signup/login/me) issue
      HS256 tokens the core verifier accepts; PBKDF2-hashed passwords (WebCrypto, no deps); server-assigned
      roles. Core stays verify-only (BYO IdP via JWKS still works). `authorizeTenant` now treats `main` as
      the open default tenant for any caller (ACL still gates data) so issued tokens need no `tenants` claim.
- [x] `@pramen/auth` magic link (passwordless): `createMagicLinkAuth({ sendEmail })` + `magicLinkSchema` —
      `requestMagicLink({email})` / `loginWithMagicLink({token})`. One-time, single-use, time-boxed; the
      token is stored only as a SHA-256 hash (15-min default). Transport is the app's via a pluggable
      `sendEmail(ctx, {email, token})`; the example/oblaka wire **Cloudflare Email Sending** (the
      `send_email`/`EMAIL` binding, no API keys). Keyed on the immutable `username` (a magic-link user's
      username IS their email) — never on the mutable `email` column (which would let a `changeEmail` squat
      another address). `auth_users` gains a unique mutable `email` (contact) and an `active` flag.
- [x] `@pramen/auth` user management: `createUserHandlers({ table })` + `authPolicies({ table, prefix,
      adminReadFields, … })` — ACL-gated admin (`listUsers`/`setUserRoles`/`setUserActive`/`deleteUser`)
      + self (`changeEmail`/`changePassword`) over `auth_users` or any authSchema-shaped table (e.g. one
      with an extra `tenants` column). Authorized declaratively by the ACL (not imperative role checks);
      `passwordHash` is `hidden()` so it's never projected. `active` blocks login; role/active changes take
      effect on next login (no session store) — `AUTH_SESSION_TTL_SECONDS` tunes the window.
- [x] Relation-aware `where` (query + ACL): a `where` key naming a relation takes a nested clause over
      the related entity (`{ owner: { name: "Alice" } }`), compiled to a subquery — belongsTo →
      `fk IN (SELECT pk FROM target WHERE …)`, hasMany → `pk IN (SELECT fk FROM target WHERE …)` — via a
      new `sub` SqlExpr node (inner predicate shares the param sequence, so both dialects work). The
      target's read scope is AND-merged and filters on non-readable target fields are rejected, so
      traversal can never widen access. Works in user queries (`WhereClause<S,T>`, depth-bounded type — the
      bound is kept in lockstep with the runtime `MAX_REL_DEPTH`) and in policy `where`/`when`;
      `$identity`/`$input` markers resolve inside nested clauses. Closes the main expressiveness gap vs
      kvalt. Two rules make the security model explicit: (1) a user `where` that filters on a column the
      caller can't read is denied with a 403 — same as ordering/aggregating by a hidden column — since a
      filter is otherwise an oracle for the hidden value (a relation into a table with no read grant just
      yields no rows); (2) `AND`/`OR` branches compile independently, so an unresolvable `$identity`/`$input`
      marker collapses only its own branch (boolean logic), letting a sibling literal branch still match.
      Cell-`when` stays single-table — a relation key there is rejected at authoring time (relations need a
      SQL round-trip, which the in-memory per-row evaluator can't do).
- [ ] Remaining go-live items: rate limiting + request-size caps, map constraint violations to 409,
      single-use upload tokens, error reporting, and a `--env production` deploy with real secrets.
- [ ] Dynamic deploy: ship the app bundle to the DO instead of static import (a runtime `/deploy`).
- [ ] ReadEngine → WASM.
- [x] Deploy via **oblaka** (CF IaC DSL): `oblaka.ts` declares the Worker + `PRAMEN` Durable Object
      (oblaka auto-emits the SQLite migration), vars, and observability, and is the source of truth —
      it generates `wrangler.jsonc` (git-ignored). `bun run config` generates locally; `bun run deploy`
      runs `oblaka --remote` (provision resources + config) then `wrangler deploy` (bundle + upload
      code). Verified the generated config runs the full suite under `wrangler dev`. Next: local dev
      via **lopata**; mark AUTH_SECRET as a managed secret (oblaka has no secret DSL yet — uses
      `wrangler secret put`).
- [x] Typed query/insert inference: field builders preserve literals (`as const`); `sdk/infer.ts`
      derives `InferRow`/`WhereInput`/`InferInsert`/`InferUpdate`. `Db<S>` is
      generic, and `createApp(schema)` binds the handler factories so `ctx.db` is fully typed — table
      names, where columns/values, row results, insert/patch shapes. Compile-time proof in
      `example/inference-check.ts` (`@ts-expect-error` cases). Note: ACL field projection can drop
      columns at runtime, so a projected row is narrower than its static type — known unsoundness.
- [x] Schema migrations (additive): on DO boot, `runtime/migrate.ts` reconciles the SQLite store
      with the schema — creates missing tables and `ALTER TABLE ADD COLUMN`s new fields (nullable),
      with no data loss. A schema hash in the internal `_pramen_meta` table short-circuits unchanged
      schemas on warm boots. Additive only — drops/renames/type changes are not applied (orphan
      columns remain). Unit-tested against real SQLite (`test/migrate.test.ts`); create+PRAGMA path
      exercised on the real DO by the e2e boot. Next: destructive/explicit migrations, column rename
      detection, a `_pramen_meta` schema-version log.
- [x] Query expressiveness: operators (`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`/`notIn`/`like`/`isNull`),
      nestable `AND`/`OR` groups, multi-column `orderBy`, and `limit`/`offset` pagination. The `SqlExpr`
      AST + `compileWhere` (`runtime/read-engine.ts`) handle it; `WhereInput<F>` types operators per
      column (`like` is string-only); column identifiers are validated against injection.
- [x] Cursor (keyset) pagination: `db.page({ ..., after })` returns `{ items, cursor, hasMore }`. A
      lexicographic keyset predicate (`keysetAfter`) starts strictly after the cursor; the PK is
      auto-appended to `orderBy` as a unique tiebreaker, so pagination stays stable under concurrent
      inserts/deletes (unlike offset). Cursors are opaque base64url of the order-key values, read from
      the raw row (survives field projection); a bad cursor is a 400.
- [x] Aggregates: `db.count({ from, where })` and `db.aggregate({ from, where, groupBy, aggregations })`
      (count/sum/avg/min/max), compiled in `runtime/read-engine.ts`. ACL read scope is AND-ed in; every
      aggregated/grouped column must be readable under field permissions (else 403) — counting rows you
      can see is always allowed. Aggregate result rows are loosely typed (dynamic keys). Next:
      `having`/ordered aggregates.
- [x] Operators in ACL `where` rules: policy `where` now supports the full user query surface
      (operators, `AND`/`OR`) in addition to equality, with `$identity` markers usable anywhere —
      bare values, operator-object values, and `in`/`notIn` lists (a marker can resolve to the whole
      array). `resolveMarkers` substitutes markers then reuses `compileWhere`; any unresolvable marker
      makes the rule match nothing (safe deny). Example: a `manager` role reads notes whose `ownerId`
      is `in $identity("team")`.
