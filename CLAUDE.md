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
- **D1 is NOT the write path** — it's over-RPC, not in-process. The DO's SQLite
  is the transactional store. (D1 reserved for read-replicas/analytics later.)
- **SDK (`src/sdk/`) is platform-agnostic** — the portable product. `runtime/` is
  the Cloudflare glue.

## Commands

```bash
bun install
bun run dev          # wrangler dev (local miniflare); http://localhost:8787
bun run typecheck    # tsc --noEmit
bun run deploy       # wrangler deploy
```

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
