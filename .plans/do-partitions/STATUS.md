# Status

Feature: optionally split a tenant's Durable Object by **entity partition**.
See `issues/01-design-spec.md` for the spec and the decisions every other issue
depends on. Key invariant threaded through the plan: **the default partition keeps the
bare `idFromName(tenant)` routing key** (backward-compat); only non-default partitions
use `idFromName(`${tenant}:${partition}`)`.

## Pending

- [ ] 11 — DO registry: track & enumerate all (tenant, partition) DOs
- [ ] 03 — Schema validation: reject cross-partition relations
- [ ] 04 — Partition-aware migrate (DDL scoped to a partition)
- [ ] 05 — Handler partition declaration + Worker routing key
- [ ] 06 — DO partition awareness + runtime table-access guard
- [ ] 07 — Admin surface per-partition
- [ ] 09 — Example partitioned entity + e2e tests
- [ ] 10 — CLI / codegen + docs
- [ ] 08 — Type-level cross-partition rejection (relations / `with`) [low priority, optional]

## In Progress

## Completed

- [x] 01 — DESIGN.md: Partitions spec & decisions
- [x] 02 — Schema: `partition` on Entity + `partitionOf` helper

## Discoveries
