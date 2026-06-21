# pramen

Reactive backend runtime for TypeScript — **on Cloudflare**. Define a schema and
handlers; get a complete backend deployed as a Worker + Durable Object, where the
platform provides the single-writer/storage/replication stack. See
[DESIGN.md](./DESIGN.md).

## Quick start

```bash
bun install
bun run dev            # lopata dev (Bun runtime; fast reload + /__dashboard) on http://localhost:8787
# bun run dev:wrangler # wrangler dev (miniflare) — workerd-parity check before deploy

# Requests need a signed bearer JWT (deny-by-default; see Auth/ACL below). The
# token must be authorized for the tenant (here the default "main") via a
# `tenants` claim — admins may access any tenant.
TOKEN=$(bun -e 'import {token} from "./scripts/jwt"; console.log(await token("alice",["author"],{tenants:["main"]}))')

# create a note
curl -s -X POST http://localhost:8787/rpc/createNote \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"title":"hello","body":"from pramen"}'

# list notes
curl -s -X POST http://localhost:8787/rpc/listNotes -H "authorization: Bearer $TOKEN"
```

### Auth

The Worker verifies a **bearer JWT** (WebCrypto), checks `exp`/`nbf`, and maps
claims to an Identity (`sub`→userId, `roles`/`role`→roles, custom claims pass
through). A forged or unsigned request gets no identity. Verification is pluggable
(`VerifyStrategy` in `packages/server/src/auth.ts`):

- **HS256** (`HmacStrategy`) — shared secret in `AUTH_SECRET` (dev value in
  `wrangler.jsonc`; production via `wrangler secret put AUTH_SECRET`). The default.
- **RS256 via JWKS** (`JwksStrategy`) — set `JWKS_URL` to your identity provider's
  JWKS endpoint and tokens are verified asymmetrically against the fetched public
  keys (cached, with `kid` selection and rotation handling). When `JWKS_URL` is
  set it takes over from `AUTH_SECRET`.

### ACL

Access is **deny-by-default**; roles grant it. Define roles/policies on the app
(`example/app.ts`); identity comes from the verified token (`packages/server/src/auth.ts`). Grants
OR-merge across an identity's roles; row-level `where` scopes are AND-merged into
queries, and `fields` restrict read projection / writable columns.

```ts
role("author", [
  policy("author:read",   "notes", "read",   { where: { ownerId: $identity("userId") } }),
  policy("author:create", "notes", "create", allow()),
  policy("author:update", "notes", "update", { where: { ownerId: $identity("userId") } }),
]);
```

ACL `where` rules accept the same operators and `AND`/`OR` as queries, with
`$identity` markers usable anywhere (including inside `in`):

```ts
// reads notes owned by anyone on the caller's team; no `team` claim -> sees none
policy("manager:read", "notes", "read", { where: { ownerId: { in: $identity("team") } } });
```

**Cell-level (per-row) field ACL.** Beyond the flat `fields` list, a policy can
grant fields *conditionally per row* — visibility that depends on the row's data,
not just the (entity, action). Use the declarative `conditionalFields` (a row
predicate, statically analyzable) or the `fieldsFn` escape hatch for arbitrary
logic. Conditional grants are **additive** — they only ever add fields to the base.

```ts
// teammate reads every note, but sees `body` only on the notes they own
policy("teammate:read", "notes", "read", {
  fields: ["id", "title", "ownerId", "createdAt"],
  conditionalFields: [{ fields: ["body"], when: { ownerId: $identity("userId") } }],
  // or, equivalently, the function form:
  // fieldsFn: (identity, row) => (row.ownerId === identity?.userId ? ["body"] : []),
});
```

The same rules enforce writes per row (insert checks the candidate values, update
the post-merge row), so a teammate can edit `body` on their own note but not on
another's. A conditionally-visible column can't be aggregated or used in `orderBy`
(that would leak its value across rows).

The example roles (`example/app.ts`): `admin` (full access), `author` (own notes
only — mint a token with `sub` = the owner), `reader` (reads all, no `body`),
`member` (read unlocked dynamically once you've authored a note). Live
subscriptions inherit the connecting identity, so pushes respect row-level scope.

**Relations & nested ACL.** Entities declare `belongsTo`/`hasMany`; eager-load via
`find({ with: { owner: true } })`. Each traversal is independently ACL-checked: a
relation loads under the related entity's own read scope, or via a parent policy's
`relations: { owner: { directAccess: true, fields: [...] } }` grant (traversal-only
access to an otherwise unreadable entity, optionally field-restricted). So an
author can see `note.owner` (id + name) without being able to list users or see
their email. Covered by `bun test`.

**Write-side ACL.** A write policy may `set` server-controlled columns (forced,
overriding client input — e.g. `set: { ownerId: (i) => i?.userId }` so a note's
owner can't be forged) and `validate` the final values (throw to reject):

```ts
policy("author:create", "notes", "create", {
  set: { ownerId: (i) => i?.userId },
  validate: ({ values }) => { if (!values.title) throw new Error("title required"); },
});
```

```bash
bun test    # boots wrangler dev once and runs all e2e suites
```

### Live queries (WebSocket)

Connect to `ws://localhost:8787/live` and subscribe to a query. The server pushes
fresh results whenever a mutation writes a table the query reads — over HTTP *or*
over the socket. Single-writer DOs see every write, so invalidation is exact.

```jsonc
// client -> server
{ "type": "subscribe",   "id": "s1", "name": "listNotes" }
{ "type": "call",        "id": "c1", "name": "createNote", "input": { "title": "hi", "body": "x" } }
{ "type": "unsubscribe", "id": "s1" }
// server -> client
{ "type": "data",   "id": "s1", "result": [ /* ... */ ] }  // initial + every update
{ "type": "result", "id": "c1", "result": { /* ... */ } }  // reply to a call
{ "type": "error",  "id": "s1", "error": "..." }
```

## Layout

The runtime is the **`@pramen/server`** package; a project is just `app.ts`,
`oblaka.ts`, and a 3-line `worker.ts` (`createPramen(app)`).

```
oblaka.ts             IaC source of truth -> generates wrangler.jsonc (main -> example/worker.ts)
packages/server/      @pramen/server — the runtime (publishable)
  src/
    index.ts          authoring entry: re-exports schema/handlers/ACL/files/errors/substrate
    worker-entry.ts   deploy entry ("@pramen/server/worker"): createPramen + the DO (cloudflare:workers)
    pramen.ts         createPramen(app) -> { fetch, PramenDO }
    worker.ts         makeWorker(app) — verifies JWT, routes to the DO, /files/*, admin
    durable-object.ts PramenDOBase + pramenDO(app) — in-process SQLite, schema boot, dispatch, live
    auth.ts           pluggable JWT verification — HS256 + RS256/JWKS (claims -> Identity)
    sdk/              portable SDK (no platform dep)
      schema.ts        Entity() + defineSchema() + relations (belongsTo/hasMany); fileRef type
      infer.ts         InferRow / WhereInput / InferInsert / InferUpdate / relations
      app.ts           createApp(schema) -> typed query() / mutation()
      handlers.ts      query() / mutation(); HandlerContext (ctx.db / ctx.kv / ctx.files)
      acl.ts           role/policy/allow/deny/$identity/resolve + set/validate
      files.ts         FileRef + Files (the ctx.files type surface)
    runtime/          substrate glue
      errors.ts        typed error envelope (status + code; no internal leakage)
      storage.ts       R2/Memory StorageAdapter, signed tokens, ctx.files, /files endpoint
      ddl.ts · migrate.ts · read-engine.ts · acl.ts · db.ts · dispatch.ts · driver.ts · kv.ts
example/
  app.ts              the demo schema + handlers + ACL
  worker.ts           the 3-line entry: createPramen(app) (oblaka's `main`)
packages/client · packages/react   typed @pramen/client + @pramen/react
test/
  e2e.test.ts         boots one wrangler-dev server, runs every suite (bun test)
  suites/             acl · resolver · relation · live · files · d1 (reusable suite fns)
  lib.ts              assert + HTTP/WS helpers + JWT minting
```

## Building & publishing

The three packages build to `dist` (JS + `.d.ts`) with `tsc` — `bun run build`.
In the monorepo, `exports` resolve to `src` (fast edit-rerun, no build needed for
dev/tests); `publishConfig.exports` point at `dist` so published consumers get
compiled output. The `dist` is plain ESM mirroring `src` and is meant to be bundled
by the consumer's wrangler/esbuild (every real pramen consumer bundles for Workers).

## Production config

- Set real secrets: `wrangler secret put AUTH_SECRET` (and `FILES_SECRET` if using
  files — it must be ≥16 chars, else file storage fails closed). Auth itself fails
  closed too: an empty `AUTH_SECRET` rejects every token.
- Destructive migrations are **off by default**. A drop/rename/type-change is skipped
  (and logged) unless `PRAMEN_ALLOW_DESTRUCTIVE=true` — so a schema edit can't silently
  drop a column on deploy. Additive changes always apply.
- CORS is opt-in via `CORS_ORIGINS`; unset = same-origin only.

## Tests

`bun test` generates the config from `oblaka.ts`, boots a single `wrangler dev`
against fresh local state, and runs all suites (each on its own tenant) — ACL +
write rules + per-identity live queries, dynamic resolvers, relations/nested ACL,
and live-query row-level invalidation. CI runs typecheck + `bun test` on every
push/PR (`.github/workflows/ci.yml`); no Cloudflare credentials needed (miniflare).

### Typed handlers

`createApp(schema)` returns `query`/`mutation` whose `ctx.db` is fully inferred
from the schema — table names, `where` columns and value types, row results, and
insert/patch shapes are all checked at compile time.

```ts
const { query, mutation } = createApp(schema);

const listNotes = query((ctx) =>
  ctx.db.find({ from: "notes", orderBy: { column: "createdAt", dir: "desc" } }),
);                              // rows typed: { id: number; title: string | null; ... }

// ctx.db.find({ from: "nope" })            -> type error: unknown table
// ctx.db.find({ where: { title: 123 } })   -> type error: title is string
```

The handler context is `{ db, kv, files, env, identity }`. **Field builders:**
`id`, `textId`, `text`, `int`, `real`, `bool`, `json` (arbitrary JSON, typed as
`JsonValue`), `fileRef` (an R2 file). `json`/`fileRef` are stored as TEXT and
codec'd to/from the parsed value automatically. **Modifiers** wrap a builder and
compose: `notNull()`, `unique()`, `indexed()`, `defaultTo(v)` — e.g.
`code: unique(t.text())`, `status: defaultTo(t.text(), "pending")` (a defaulted
column is optional on insert).

**Public flows.** An unauthenticated caller is evaluated as the `anonymous` role —
define it to grant public reads/writes (absent ⇒ deny). A policy `where` can use
`$input("field")` (alongside `$identity`) for a capability read — authorize a row by
a request-supplied unguessable key, with no enumeration. Signature-authed endpoints
(e.g. Stripe webhooks) go in `app.routes`, matched before auth:

```ts
export const app = {
  schema, handlers, acl,
  routes: [
    { method: "POST", path: "/stripe/webhook", handler: async (req, env, ctx) => {
        // verify the signature on the raw body, then:
        return ctx.callPrivileged({ name: "markPaid", input: { id } }); // privileged → DO
    } },
  ],
};
```

**`ctx.env`** is the Worker/DO environment (bindings + vars + secrets) — call
external services straight from a handler:

```ts
const createCheckout = mutation(async (ctx, input: { amount: number }) => {
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.env.STRIPE_SECRET_KEY as string}` },
    body: /* ... */ "",
  });
  return res.json();
});
```

For a browser client on a different origin, set `CORS_ORIGINS` (comma-separated
origins, or `*`) and the Worker adds CORS to `/rpc` + `/live` (preflight included);
unset means same-origin only.

### Errors & input validation

Responses are `{ ok: false, error, code }` with a real status: ACL denial → `403
forbidden`, bad input / unknown handler / failed `validate` → `400 bad_request`.
Anything unexpected is logged server-side and returned as a generic `500` — stack
traces and internal messages never reach the client. A handler may declare an
`input` validator that parses the raw body and throws to reject:

```ts
createNote: mutation(run, {
  input: (raw) => {
    const o = raw as any;
    if (typeof o?.title !== "string") throw new Error("title must be a string");
    return { title: o.title, body: String(o.body ?? "") };
  },
});
```

### Queries

`where` supports equality shorthand, per-column operators, and nestable
`AND`/`OR`; plus multi-column `orderBy` and `limit`/`offset` pagination. All
values are parameterized; column names are validated against injection.

```ts
ctx.db.find({
  from: "notes",
  where: {
    ownerId: "alice",                       // eq shorthand
    createdAt: { gte: cutoff },             // gt / gte / lt / lte / ne
    title: { like: "report-%" },            // like (string columns only)
    id: { in: [1, 2, 3] },                  // in / notIn
    OR: [{ pinned: true }, { archivedAt: { isNull: true } }],
  },
  orderBy: [{ column: "createdAt", dir: "desc" }, { column: "id" }],
  limit: 20,
  offset: 40,
});
```

For large or changing datasets, prefer **cursor (keyset) pagination** — stable
under concurrent inserts/deletes. `db.page()` returns `{ items, cursor, hasMore }`;
pass the previous `cursor` back as `after`. The primary key is auto-appended to
`orderBy` as a tiebreaker, so the cursor is unambiguous.

```ts
let after: string | undefined;
do {
  const { items, cursor, hasMore } = ctx.db.page({
    from: "notes",
    orderBy: { column: "createdAt", dir: "desc" },
    limit: 50,
    after,
  });
  // ... process items ...
  after = cursor ?? undefined;
  if (!hasMore) break;
} while (after);
```

### Count & aggregates

`db.count()` and `db.aggregate()` (count/sum/avg/min/max, optional `groupBy`) are
ACL-scoped — the read `where` is applied, and aggregating a column you can't read
is denied (counting rows you *can* see is always allowed).

```ts
const open = ctx.db.count({ from: "tickets", where: { status: "open" } });

const perOwner = ctx.db.aggregate({
  from: "notes",
  groupBy: "ownerId",
  aggregations: { count: { fn: "count" }, lastId: { fn: "max", column: "id" } },
});  // typed: { ownerId: string | null; count: number; lastId: number | null }[]
```

### Tenants

Each tenant is a Durable Object addressed by `X-Pramen-Tenant` (default `main`).
Durable Objects can't be enumerated, so on a tenant's first touch its name is
recorded in the `TENANTS` KV registry (once, from the DO itself). Admins can list
them:

```bash
curl -s http://localhost:8787/tenants -H "authorization: Bearer $ADMIN_TOKEN"
# { "ok": true, "result": ["main", "acme", ...] }
```

The Worker **authorizes the tenant** against the caller before reaching the DO
(`authorizeTenant` in `packages/server/src/auth.ts`): admins may access any tenant; everyone else
only tenants listed in their `tenants` claim. Customize for your tenancy model.

**Recovery.** SQLite-backed DOs have 30-day point-in-time recovery. An admin can
restore a tenant to a past moment; the response includes an `undo` bookmark so the
operation is reversible:

```bash
curl -s -X POST http://localhost:8787/admin/recover -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"tenant":"acme","timestamp":1718000000000}'
```

> PITR is platform-only — unavailable in local dev (`wrangler dev` returns 501).
> pramen arms the restore and returns the `undo` bookmark; it completes on the DO's
> next restart (we don't auto-`abort()`, so the call can return the bookmark).

### KV (ctx.kv)

Handlers get `ctx.kv` — the project's KV namespace for **global, cross-tenant**
config / feature flags / caches (per-tenant data belongs in `ctx.db`). It's keyed
under an `app:` prefix so it never collides with pramen-internal keys, and it is
**not** part of a mutation's transaction.

```ts
getFlag: query((ctx, input: { key: string }) => ctx.kv.get(`flag:${input.key}`, "json")),
setFlag: mutation((ctx, input: { key: string; value: string }) =>
  ctx.kv.put(`flag:${input.key}`, input.value),
);
```

**Multiple projects in one account:** Cloudflare resource names are account-global,
so each project sets a unique `PROJECT` in `oblaka.ts` — it names the Worker, the
DO, and the KV namespace, so projects never collide. Within a project, one KV
namespace holds both the registry (`tenant:`) and app (`app:`) keys.

### Client (frontend)

`@pramen/client` is a typed client — `call()` is RPC over HTTP, `subscribe()` is a
live query over a reconnecting WebSocket. It's generic over your server's handler
map, so calls are fully typed with no runtime dependency on the server (import the
type only):

```ts
import { createClient } from "@pramen/client";
import type { app } from "../server/app"; // type-only, erased at build

const pramen = createClient<typeof app.handlers>({ url, token, tenant: "acme" });

const note = await pramen.call("createNote", { title: "hi", body: "..." }); // typed
const stop = pramen.subscribe("listNotes", undefined, { onData: (notes) => render(notes) });
```

`@pramen/react` adds hooks that re-render on every server push:

```tsx
const { data, loading } = useLiveQuery(pramen, "listNotes");
const createNote = useMutation(pramen, "createNote");
```

### CLI

```bash
bun run pramen help
bun run pramen init my-app                 # scaffold app.ts + oblaka.ts
bun run pramen token alice author --tenant acme   # mint a dev JWT
bun run pramen schema sql                  # CREATE TABLE for the schema
bun run pramen schema snapshot             # baseline in .pramen/schema.json
bun run pramen schema diff                 # additive vs destructive changes
bun run pramen schema status --tenant acme # is a deployed tenant caught up?
```

`schema diff` flags each change as additive (no data loss) or **destructive**
(drop / type change — rebuilds the table, may lose data). All are auto-applied on
the next DO boot; declare a `renamedFrom` hint to migrate a renamed column's data
instead of dropping it.

### Migrations

The schema is reconciled with the store on every DO boot, inside a storage
transaction. Two passes:

- **Additive** (no data loss): new tables are created and new columns added
  (`ALTER TABLE ADD COLUMN`, nullable).
- **Destructive** (auto-applied): a column the schema no longer declares is
  dropped, a type change is applied, and a table absent from the schema is dropped
  — all via the standard SQLite table-rebuild (create new, copy, drop, rename),
  preserving rows and ids. This **can lose data** on a bad deploy, by design.

A schema hash in `_pramen_meta` skips the work when nothing changed. A **rename**
can't be inferred from a diff (a removed + added column is ambiguous), so declare
it with `renamedFrom` — the migrator then copies the old column's data:

```ts
notes: Entity((t) => ({ id: t.id(), title: t.text(), content: renamedFrom(t.text(), "body") })),
```

Without the hint, a rename is applied as drop + add (the old column's data is lost).

## Deploy

Cloudflare topology is declared in **`oblaka.ts`** (the source of truth) — the
Worker, the `PRAMEN` Durable Object, its SQLite migration, vars, and observability.
`oblaka` generates `wrangler.jsonc` from it (git-ignored; never edit by hand).

```bash
bun run config         # oblaka oblaka.ts        -> generate wrangler.jsonc (local)
bun run dev            # regenerate + wrangler dev
bun run plan           # oblaka --remote --dry-run -> preview the remote changes

# Real deploy: provision resources via oblaka, then ship the code via wrangler.
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
wrangler secret put AUTH_SECRET   # production auth secret (overrides the dev var)
bun run deploy --env production    # oblaka --remote (provision + config) && wrangler deploy
```

`oblaka --remote` provisions the Worker + Durable Object (and the SQLite DO
migration) on Cloudflare and writes the config; `wrangler deploy` bundles and
uploads the Worker entry (`worker.ts`, your `createPramen(app)` call).
