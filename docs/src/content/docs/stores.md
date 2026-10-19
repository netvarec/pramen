---
title: Stores (Durable Object & D1)
order: 9
summary: The default Durable Object store (single-writer, live queries) vs. the D1 store (read-scale via the Sessions API, no DO), selecting per request or app-wide, read-your-writes, and the limits.
---

pramen runs the **same** schema, ACL, and read/write engine over two stores. The
default is the **Durable Object** (the DO *is* the database); the **D1** store is a
first-class alternate for read-heavy / globally-distributed reads.

| | Durable Object (default) | D1 (`PRAMEN_STORE=d1`) |
|---|---|---|
| Where it runs | per-tenant DO (in-process SQLite) | the Worker, over a D1 binding (RPC) |
| Single-writer | yes (free, one request at a time) | no (D1 has no interactive transactions) |
| Live queries (`/live`) | ✅ | ❌ DO-only |
| Read replicas | none | ✅ Sessions API (read-your-writes) |
| Atomic multi-statement mutation | ✅ (rolls back on throw) | ❌ (each statement auto-commits) |
| Needs an export from the worker entry | ✅ the DO class | ❌ D1 is just a binding |
| Pre-auth routes (`ctx.callPrivileged`) | ✅ | ✅ (dispatches locally in the Worker) |

The DO remains the **write / atomic / live** database; D1 is the read-replica / no-DO
path. Both share the R2 file store, KV, and the deferred-task outbox.

**For a CMS behind a site, D1 is usually the right store**, and the only one that can live
inside the site's own Worker. A Durable Object has to be exported from the worker entry
(`export class PramenDO`), which means owning that entry; D1 is a binding and needs nothing.
That is the whole difference between "add one integration" and "hand-write a worker
entrypoint". Pick the DO when a mutation must be atomic, when you want live queries, or when
tenants must be isolated by construction.

## Selecting the store

- **The operator picks it.** Set the `PRAMEN_STORE=d1` var to run `/rpc` on D1; unset
  (or `do`) is the Durable Object.
- **Per request, only when opted in.** The header `x-pramen-store: d1` (or `do`) overrides
  `PRAMEN_STORE` **only** when `PRAMEN_STORE_HEADER=allow` is set. That is for local dev and
  tests (the e2e suite sets it); leave it off in a deployment.

> **Why the header is off by default.** Each store keeps its own `auth_users`, and a
> session names its user by a bare username signed with the shared `AUTH_SECRET`. A caller
> who could pick the store could sign up an admin's username on the store where it is free,
> then present that token to the admin's store, whose `refreshSession` reissues the admin's
> roles. With the store fixed by the operator, the second store is simply unreachable.
>
> A `PRAMEN_STORE` *var* can be dropped by some adapters' `cloudflare:workers` env proxies
> (e.g. Astro's), so the Worker may not see it in-process. Such an adapter must pass it
> through; the header is no longer a workaround.

`/live` always uses the Durable Object regardless of the header or default (live needs a
single writer + a socket host). If a request routes to the DO but **no DO is bound**, you
get a clear `400` ("no Durable Object (PRAMEN) is bound. Set PRAMEN_STORE=d1…") instead of
a crash.

The admin routes (`/admin/migrations`, `/admin/tasks/drain`, `/admin/tasks/list`) still
take `x-pramen-store: d1` to address the D1 store: they are admin-gated, and the header
there chooses what to inspect, not which users table authenticates the caller.

## Read replicas + read-your-writes (D1 Sessions API)

Each D1-store request opens **one D1 session** (`db.withSession(...)`) and runs all its
SQL through it. The Worker picks where the session's first read may start by handler
**kind**:

- a **mutation** anchors `first-primary`: its reads see current data; writes go to the
  primary regardless;
- a **query** anchors `first-unconstrained`: the first read may begin at the nearest
  replica.

The response carries the session's bookmark as the **`x-pramen-d1-bookmark`** header.
**`@pramen/client` captures it and replays it** on the next request, so a client
transparently **reads its own writes** even off a lagging replica (a supplied bookmark
wins over the kind default). Bare `fetch` callers can thread the header themselves; the
bookmark is monotonic, so once you hold one your reads never go backwards.

```ts
// @pramen/client does this for you; shown here for a raw fetch caller.
const res = await fetch(`${url}/rpc/createNote`, { method: "POST", headers, body });
const bookmark = res.headers.get("x-pramen-d1-bookmark"); // carry it forward
// next request: headers["x-pramen-d1-bookmark"] = bookmark  -> reads your own write
```

## Limits (intentional)

- **Live queries are DO-only**, so `/live` errors on the D1 path.
- **No interactive / atomic transactions on D1.** pramen mutations interleave reads +
  writes + `RETURNING` + trigger-into-outbox in one `transaction()`, which D1 can't do
  atomically (no interactive txns; `batch()` can't read mid-batch). So on D1
  `transaction(fn) = fn()`: each statement auto-commits, and a **multi-statement mutation
  does not roll back on throw** the way it does on a DO. Single-statement mutations are
  atomic. Use the DO store when you need atomic mutations.

  A failed mutation that had already written **says so**: the Worker logs the handler name
  and how many statements had committed. Without that, a partially applied mutation is
  indistinguishable from an ordinary 500 in the logs, which is the difference between "the
  request failed" and "the request failed and the data is in a state no code path intended".
- The reference setup uses **one shared D1 database across tenants**; a real product
  would add a tenant column or a per-tenant database. The ACL still scopes every row, so
  a shared bookmark only picks a consistency point, never widens access.

## Deferred tasks on D1

The DO store self-drains its [task outbox](/tasks) via an alarm. The D1 store has no
alarm, so drain it with a **Cron Trigger**: `createPramen(app).scheduled`, wired to a
`triggers.crons` entry in `oblaka.ts`, or on demand via `POST /admin/tasks/drain` with
the `x-pramen-store: d1` header.

A task enqueued with no delay is drained in the request tail, so it needs no cron. A
**delayed** one (a scheduled publish, a retry backoff) runs only under the Cron trigger,
and forgetting it fails silently: the task simply never runs. The Worker notices that exact
shape (a request-tail drain leaving a future-due task, with no Cron drain ever seen) and
logs it once per isolate, naming the config to add. Once a Cron drain fires, it stops.

## Pre-auth routes on D1

A route in `app.routes` runs before auth and has no `ctx.db`, so it reaches a handler
through `ctx.callPrivileged`. That used to forward only to a Durable Object, which made
everything built on a pre-auth route DO-only: signed preview links, the sitemap. On the D1
store it now dispatches **locally in the Worker** instead, through the same code path a
request takes.

The route uses the same store decision as `/rpc`: `PRAMEN_STORE`, or the request's
`x-pramen-store` header only under `PRAMEN_STORE_HEADER=allow`. A browser opening a signed
link sends no header anyway, so a deployment that serves such links from D1 sets
`PRAMEN_STORE=d1`.

`ctx.callPrivileged({ name, input, roles?, userId? })` presents a synthetic identity:
`roles` defaults to `["admin"]` (an explicit `[]` stays empty), and `userId`, when given,
becomes `ctx.identity.userId` on both stores.
