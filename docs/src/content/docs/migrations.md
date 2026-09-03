---
title: Migrations
order: 5
summary: Additive schema reconciliation on every DO boot; destructive changes are opt-in.
---

The schema is reconciled with the live store on **every DO boot**, inside a storage
transaction. There is no separate migration step — you edit the schema and redeploy.
A schema hash in `_pramen_meta` skips the work entirely when nothing changed.

## Two passes

**Additive** (no data loss):

- a new table → `CREATE TABLE`
- a new column → `ALTER TABLE ADD COLUMN` (nullable; SQLite can't add `NOT NULL` to
  a populated table)

**Destructive** (*opt-in — off by default*; *can* lose data when enabled):

- a column the schema no longer declares is **dropped**
- a column whose type changed is **rebuilt** (with a `CAST`)
- a table absent from the schema is **dropped**

Drops and type changes use the standard SQLite **table-rebuild** (create a new
table, copy the data, drop the old, rename) — preserving rows and ids.

This pass runs **only when the deploy sets `PRAMEN_ALLOW_DESTRUCTIVE=true`** (local
dev sets it on). Otherwise each destructive change is skipped and logged, and the
schema hash is left unwritten so a later opt-in deploy retries — a schema edit can't
silently drop a column on a plain deploy. (pramen is WIP with no backward-compat
constraints, so enabling it is a deliberate data-loss trade-off.)

## Renames

A rename can't be inferred from a diff: a removed column plus an added column is
ambiguous. Declare it explicitly with `renamedFrom`, and the migrator copies the old
column's data during the rebuild:

```ts
import { Entity, renamedFrom } from "pramen/sdk/schema";

notes: Entity((t) => ({
  id: t.id(),
  title: t.text(),
  content: renamedFrom(t.text(), "body"), // column `body` -> `content`, data preserved
}));
```

Without the hint, the change is applied as drop + add and the old column's data is
lost.

## Inspecting changes

The CLI's `schema diff` compares your schema against a snapshot baseline and flags
each change as additive or **destructive**:

```bash
bun run pramen schema snapshot   # baseline in .pramen/schema.json
bun run pramen schema diff       # additive vs destructive (additive auto-applies; destructive is opt-in)
bun run pramen schema status --tenant acme   # is a deployed tenant caught up?
```

## Data migrations

A diff between two table **shapes** can only ever express structure. It cannot split
`name` into `firstName`/`lastName`, backfill the column `ADD COLUMN` just created
(always nullable — SQLite can't add `NOT NULL` to a populated table, so every new
column starts as a hole), rewrite `priceHalers` into `priceCzk`, or normalize a
`t.json()` blob whose shape changed.

So: **structure is declarative, data is imperative and recorded.** Declare an ordered
list of one-shot transformations as `app.migrations`:

```ts
import type { MigrationContext } from "@pramen/server";

const migrations = [
  {
    id: "2026-09-02-split-name",
    async up({ driver }: MigrationContext<typeof schema>) {
      await driver.exec(
        `UPDATE users
            SET firstName = substr(name, 1, instr(name, ' ') - 1),
                lastName  = substr(name, instr(name, ' ') + 1)
          WHERE name IS NOT NULL AND firstName IS NULL`,
        [],
      );
    },
  },
];

export const app = { schema, handlers, acl, migrations };
```

`up()` gets a privileged, SYSTEM-scoped context: `{ db, driver, schema, partition }` —
`db` is the ORM with the ACL bypassed and triggers suppressed, `driver` is raw SQL. A
bulk `UPDATE` is usually the right tool; walking rows through `db` is what blows the
DO's wall-clock budget.

### The ledger

Each migration runs **at most once per `(id, partition)`**, recorded in an internal
`_pramen_migrations` table next to `_pramen_meta`:

```sql
CREATE TABLE IF NOT EXISTS _pramen_migrations (
  id         TEXT NOT NULL,
  partition  TEXT NOT NULL,
  appliedAt  TEXT NOT NULL,
  PRIMARY KEY (id, partition)
);
```

Keyed by `(id, partition)` for the same reason the schema hash is
`schema_hash:<partition>`: partitions are independent Durable Objects and must not
thrash each other's state. On the DO path each partition-DO runs **its own**
partition's migrations. The D1 store is one shared database with no partition split,
so there every declared migration runs — still recorded under its own partition key.

The `id` is the ledger key: stable, unique across the whole array, **never reused**.

### Ordering, and why `bootstrap` is not this

On every boot: `migrate()` → **data migrations** → the outbox table →
`app.bootstrap`. Structure first (so a backfill's column exists), reference data last.

`app.bootstrap` looks adjacent but is deliberately the opposite thing:

| | `app.bootstrap` | `app.migrations` |
|---|---|---|
| cardinality | every boot | once, ever |
| idempotency | **required** | not required — that's the point |
| subject | code-defined reference data | existing user rows |
| failure | logged and **swallowed** | **fails closed** |

A backfill that doubles a value on the second run is precisely what bootstrap's
"MUST be safe to run repeatedly" contract forbids. And the schema hash says nothing
about backfills — a perfectly in-sync store carries no evidence one ran.

### Fail closed

A throwing migration writes **no ledger row**, does not let the boot complete, and
propagates: the tenant's request fails and the migration is retried on the next fetch.
This mirrors `migrate()`'s withhold-the-hash-on-a-skip invariant — the store is never
marked as having reached a state it did not reach. Migrations declared *after* the
failing one do not run either, since a later one may depend on an earlier one's output.

Swallowing a half-finished backfill and carrying on is the one outcome worth bricking
a boot to avoid.

### No down migrations

There are none, deliberately. Rolling back the Worker does not roll back the schema
either, and a reversibility contract would cost more than it is worth. Fix forward with
a new migration.

### Constraints

**Keep backfills bounded.** A migration runs on a tenant's first fetch inside
`blockConcurrencyWhile`, so a multi-second `UPDATE` stalls that first request and a big
enough one risks the DO's wall-clock limit. There is no chunking or resume: `up()` runs
to completion or fails.

**On D1 the work and the ledger row are not atomic.** D1 has no interactive
transactions (`transaction(fn)` is `fn()`), so a migration that throws midway leaves
partial writes behind; the ledger row it had claimed is released, so it re-runs on the
next request. Prefer SQL that tolerates that anyway (`WHERE col IS NULL`) when the D1
store is in play. On the DO the work and the ledger row commit together.

The ledger row is **claimed before** the work, not written after it. On the DO that is
just bookkeeping order inside one transaction; on D1 it is what makes "once, ever" hold
at all — there is no single writer, so two cold Worker isolates would otherwise both read
an empty ledger and both run the same backfill.

### Pruning: check before you delete

Migration is **lazy and per-DO**. A tenant nobody has touched for six months is
unmigrated until someone touches it — so deleting an `id` from the array on a hunch
silently skips it for every tenant that had not yet woken. (Same trap as `renamedFrom`,
which for the identical reason can never be safely removed either.)

```bash
bun run pramen migrations list                    # declared ids, in order
bun run pramen migrations status --tenant acme    # applied vs pending for one tenant
bun run pramen migrations status --all-tenants    # the fleet — fans out over /tenants
```

`status` marks each id `✓` applied, `•` PENDING, or `?` applied but **not declared** (a
ledger row whose migration was deleted from the codebase). An id is safe to prune only
once **every** live tenant reports it applied.

Reading the ledger is **read-only**: it deliberately does not boot the store, so asking
never applies what it is reporting on. Add `--store d1` when the deployment serves from
D1 (there is no Durable Object to ask on that store).
