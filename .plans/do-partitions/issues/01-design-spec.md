# Issue 01: DESIGN.md — Partitions spec & decisions

**Priority:** high
**Files:** `DESIGN.md`

Write a "Partitions" section in `DESIGN.md` that pins the design decisions for the
feature **before any code lands**. Everything downstream references this. No runtime
code in this issue.

## Context

Today routing is one DO per tenant: `env.PRAMEN.get(env.PRAMEN.idFromName(tenant))`
(`worker.ts:267`). Every entity for a tenant shares that DO's in-process SQLite, which
is what makes atomic cross-entity transactions, in-SQL relation traversal
(`acl.ts relationPredicate` compiles `{ owner: {...} }` to a subquery), `with`
hydration (`db.ts:453/462`), and reactivity (`durable-object.ts broadcast`) free.

A **partition** lets a schema author move an entity (or group) into its own DO — to
relieve a hot/append-only entity (events, audit log, telemetry) that otherwise
serializes the whole tenant, or to scale past the per-DO SQLite size limit — at the
cost of those cross-entity guarantees for the partitioned entity.

## Decisions to record (acceptance criteria — each must be stated explicitly)

1. **`partition` is a schema concept.** `Entity(build, relations, { partition: "name" })`,
   default partition name = `"default"`. An entity lives in exactly one partition.
2. **Routing key.** A partition-DO is addressed by `idFromName(`${tenant}:${partition}`)`
   — **EXCEPT the default partition, which keeps the bare `idFromName(tenant)` key** so
   existing tenant data is not orphaned (hard backward-compat requirement).
3. **Boundary rules — cross-partition is forbidden, enforced not degraded:**
   - A relation (`belongsTo`/`hasMany`) whose target is in a different partition is a
     **schema-validation error** (relations are static → caught at boot/codegen).
   - `with` and relation-traversal `where` therefore cannot cross partitions (no such
     relation can exist).
   - A handler may only touch tables in **one** partition; touching another partition's
     table is a **runtime error** (no silent cross-DO RPC, no distributed tx).
4. **Handler→partition association for routing.** The Worker must pick the partition-DO
   *before* dispatch, without running the handler. Decision: handlers declare their
   partition via opts — `query(fn, { partition })` / `mutation(fn, { partition })`,
   default `"default"`. Record the rationale (static, server-side routing) and the
   invariant that a handler's declared partition must match the partition of every
   table it touches (enforced at runtime by the table-access guard).
5. **DDL placement.** Each partition-DO runs `migrate` for **only its partition's
   tables** (others don't exist in that DO).
6. **DO enumeration via a self-maintained registry.** A `DurableObjectNamespace` has
   no list API (only `idFromName`/`idFromString`/`newUniqueId`/`get`) — the platform
   can't tell you which DOs exist. So the registry KV is the source of truth: each DO
   self-registers on first touch (today: `tenant:<t>`; Issue 11: `(tenant, partition)`).
   Record the tenant-is-dynamic / partition-is-static-from-schema distinction, and that
   the registry tracks *actually-instantiated* pairs so a partition renamed/removed from
   the schema (orphan DO with data) is still discoverable. See Issue 11.
7. **Admin surface becomes per-partition.** `/tenants` enumerates `tenant:partition`,
   and `/admin/schema`, `/admin/recover`, `/admin/data` take an optional `partition`
   (absent ⇒ default, preserving today's calls).
8. **Out of scope (state explicitly):** cross-partition transactions/sagas, cross-DO
   live queries, automatic re-partitioning/data movement between partitions.

Update the comparison table / sharding bullet (`DESIGN.md:33-34`) to note partitions
generalize "one DO per tenant" — an entity alone in a partition is the degenerate case.
