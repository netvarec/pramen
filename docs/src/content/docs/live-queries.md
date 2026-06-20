---
title: Live Queries
order: 7
summary: Subscribe to a query over a WebSocket and receive a push on every relevant mutation.
---

Connect to `ws://<host>/live` and subscribe to a query by name. The server pushes
fresh results whenever a mutation writes a table that the query reads — whether the
write came over HTTP *or* over the socket. Because a Durable Object sees every write
to its store (single-writer), invalidation is **exact**: only subscriptions whose
read set intersects the mutation's write set are re-run.

Subscriptions inherit the connecting identity, so every push respects the same
row-level scope and field projection as a normal read.

## Protocol

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

The WebSocket uses Cloudflare's hibernation API, so idle connections don't pin the
DO in memory.

## Browser tokens

Browser WebSockets can't set headers, so `/live` also accepts the bearer token and
tenant via the query string (`?token=...&tenant=...`); the Worker folds them into
headers for the rest of the flow. The `@pramen/client` library handles this for you —
see [Clients](/docs/client).
