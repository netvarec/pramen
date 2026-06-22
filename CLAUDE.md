# pramen

Reactive backend runtime for TypeScript on **Cloudflare**. Define schema +
handlers, get a backend deployed as a Worker + Durable Object — the platform
provides the single-writer/storage/replication stack. Read `DESIGN.md` for the
architecture.

## WIP — everything is subject to change

Active development; nothing is stable. No backward-compat constraints — redesign
freely rather than patching around something that feels wrong. No preexisting
issues: if something is broken, fix it.

## Layout & architecture

The runtime is the publishable **`@pramen/server`** package at `packages/server/src/`
(SDK + Cloudflare glue). A project (see `example/`) is just `app.ts` + `oblaka.ts` +
a 3-line `worker.ts` that calls `createPramen(app)`.

```
example/worker.ts  createPramen(app) -> { fetch, PramenDO }
  Worker (fetch)  ->  PramenDO (per-tenant Durable Object)
                        ├─ ctx.storage.sql   in-process SQLite (the DB)
                        ├─ schemaDDL on boot (blockConcurrencyWhile)
                        └─ dispatch: query -> run; mutation -> storage.transaction()
```

- **`@pramen/server`** (`.` export) is authoring-only — `Entity`/`defineSchema`,
  `createApp`, `query`/`mutation`, ACL, files, errors, the substrate seam. The
  **deploy** half — `createPramen` + the Durable Object — is **`@pramen/server/worker`**,
  split off because only it imports `cloudflare:workers`. So the CLI/tests/codegen
  can load an `app.ts` for its schema without dragging in the DO runtime.
- The DO + Worker are **parameterized by the app** (`pramenDO(app)` / `makeWorker(app)`),
  closed over by `createPramen` — no static app import in the runtime.
- **The DO is the database.** Single-writer serialization is free (a DO handles
  one request at a time), per-tenant via `idFromName`.
- **D1 is NOT the DO's write path** — it's over-RPC, not in-process; the DO's
  SQLite is its transactional store. D1 is instead available as a separate
  substrate via the Worker (`x-pramen-store: d1`) — see the Substrate seam below.
- **SDK (`packages/server/src/sdk/`) is platform-agnostic** — the portable product.
  `packages/server/src/runtime/` is the Cloudflare glue.

## Commands

```bash
bun install
bun run dev          # lopata dev (Bun runtime; fast reload + /__dashboard); http://localhost:8787
bun run dev:wrangler # wrangler dev (miniflare) — workerd-parity check before deploy
bun run typecheck    # tsc --noEmit (server + client + react)
bun run build        # tsc → dist (JS + .d.ts) for all 3 packages (for published Node consumers)
bun run deploy       # wrangler deploy
```

Prod config: secrets via `wrangler secret put` (AUTH_SECRET; FILES_SECRET ≥16 chars or
files fail closed). Destructive migrations are OFF unless `PRAMEN_ALLOW_DESTRUCTIVE=true`
(local dev sets it on). Packages use conditional `exports`: the `development`/`bun`/
`workerd` conditions resolve to `src` (so in-repo typecheck/tests/dev/deploy need no
build), while published Node consumers fall through to `dist` (`default`/`types`).
tsconfigs set `customConditions: ["development"]`.

Local dev runs on **lopata** (Bun-based CF runtime; fully emulates DO SQLite +
WebSocket Hibernation). It reads the oblaka-generated `wrangler.jsonc` unchanged and
serves a dashboard at `/__dashboard`. The e2e suite still boots real `wrangler dev`
(miniflare); run `bun run dev:wrangler` once before deploying to catch any
Bun-vs-workerd differences.

> pramen uses the published **lopata `^0.19.2`** from npm. It carries the two fixes
> pramen relies on: the proxy-to-DO deadlock (the canonical
> `stub.fetch(new Request(request, { headers }))` tripped a Bun `new Request(req)`
> stream-body clone bug) and DO SQLite surfacing `RETURNING` rows from `exec()`.
> `bunfig.toml` exempts lopata from a global `minimumReleaseAge` so a fresh lopata
> release installs immediately (other deps still honor the policy).

## Substrate seam (Driver/Dialect)

The data layer runs over a `Driver` (async `exec` + `transaction`) + `Dialect`
(`packages/server/src/runtime/driver.ts`), so the ACL/read/write engine is substrate-agnostic:

- **`DoSqliteDriver`** — the DO's in-process SQLite (the default write path).
- **`D1Driver`** — the SAME engine over a real D1 binding, run **in the Worker**
  (no DO) and selected per-request with the `x-pramen-store: d1` header. RPC only —
  live queries need the DO (single writer + socket host). Proven end-to-end in
  miniflare by `test/suites/d1.ts` (ACL, row scope, field/cell-level projection,
  RETURNING writes, aggregates). The D1 binding is declared in `oblaka.ts`.
- **`postgresDialect`** — shows the SQL shape for a future Hyperdrive/Postgres port
  (quoting + `$n` placeholders); needs a pg `Driver` over Hyperdrive.

## File storage (R2)

Files live in **R2**, not the DB. A `fileRef` column (`t.fileRef()`) stores only
JSON metadata (`FileRef`: `{ key, size, contentType, filename?, uploadedAt? }`) in a
TEXT cell — the bytes are an R2 object addressed by a tenant-scoped key. The object
store is behind a `StorageAdapter` seam (`R2Adapter`/`MemoryAdapter` in
`runtime/storage.ts`), mirroring the Driver/Dialect seam.

- Handlers use **`ctx.files`** — never the R2 binding directly:
  - `signUpload({ contentType, filename?, maxSize?, prefix? })` → `{ url, ref }` (a
    signed PUT url + draft metadata to attach later).
  - `signDownload(ref, { download? })` → `{ url, expiresAt }` — mint ONLY after an
    ACL'd `ctx.db` read; knowing a key is not authorization.
  - `head(key)` / `delete(key)` for upload-verify and cascade.
- The Worker serves `/files/upload` (PUT) + `/files/download` (GET), authorized by an
  HMAC token (`FILES_SECRET`, falls back to `AUTH_SECRET`) in the url. Bytes stream
  in the Worker — they never pass through the DO. Signed urls are RELATIVE; the
  client resolves them (`@pramen/client` `fileUrl()`/`upload()`).
- The object↔JSON codec lives at the `Db` chokepoint, so handlers always see/write
  `FileRef` objects. R2 is declared in `oblaka.ts` (`FILES` binding).

The same shape (adapter + `ctx.<service>` facade + Worker glue) is how other
Cloudflare services should be added (e.g. email via the Send service as `ctx.mail`).

## Conventions

- Schema: `Entity(t => ({ id: t.id(), ... }))` + `defineSchema({ table: Entity })`.
  Field builders: `id`/`textId`/`text`/`int`/`real`/`bool`/`json`/`fileRef`. `json`
  and `fileRef` are stored as TEXT and object↔JSON-codec'd at the `Db` chokepoint —
  handlers read/write the parsed value (a `JsonValue` / `FileRef`). Modifiers are
  wrapper helpers (compose like `renamedFrom`): `notNull()`, `unique()`, `indexed()`,
  `defaultTo(v)` — e.g. `code: unique(t.text())`, `status: defaultTo(t.text(), "pending")`.
- Auth/ACL: an unauthenticated caller is the `anonymous` role (define it for public
  reads/writes; absent ⇒ deny). A policy `where` may use `$identity("path")` (caller)
  or `$input("path")` (request input — a capability/by-unguessable-key read). Public,
  pre-auth routes go in `app.routes` (matched before auth; use `ctx.callPrivileged`
  to forward a privileged mutation into the DO) — for signature-authed webhooks.
- `where` can traverse relations: `{ owner: { name: "x" } }` (belongsTo/hasMany)
  compiles to a subquery in both user queries and policy `where`. The related
  entity's read scope is AND-merged (traversal can't widen access). Cell-`when`
  predicates stay single-table.
- Handlers: `query()` / `mutation()` from `@pramen/server`. Context is
  `{ db, kv, files, env, identity }`. Mutations are auto-wrapped in
  `storage.transaction()` by `runtime/dispatch.ts` (commit on return, rollback on
  throw) — do not write transaction control in handler code. Raw `BEGIN`/`COMMIT`
  via `sql.exec` is rejected by DO SQLite.
- `ctx.env` is the Worker/DO environment (bindings + vars + secrets), loosely typed —
  use it to call external services from handlers (`ctx.env.STRIPE_SECRET_KEY as string`).
- No raw SQL in handlers — go through `ctx.db` (`find` is compiled by
  `runtime/read-engine.ts`). `ctx.db.exec` is an escape hatch.
- `insert`/`update` echo the persisted row projected to the caller's readable fields
  ∪ the columns they wrote ∪ the PK — never leaks an unreadable field, never `{}`
  (a write-only caller still gets the generated id). `projectWrite` in `runtime/db.ts`.
- SQLite (DO) has no boolean type — booleans are stored as INTEGER 0/1; binding
  coercion lives in `runtime/db.ts` and `read-engine.ts`.
- CORS for browser clients is opt-in via the `CORS_ORIGINS` var (comma-separated
  origins or `*`); unset means same-origin only.

## DO SQLite

pramen runs on **Cloudflare DO SQLite** — its own engine, not stock sqlite3, so
don't assume sqlite3 C internals. Stick to the `SqlStorage` API
(`ctx.storage.sql.exec(sql, ...params)` → cursor `.toArray()`).
