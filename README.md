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
their email. Run `bun run scripts/relation-smoke.ts`.

```bash
bun run scripts/acl-smoke.ts    # ACL + per-identity live-query test
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

```bash
bun run scripts/live-smoke.ts   # end-to-end live-query test against a running dev server
```

## Layout

```
src/
  index.ts            Worker entry — routes /rpc/<name> to the per-tenant DO
  durable-object.ts   MrakDO — in-process SQLite store, schema boot, dispatch
  sdk/                portable SDK (no platform dep)
    schema.ts         Entity() + defineSchema() + relations (belongsTo/hasMany)
    infer.ts          InferRow / WhereInput / InferInsert / InferUpdate
    app.ts            createApp(schema) -> typed query() / mutation()
    handlers.ts       query() / mutation() (untyped, schema-agnostic)
    acl.ts            role() / policy() / allow() / deny() / $identity() / resolve()
  runtime/            substrate glue
    ddl.ts            SchemaDef -> CREATE TABLE
    read-engine.ts    structured query -> parameterized SQL (TS; WASM later)
    db.ts             repository over ctx.storage.sql
    dispatch.ts       handler resolution + BEGIN/COMMIT for mutations
example/
  app.ts              the demo schema + handlers
```

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

## Deploy

```bash
bun run deploy         # wrangler deploy
```
