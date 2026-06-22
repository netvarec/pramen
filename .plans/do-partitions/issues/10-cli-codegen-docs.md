# Issue 10: CLI / codegen + docs

**Priority:** medium
**Files:** `scripts/cli.ts`, `CLAUDE.md`, `README.md` (if it documents schema), codegen output

Make the tooling and docs partition-aware so the feature is discoverable and the CLI
doesn't misreport a partitioned app.

## Implementation

- **CLI `schema status`** (and any command that calls `/admin/schema` or reads the
  schema): iterate partitions (`partitionsOf`, Issue 02) and report each
  partition's tables/hash, addressing each partition-DO. A single-partition app reads
  identically to today.
- **Codegen** (typed client surface, if it emits per-entity/per-handler artifacts):
  ensure partition metadata is either irrelevant to output or carried through; run
  `validateSchema` (Issue 03) before codegen so a cross-partition schema fails fast
  with the same error as boot.
- **`CLAUDE.md`**: add a short "Partitions" note under architecture — `partition` on
  `Entity`, default = one DO per tenant, cross-partition relations/`with`/transactions
  are rejected, admin/CLI are per-partition. Mention the default-partition bare-key
  backward-compat invariant so future changes don't break it.
- **`README.md`**: if it documents schema/conventions, add the `partition` option.

## Acceptance criteria

- `pramen schema status` (or equivalent) reports all partitions of a multi-partition
  app and is unchanged for single-partition apps.
- `CLAUDE.md` documents partitions including the default-bare-key invariant.
- Codegen runs `validateSchema` and fails clearly on a cross-partition schema.
- `bun run typecheck` + tests pass.
