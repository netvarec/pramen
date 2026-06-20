---
title: Migrations
order: 5
summary: Automatic additive and destructive schema reconciliation on every DO boot.
---

The schema is reconciled with the live store on **every DO boot**, inside a storage
transaction. There is no separate migration step — you edit the schema and redeploy.
A schema hash in `_mrak_meta` skips the work entirely when nothing changed.

## Two passes

**Additive** (no data loss):

- a new table → `CREATE TABLE`
- a new column → `ALTER TABLE ADD COLUMN` (nullable; SQLite can't add `NOT NULL` to
  a populated table)

**Destructive** (auto-applied, *can* lose data — by design, since mrak is WIP with
no backward-compat constraints):

- a column the schema no longer declares is **dropped**
- a column whose type changed is **rebuilt** (with a `CAST`)
- a table absent from the schema is **dropped**

Drops and type changes use the standard SQLite **table-rebuild** (create a new
table, copy the data, drop the old, rename) — preserving rows and ids.

## Renames

A rename can't be inferred from a diff: a removed column plus an added column is
ambiguous. Declare it explicitly with `renamedFrom`, and the migrator copies the old
column's data during the rebuild:

```ts
import { Entity, renamedFrom } from "mrak/sdk/schema";

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
bun run mrak schema snapshot   # baseline in .mrak/schema.json
bun run mrak schema diff       # additive vs destructive (all auto-applied on boot)
bun run mrak schema status --tenant acme   # is a deployed tenant caught up?
```
