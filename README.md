# mrak

Reactive backend runtime for TypeScript — **on Cloudflare**. Define a schema and
handlers; get a complete backend deployed as a Worker + Durable Object. A sibling
of the prior runtime, re-architected onto Cloudflare primitives
instead of a Rust + Turso runtime. See [DESIGN.md](./DESIGN.md).

## Quick start

```bash
bun install
bun run dev            # wrangler dev (local, miniflare) on http://localhost:8787

# create a note
curl -s -X POST http://localhost:8787/rpc/createNote \
  -H 'content-type: application/json' \
  -d '{"title":"hello","body":"from mrak"}'

# list notes
curl -s -X POST http://localhost:8787/rpc/listNotes
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
    schema.ts         Entity() + defineSchema()
    handlers.ts       query() / mutation()
  runtime/            substrate glue
    ddl.ts            SchemaDef -> CREATE TABLE
    read-engine.ts    structured query -> parameterized SQL (TS; WASM later)
    db.ts             repository over ctx.storage.sql
    dispatch.ts       handler resolution + BEGIN/COMMIT for mutations
example/
  app.ts              the demo schema + handlers
```

## Deploy

```bash
bun run deploy         # wrangler deploy
```
