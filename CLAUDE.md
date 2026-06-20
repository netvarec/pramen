# mrak

Reactive backend runtime for TypeScript on **Cloudflare**. Define schema +
handlers, get a backend deployed as a Worker + Durable Object. Sibling of
the prior runtime (Rust + Turso); mrak keeps the prior runtime's SDK shape but
swaps the substrate for Workers + DO. Read `DESIGN.md` for the mapping.

## WIP — everything is subject to change

Active development; nothing is stable. No backward-compat constraints — redesign
freely rather than patching around something that feels wrong. No preexisting
issues: if something is broken, fix it.

## Architecture

```
Worker (src/index.ts)  ->  MrakDO (per-tenant Durable Object)
                              ├─ ctx.storage.sql   in-process SQLite (the DB)
                              ├─ schemaDDL on boot (blockConcurrencyWhile)
                              └─ dispatch: query -> run; mutation -> storage.transaction()
```

- **The DO is the database.** Single-writer serialization is free (a DO handles
  one request at a time), per-tenant via `idFromName`.
- **D1 is NOT the DO's write path** — it's over-RPC, not in-process; the DO's
  SQLite is its transactional store. D1 is instead available as a separate
  substrate via the Worker (`x-mrak-store: d1`) — see the Substrate seam below.
- **SDK (`src/sdk/`) is platform-agnostic** — the portable product. `runtime/` is
  the Cloudflare glue.

## Commands

```bash
bun install
bun run dev          # lopata dev (Bun runtime; fast reload + /__dashboard); http://localhost:8787
bun run dev:wrangler # wrangler dev (miniflare) — workerd-parity check before deploy
bun run typecheck    # tsc --noEmit
bun run deploy       # wrangler deploy
```

Local dev runs on **lopata** (Bun-based CF runtime; fully emulates DO SQLite +
WebSocket Hibernation). It reads the oblaka-generated `wrangler.jsonc` unchanged and
serves a dashboard at `/__dashboard`. The e2e suite still boots real `wrangler dev`
(miniflare); run `bun run dev:wrangler` once before deploying to catch any
Bun-vs-workerd differences.

> mrak depends on lopata via a relative `file:` path (`../../contember/lopata`)
> because it needs a lopata fix (≥0.19.1): the canonical proxy-to-DO pattern
> `stub.fetch(new Request(request, { headers }))` deadlocked under lopata due to a
> Bun `new Request(req)` stream-body clone bug. Switch to a published `^0.19.1`
> once it's on npm.

## Substrate seam (Driver/Dialect)

The data layer runs over a `Driver` (async `exec` + `transaction`) + `Dialect`
(`src/runtime/driver.ts`), so the ACL/read/write engine is substrate-agnostic:

- **`DoSqliteDriver`** — the DO's in-process SQLite (the default write path).
- **`D1Driver`** — the SAME engine over a real D1 binding, run **in the Worker**
  (no DO) and selected per-request with the `x-mrak-store: d1` header. RPC only —
  live queries need the DO (single writer + socket host). Proven end-to-end in
  miniflare by `test/suites/d1.ts` (ACL, row scope, field/cell-level projection,
  RETURNING writes, aggregates). The D1 binding is declared in `oblaka.ts`.
- **`postgresDialect`** — shows the SQL shape for a future Hyperdrive/Postgres port
  (quoting + `$n` placeholders); needs a pg `Driver` over Hyperdrive.

## Conventions

- Schema: `Entity(t => ({ id: t.id(), ... }))` + `defineSchema({ table: Entity })`.
- Handlers: `query()` / `mutation()` from `src/sdk/handlers`. Mutations are
  auto-wrapped in `storage.transaction()` by `runtime/dispatch.ts` (commit on
  return, rollback on throw) — do not write transaction control in handler code.
  Raw `BEGIN`/`COMMIT` via `sql.exec` is rejected by DO SQLite.
- No raw SQL in handlers — go through `ctx.db` (`find` is compiled by
  `runtime/read-engine.ts`). `ctx.db.exec` is an escape hatch.
- SQLite (DO) has no boolean type — booleans are stored as INTEGER 0/1; binding
  coercion lives in `runtime/db.ts` and `read-engine.ts`.

## Turso vs DO SQLite

the prior runtime runs Turso (Rust SQLite rewrite). mrak runs **Cloudflare DO SQLite**, a
different engine again — don't assume Turso or sqlite3 C internals. Stick to the
`SqlStorage` API (`ctx.storage.sql.exec(sql, ...params)` → cursor `.toArray()`).
