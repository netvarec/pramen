# Issue 06: DO partition awareness + runtime table-access guard

**Priority:** high
**Files:** `packages/server/src/durable-object.ts`, `packages/server/src/runtime/db.ts`

The partition-DO must learn its partition, migrate only its tables, register itself
per-partition, and **reject any handler that touches a table outside its partition**
(the runtime half of the boundary — no cross-DO data access).

## Implementation

### `durable-object.ts`
- Add `private partition = "default";` learned from the forwarded `x-pramen-partition`
  header (mirror how `tenant` is learned at `fetch()` from `x-pramen-tenant`,
  lines 88-89). Persist/restore on sockets via `SocketState` (add `partition`) so
  hibernation keeps it.
- Boot migrate must be partition-scoped. The constructor runs `migrate(...)` before it
  can know the partition from a header. Resolve this: defer the partition-scoped
  migration to the first `fetch()` (guarded by `blockConcurrencyWhile` + a
  `migrated` flag) once `x-pramen-partition` is known, OR pass the partition via the DO
  name if available. Document the chosen approach; the constructor's eager full-schema
  migrate must NOT create other partitions' tables.
- `ensureRegistered`: record this DO in the registry per partition using the key scheme
  and helpers from **Issue 11** (default partition keeps the bare `tenant:<t>` key;
  non-default uses `tenant:<t>:<p>`). One KV write per (tenant,partition) lifetime.
  Issue 11 owns the key format/enumeration; this issue just calls it once the partition
  is known.
- `broadcast` already only sees this DO's tables, so reactivity is naturally
  partition-local — no change needed beyond the guard below.

### `db.ts` — table-access guard
- In `Db` (find/insert/update/delete/count/aggregate entry points), reject access to a
  table whose `partitionOf(schema, table)` ≠ the DO's partition with a clear
  `BadRequest`: `table '<t>' is in partition '<pT>', not this partition '<pSelf>'`.
  The `Db`/`AclContext` must carry the active partition (thread it from the DO's
  `ctxFor` / Db construction). The D1 path (single shared store, no partition) passes
  `partition: undefined` ⇒ guard is a no-op there.
- This guard is what makes a mis-declared handler (Issue 05) fail loudly instead of
  reading an empty/absent table.

## Acceptance criteria

- A DO serving partition `audit` has only audit tables; querying a default-partition
  table through it returns the partition BadRequest, not empty results.
- Registry key is `tenant:<t>` for default, `tenant:<t>:<p>` otherwise.
- Socket state survives hibernation with the partition intact.
- Existing single-(default-)partition behavior and data are unchanged.
- `bun run typecheck` + tests pass.
