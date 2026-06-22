# Issue 07: Admin surface per-partition

**Priority:** medium
**Files:** `packages/server/src/worker.ts`, `packages/server/src/durable-object.ts`

The admin endpoints currently address a tenant DO by `idFromName(tenant)`. Make them
partition-aware, defaulting to the default partition so existing calls keep working.

## Implementation (`worker.ts`)

Use Issue 05's `partitionStubFor(env, tenant, partition)` (default ⇒ bare tenant key).

- **`GET /tenants`** — replace the inline single-page `KV.list` with Issue 11's
  `listDOs(env)` (paginated). Return entries as `{ tenant, partition }` (partition
  `"default"` for bare keys) so callers see the full DO set. Keep it admin-gated.
  Consider keeping a back-compat shape (distinct tenant names) if any client depends on
  the old flat string array — note the change either way.
- **`POST /admin/recover`** — accept optional `partition` in the body (default
  `"default"`); route via `partitionStubFor`; forward `x-pramen-partition`.
- **`GET /admin/schema`** — accept `&partition=` (default `"default"`); route + forward.
- **`POST /admin/data`** — accept optional `partition` in the body (default `"default"`);
  route + forward. The DO's `handleAdminData` already checks `table in app.schema`; add
  a check that the table belongs to **this DO's partition** (reuse Issue 06's guard) so
  an admin can't address an audit table on the default DO.
- Update the help/usage text (`worker.ts:224-231`) to mention the optional `partition`.

## Acceptance criteria

- All four admin calls work unchanged when `partition` is omitted (route to the bare
  tenant key).
- With `partition` set, each routes to `idFromName(`${tenant}:${partition}`)`.
- `/tenants` surfaces partition info for each registered DO.
- `/admin/data` against a table not in the addressed partition returns a clear error.
- `bun run typecheck` + tests pass.
