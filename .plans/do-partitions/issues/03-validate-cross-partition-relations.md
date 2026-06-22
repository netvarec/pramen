# Issue 03: Schema validation — reject cross-partition relations

**Priority:** high
**Files:** `packages/server/src/sdk/schema.ts` (or new `packages/server/src/sdk/validate.ts`), `packages/server/src/runtime/migrate.ts`

The cross-partition boundary for relations is enforced statically: a relation whose
target entity is in a different partition than its source is illegal. Relations are
static, so this is caught at schema-validation time (boot + codegen), never as a
runtime surprise.

## Implementation

- Add `export function validateSchema(schema: SchemaDef): void` that throws a clear
  error for each violation. Depends on Issue 02's `partitionOf`.
  - For every entity `E` and every relation `R` in `E.relations`, compare
    `partitionOf(schema, E)` with `partitionOf(schema, R.target)`. If they differ,
    throw:
    `relation '<E>.<relName>' crosses a partition boundary: '<E>' is in partition
    '<pE>' but target '<R.target>' is in '<pT>'. Relations cannot cross partitions —
    put both entities in the same partition or drop the relation.`
  - Also validate the relation target exists in the schema (reuse/centralize if such a
    check already exists; otherwise add it here).
- Call `validateSchema(schema)` once before/at the start of `migrate()` so both the DO
  boot path (`durable-object.ts`) and the Worker D1 path (`worker.ts ensureD1Migrated`)
  get it for free. Validation must run even when there is only one (default) partition
  — it's cheap and catches target typos.

## Acceptance criteria

- A schema with `notes` (default) → `belongsTo("users")` where `users` is in partition
  `"audit"` throws the cross-partition error naming the relation, both partitions.
- A schema where related entities share a partition validates clean.
- Validation is invoked on DO boot and on the D1 migrate path (add a test asserting a
  cross-partition schema fails to migrate).
- `bun run typecheck` + existing tests pass.
