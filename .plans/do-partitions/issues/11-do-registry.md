# Issue 11: DO registry — track & enumerate all (tenant, partition) DOs

**Priority:** high
**Files:** `packages/server/src/durable-object.ts`, `packages/server/src/worker.ts`, (new) `packages/server/src/runtime/registry.ts`

**Why this exists:** a `DurableObjectNamespace` has **no list/enumerate API** — only
`idFromName` / `idFromString` / `newUniqueId` / `get`. The platform cannot tell you
which DOs exist. The only way to "work with all DOs" (migrate, recover, schema, browse)
is a registry we maintain ourselves. pramen already does this for tenants
(`ensureRegistered` → `KV.put(`tenant:<name>`)`, listed by `/tenants`). Partitions
multiply the DO set, so the registry becomes the source of truth for
`(tenant, partition)` pairs.

This issue owns the registry key scheme and the enumeration helper that issues 06
(write) and 07 (read) build on. Land it before/with 06.

## Design decision to honor

- **Tenants are dynamic** (discovered at runtime) — must be recorded.
- **Partitions are static** (derivable from `partitionsOf(schema)`), BUT a partition
  renamed/removed from the schema leaves an orphan DO with data that `partitionsOf` no
  longer lists. So the registry records **actually-instantiated** `(tenant, partition)`
  pairs — the durable record of what exists, independent of the current schema.
  `partitionsOf(schema)` = *intended*; the registry = *real*.

## Implementation

- **Key scheme** (`registry.ts` — small helpers so worker + DO agree on format):
  - default partition keeps the **bare** `tenant:<t>` key (backward-compat — existing
    registry entries and DO keys are unchanged).
  - non-default partitions use `tenant:<t>:<p>`.
  - `registryKey(tenant, partition)`, and `parseRegistryKey(key) → { tenant, partition }`
    (a bare `tenant:<t>` parses to partition `"default"`). Note tenants may contain `:`
    only if you allow it — define and enforce that tenant/partition names exclude `:`
    (validate at the boundary; reject otherwise) so parsing is unambiguous.
- **Write** (`durable-object.ts` `ensureRegistered`): record the per-(tenant,partition)
  key the first time this specific DO is touched (it already knows its tenant; it learns
  its partition in Issue 06). One KV write per (tenant,partition) lifetime, guarded by
  the persisted `_pramen_meta` `registered` flag as today.
- **Enumerate** (`registry.ts` + `worker.ts`): `listDOs(env) → { tenant, partition }[]`
  via `KV.list({ prefix: "tenant:" })` + `parseRegistryKey`. Handle KV list pagination
  (`cursor`/`list_complete`) — the current `/tenants` does a single `list()` and would
  silently truncate past 1000 keys; fix it here since partitions make truncation far
  more likely.
- Provide `doStubsForTenant(env, tenant, schema)` (intended partitions) and a
  registry-driven variant (actual partitions) so admin ops can choose "all intended" vs
  "all that exist".

## Acceptance criteria

- Registry records `(tenant, partition)`; default partition stays the bare `tenant:<t>`
  key (existing single-partition data/entries unchanged).
- `listDOs(env)` returns every registered pair and paginates correctly past 1000 keys.
- `parseRegistryKey` round-trips with `registryKey`; tenant/partition names containing
  `:` are rejected at the boundary with a clear error.
- A test asserts: touch tenant `t` default + partition `audit` ⇒ `listDOs` returns both
  `{t,default}` and `{t,audit}`.
- `bun run typecheck` + tests pass.
