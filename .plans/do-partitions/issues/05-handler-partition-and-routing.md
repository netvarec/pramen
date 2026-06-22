# Issue 05: Handler partition declaration + Worker routing key

**Priority:** high
**Files:** `packages/server/src/sdk/handlers.ts`, `packages/server/src/worker.ts`

Route each RPC/live request to the right partition-DO. The Worker must pick the DO
before dispatch, so the partition is declared on the handler (static, server-side).

## Implementation

### Handler opts (`handlers.ts`)
- Add `partition?: string` to `HandlerOpts<I>` and `readonly partition?: string` to
  `Handler`. `query`/`mutation` thread it through: `partition: opts?.partition`.
  Absent ⇒ treated as `"default"` by the router.

### Worker routing (`worker.ts`)
- Add a helper `partitionStubFor(env, tenant, partition)`:
  - **default partition ⇒ bare key**: `env.PRAMEN.get(env.PRAMEN.idFromName(tenant))`
    (UNCHANGED key — backward-compat, do not switch default to `tenant:default`).
  - otherwise: `env.PRAMEN.get(env.PRAMEN.idFromName(`${tenant}:${partition}`))`.
- For `/rpc/<name>`: look up `app.handlers[name]?.partition ?? "default"` and route via
  `partitionStubFor`. Forward the partition to the DO in a new `x-pramen-partition`
  header (the DO needs it for registry + scoping; see Issue 06).
- For `/live` (WebSocket): a single socket subscribes to queries; subscriptions on one
  socket must all be in one partition (cross-partition live is out of scope). Route the
  socket by a partition selected at connect time — accept it via query string
  (`?partition=`) folded into `x-pramen-partition` (mirror the existing `?token`/
  `?tenant` folding at `worker.ts:161-168`), default `"default"`. Reject (close) a
  `subscribe`/`call` whose handler's declared partition ≠ the socket's partition (the
  enforcing check can land in Issue 06 where the DO knows its partition).
- `callPrivileged` gains an optional `partition` (default `"default"`) and routes the
  same way; forward `x-pramen-partition`.

## Acceptance criteria

- A handler with no `partition` opt routes to `idFromName(tenant)` exactly as today
  (byte-for-byte same key — verify existing e2e still pass against existing data).
- A handler with `{ partition: "audit" }` routes to `idFromName(`${tenant}:audit`)`.
- `x-pramen-partition` is forwarded on rpc, live, and callPrivileged paths.
- `bun run typecheck` + existing tests pass (default path unchanged).
