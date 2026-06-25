---
title: Stores (Durable Object & D1)
order: 9
summary: The default Durable Object store (single-writer, live queries) vs. the D1 store (read-scale via the Sessions API, no DO) — selecting per request or app-wide, read-your-writes, and the limits.
---

pramen runs the **same** schema, ACL, and read/write engine over two stores. The
default is the **Durable Object** (the DO *is* the database); the **D1** store is a
first-class alternate for read-heavy / globally-distributed reads.

| | Durable Object (default) | D1 (`x-pramen-store: d1`) |
|---|---|---|
| Where it runs | per-tenant DO (in-process SQLite) | the Worker, over a D1 binding (RPC) |
| Single-writer | yes (free — one request at a time) | no (D1 has no interactive transactions) |
| Live queries (`/live`) | ✅ | ❌ DO-only |
| Read replicas | — | ✅ Sessions API (read-your-writes) |
| Atomic multi-statement mutation | ✅ (rolls back on throw) | ❌ (each statement auto-commits) |

The DO remains the **write / atomic / live** database; D1 is the read-replica / no-DO
path. Both share the R2 file store, KV, and the deferred-task outbox.

## Selecting the store

- **Per request — the reliable way.** Send the header **`x-pramen-store: d1`** to run a
  call on D1, or `x-pramen-store: do` to force the Durable Object.
- **App-wide default.** Set the `PRAMEN_STORE=d1` var to make D1 the default when no
  header is sent (the header still overrides per request).

> **Prefer the header to pin the store.** A `PRAMEN_STORE` *var* can be dropped by some
> adapters' `cloudflare:workers` env proxies (e.g. Astro's), so the Worker may not see
> it in-process. The `x-pramen-store: d1` header is **always** honored.

`/live` always uses the Durable Object regardless of the header or default (live needs a
single writer + a socket host). If a request routes to the DO but **no DO is bound**, you
get a clear `400` ("no Durable Object (PRAMEN) is bound — pin the D1 store…") instead of a
crash.

## Read replicas + read-your-writes (D1 Sessions API)

Each D1-store request opens **one D1 session** (`db.withSession(...)`) and runs all its
SQL through it. The Worker picks where the session's first read may start by handler
**kind**:

- a **mutation** anchors `first-primary` — its reads see current data; writes go to the
  primary regardless;
- a **query** anchors `first-unconstrained` — the first read may begin at the nearest
  replica.

The response carries the session's bookmark as the **`x-pramen-d1-bookmark`** header.
**`@pramen/client` captures it and replays it** on the next request, so a client
transparently **reads its own writes** even off a lagging replica (a supplied bookmark
wins over the kind default). Bare `fetch` callers can thread the header themselves; the
bookmark is monotonic, so once you hold one your reads never go backwards.

```ts
// @pramen/client does this for you — shown here for a raw fetch caller.
const res = await fetch(`${url}/rpc/createNote`, { method: "POST", headers, body });
const bookmark = res.headers.get("x-pramen-d1-bookmark"); // carry it forward
// next request: headers["x-pramen-d1-bookmark"] = bookmark  -> reads your own write
```

## Limits (intentional)

- **Live queries are DO-only** — `/live` errors on the D1 path.
- **No interactive / atomic transactions on D1.** pramen mutations interleave reads +
  writes + `RETURNING` + trigger-into-outbox in one `transaction()`, which D1 can't do
  atomically (no interactive txns; `batch()` can't read mid-batch). So on D1
  `transaction(fn) = fn()`: each statement auto-commits, and a **multi-statement mutation
  does not roll back on throw** the way it does on a DO. Single-statement mutations are
  atomic. Use the DO store when you need atomic mutations.
- The reference setup uses **one shared D1 database across tenants** — a real product
  would add a tenant column or a per-tenant database. The ACL still scopes every row, so
  a shared bookmark only picks a consistency point, never widens access.

## Deferred tasks on D1

The DO store self-drains its [task outbox](/tasks) via an alarm. The D1 store has no
alarm, so drain it with a **Cron Trigger** — `createPramen(app).scheduled`, wired to a
`triggers.crons` entry in `oblaka.ts` — or on demand via `POST /admin/tasks/drain` with
the `x-pramen-store: d1` header.
