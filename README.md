# mrak

Reactive backend runtime for TypeScript — **on Cloudflare**. Define a schema and
handlers; get a complete backend deployed as a Worker + Durable Object. A sibling
of the prior runtime, re-architected onto Cloudflare primitives
instead of a Rust + Turso runtime. See [DESIGN.md](./DESIGN.md).

## Quick start

```bash
bun install
bun run dev            # wrangler dev (local, miniflare) on http://localhost:8787

# Requests need a signed bearer JWT (deny-by-default; see Auth/ACL below).
# Mint one with the dev secret:
TOKEN=$(bun -e 'import {token} from "./scripts/jwt"; console.log(await token("alice",["author"]))')

# create a note
curl -s -X POST http://localhost:8787/rpc/createNote \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"title":"hello","body":"from mrak"}'

# list notes
curl -s -X POST http://localhost:8787/rpc/listNotes -H "authorization: Bearer $TOKEN"
```

### Auth

The Worker verifies an **HS256 bearer JWT** (WebCrypto) against `AUTH_SECRET`
(dev value in `wrangler.jsonc`; production via `wrangler secret put AUTH_SECRET`),
checks `exp`/`nbf`, and maps claims to an Identity (`sub`→userId, `roles`/`role`→
roles, custom claims pass through). A forged or unsigned request gets no identity.
Swap `verifyJwt` for RS256/EdDSA + JWKS without touching the rest of the system.

### ACL

Access is **deny-by-default**; roles grant it. Define roles/policies on the app
(`example/app.ts`); identity comes from the verified token (`src/auth.ts`). Grants
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

```
oblaka.ts             IaC source of truth -> generates wrangler.jsonc
src/
  index.ts            Worker entry — verifies JWT, routes to the per-tenant DO
  auth.ts             HS256 JWT verification (claims -> Identity)
  durable-object.ts   MrakDO — in-process SQLite, schema boot, dispatch, live queries
  sdk/                portable SDK (no platform dep)
    schema.ts         Entity() + defineSchema() + relations (belongsTo/hasMany)
    infer.ts          InferRow / WhereInput / InferInsert / InferUpdate / relations
    app.ts            createApp(schema) -> typed query() / mutation()
    handlers.ts       query() / mutation() (untyped, schema-agnostic)
    acl.ts            role/policy/allow/deny/$identity/resolve + set/validate
  runtime/            substrate glue
    errors.ts         typed error envelope (status + code; no internal leakage)
    ddl.ts            CREATE TABLE / ADD COLUMN fragments
    migrate.ts        additive schema migration on DO boot (create + add column)
    read-engine.ts    structured query + SqlExpr -> parameterized SQL (TS; WASM later)
    acl.ts            scope resolution, relation scopes, warmup, write rules
    db.ts             ACL-enforcing repository over ctx.storage.sql (+ eager loading)
    dispatch.ts       handler resolution + storage.transaction() for mutations
example/
  app.ts              the demo schema + handlers + ACL
test/
  e2e.test.ts         boots one wrangler-dev server, runs every suite (bun test)
  suites/             acl · resolver · relation · live (reusable suite fns)
  lib.ts              assert + HTTP/WS helpers + JWT minting
```

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
});                              // [{ ownerId, count, lastId }, ...]
```

### Tenants

Each tenant is a Durable Object addressed by `X-Mrak-Tenant` (default `main`).
Durable Objects can't be enumerated, so on a tenant's first touch its name is
recorded in the `TENANTS` KV registry (once, from the DO itself). Admins can list
them:

```bash
curl -s http://localhost:8787/tenants -H "authorization: Bearer $ADMIN_TOKEN"
# { "ok": true, "result": ["main", "acme", ...] }
```

> Note: tenant names aren't yet checked against the caller's identity — in
> production, gate `X-Mrak-Tenant` against what the authenticated user may access.

### Migrations

The schema is reconciled with the store on every DO boot — new tables are created
and new fields are added (`ALTER TABLE ADD COLUMN`, nullable) **without data
loss**. A schema hash in `_mrak_meta` skips the work when nothing changed. Just
edit the schema and redeploy; existing rows are preserved. (Additive only —
column drops/renames/type changes aren't auto-applied.)

## Deploy

Cloudflare topology is declared in **`oblaka.ts`** (the source of truth) — the
Worker, the `MRAK` Durable Object, its SQLite migration, vars, and observability.
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
uploads `src/index.ts`.
