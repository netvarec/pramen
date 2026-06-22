# Status

Feature: optionally split a tenant's Durable Object by **entity partition**.
See `issues/01-design-spec.md` for the spec and the decisions every other issue
depends on. Key invariant threaded through the plan: **the default partition keeps the
bare `idFromName(tenant)` routing key** (backward-compat); only non-default partitions
use `idFromName(`${tenant}:${partition}`)`.

## Pending

- [ ] 07 — Admin surface per-partition
- [ ] 09 — Example partitioned entity + e2e tests
- [ ] 10 — CLI / codegen + docs
- [ ] 08 — Type-level cross-partition rejection (relations / `with`) [low priority, optional]

## In Progress

## Completed

- [x] 01 — DESIGN.md: Partitions spec & decisions
- [x] 02 — Schema: `partition` on Entity + `partitionOf` helper
- [x] 11 — DO registry: track & enumerate all (tenant, partition) DOs
- [x] 03 — Schema validation: reject cross-partition relations
- [x] 04 — Partition-aware migrate (DDL scoped to a partition)
- [x] 05 — Handler partition declaration + Worker routing key
- [x] 06 — DO partition awareness + runtime table-access guard

## Discoveries

- Two distinct keyspaces, do not conflate: `registryKey(t,p)` → `tenant:<t>[:<p>]` (KV
  registry) vs `partitionDoName(t,p)` → `<t>[:<p>]` (DO `idFromName`). Issue 07's admin
  routing must use `partitionStubFor`/`partitionDoName` (in worker.ts), NOT `registryKey`,
  or it addresses the wrong (empty) DO. Both live in `runtime/registry.ts`.
