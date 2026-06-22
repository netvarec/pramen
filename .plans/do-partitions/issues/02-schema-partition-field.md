# Issue 02: Schema — `partition` on Entity + `partitionOf` helper

**Priority:** high
**Files:** `packages/server/src/sdk/schema.ts`

Add partition as an optional, third argument to `Entity()` and surface it on
`EntityDef`. Default partition name is `"default"`.

## Implementation

- Extend `EntityDef` with `readonly partition: string` (always populated; defaults to
  `"default"` so downstream code never branches on `undefined`).
- Add a third param to `Entity()`:
  ```ts
  export function Entity<F extends EntityFields, R extends RelationDefs = Record<string, never>>(
    build: (t: FieldBuilders) => F,
    relations?: (r: RelationBuilders) => R,
    opts?: { partition?: string },
  ): EntityDef<F, R>
  ```
  Set `partition: opts?.partition ?? "default"` in the returned object. Keep the
  existing `relations ? relations(...) : {}` behavior.
- Add a helper `export const DEFAULT_PARTITION = "default";` and
  `export function partitionOf(schema: SchemaDef, entity: string): string` returning
  `schema[entity]?.partition ?? DEFAULT_PARTITION`.
- Add `export function partitionsOf(schema: SchemaDef): string[]` → the distinct
  partition names in a schema (used by migrate/admin to enumerate). Stable order.
- Add `export function entitiesInPartition(schema: SchemaDef, partition: string): string[]`
  → table names whose `partitionOf === partition`.

## Acceptance criteria

- `Entity(t => ({...}))` still works (partition defaults to `"default"`).
- `Entity(t => ({...}), r => ({...}), { partition: "audit" })` sets `partition: "audit"`.
- `partitionOf` / `partitionsOf` / `entitiesInPartition` exported and covered by a
  small unit test in the existing test layout.
- `bun run typecheck` passes; no change to existing call sites required (third arg
  optional). Existing `defineSchema` inference unaffected.
