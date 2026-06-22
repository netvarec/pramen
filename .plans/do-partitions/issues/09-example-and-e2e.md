# Issue 09: Example partitioned entity + e2e tests

**Priority:** high
**Files:** `example/app.ts`, `packages/server/test/suites/*` (new `partitions.ts` suite), test index

Prove the whole feature end-to-end and give the example a real partitioned entity.

## Implementation

### Example (`example/app.ts`)
- Add an append-only entity in its own partition, e.g.
  `auditLog: Entity(t => ({ id: t.id(), action: t.text(), at: t.int() }), undefined, { partition: "audit" })`.
- Add a handler `logAudit` (mutation) and `listAudit` (query) declared with
  `{ partition: "audit" }`. Keep an existing default-partition handler that writes
  `notes` to show the two DOs operate independently.
- Add an ACL rule for the audit partition's entity (the suite needs a role that can
  read/write it).

### e2e suite (`partitions.ts`, booted like the other miniflare suites)
Cover, against real `wrangler dev`:
1. **Same-partition still works**: notes tx + relation traversal + a live subscription
   that pushes on a notes mutation (regression guard for the default path).
2. **Partition isolation**: `logAudit` writes land in the `audit` DO; a default-DO
   `/admin/schema` does NOT list the audit table and vice-versa.
3. **Cross-partition relation rejected**: a schema with a relation crossing partitions
   fails `validateSchema`/migrate (unit-level is fine if e2e is awkward).
4. **Runtime guard**: addressing an audit table through a default-partition handler/DO
   returns the partition BadRequest (Issue 06).
5. **Reactivity is partition-local**: an audit-partition mutation does not wake a
   notes-partition subscription (different DOs — assert no cross push).
6. **Admin per-partition**: `/admin/data` and `/admin/schema` with `partition=audit`
   reach the audit DO; without it, the default DO (Issue 07).

## Acceptance criteria

- New suite passes under the existing `bun test` (miniflare) harness.
- Example typechecks and runs in `bun run dev` (lopata) with both partitions live.
- `bun run typecheck` + full `bun test` green.
