# Issue 08: Type-level cross-partition rejection (relations / `with`)

**Priority:** low
**Files:** `packages/server/src/sdk/infer.ts`

Optional hardening: make the cross-partition boundary visible to the type system, so
`with` and relation-traversal `where` on a cross-partition relation don't even
typecheck — turning Issue 03's runtime/boot error into a compile-time one for typed
callers. Issue 03 remains the source of truth for enforcement; this is ergonomics.

## Implementation

- `RelationsResult` (`infer.ts:126`) and the relation half of `WhereClause`
  (`infer.ts:75-87`) currently expose every relation key. Add a type-level filter that
  drops relation keys whose target entity's `partition` differs from the source
  entity's `partition`.
- This requires the `partition` literal to be inferred onto `EntityDef` (Issue 02 adds
  it as `readonly partition: string` — ensure it's preserved as a literal via `as const`
  / the `Entity` signature so the conditional type can compare two string literals).
- If preserving the partition literal through inference proves disproportionately
  costly (it may, given the depth-bounded recursion already in `WhereClause`), STOP and
  leave enforcement to Issue 03 — document in `infer.ts` that the partition boundary is
  enforced at runtime/boot only, and close this issue as "runtime-only by decision".

## Acceptance criteria

- Either: `ctx.db.find({ from: "notes", with: { <crossPartitionRel>: true } })` is a
  type error, with a matching `@ts-expect-error` case added to
  `example/inference-check.ts`; same-partition relations still typecheck.
- Or: a documented decision in `infer.ts` that this stays runtime-only, with no type
  regression — `example/inference-check.ts` unchanged and green.
- `bun run typecheck` passes either way.
