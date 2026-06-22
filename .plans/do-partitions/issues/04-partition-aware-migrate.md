# Issue 04: Partition-aware migrate (DDL scoped to a partition)

**Priority:** high
**Files:** `packages/server/src/runtime/migrate.ts`

A partition-DO must create/alter **only its own partition's tables** — the others
don't (and must not) exist in that DO's SQLite.

## Implementation

- Add an optional `partition?: string` to `migrate`'s options. When set, migrate
  operates only on entities where `partitionOf(schema, name) === partition` (use
  Issue 02's `entitiesInPartition` / `partitionOf`). When unset, behavior is
  unchanged (all entities) — preserves the D1 path and any single-partition use.
- The schema-hash that migrate stores in `_pramen_meta` must be computed over the
  **partition's** entity subset (so two partitions of the same app don't thrash each
  other's hash / each correctly detects its own drift). Confirm the hash input is the
  filtered subset, not the whole schema.
- `renamedFrom` / destructive handling unchanged, just applied to the filtered set.
- Do NOT drop tables that belong to other partitions — since a partition-DO never sees
  them, the existing "drop tables not in schema" logic (if any) must operate only over
  the filtered subset, or it will try to drop everything. Verify and guard this.

## Acceptance criteria

- `migrate(driver, schema, { partition: "audit" })` creates only `audit`-partition
  tables; default-partition tables are untouched/absent.
- `migrate(driver, schema)` (no partition) behaves exactly as today.
- Schema-hash short-circuit works per-partition (re-running with the same partition is
  a no-op; changing a different partition's entity does not invalidate this one).
- A unit/integration test covers the filtered DDL and the no-partition default.
- `bun run typecheck` + tests pass.
