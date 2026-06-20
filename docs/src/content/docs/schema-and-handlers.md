---
title: Schema & Handlers
order: 2
summary: Define entities and relations, then write fully-typed query and mutation handlers.
---

## Schema

Declare entities with `Entity(...)` and assemble them with `defineSchema(...)`.
Field builders (`t.id()`, `t.text()`, …) return `as const` literals, so the exact
shape flows into the type system.

```ts
import { Entity, defineSchema } from "pramen/sdk/schema";

const schema = defineSchema({
  users: Entity(
    (t) => ({ id: t.textId(), name: t.text(), email: t.text() }),
    (r) => ({ notes: r.hasMany("notes", "ownerId") }),
  ),
  notes: Entity(
    (t) => ({ id: t.id(), title: t.text(), body: t.text(), ownerId: t.text(), createdAt: t.int() }),
    (r) => ({ owner: r.belongsTo("users", "ownerId") }),
  ),
});
```

Field builders: `id()` (auto-increment integer PK), `textId()` (text PK), `text()`,
`int()`, `real()`, `bool()`. Relations: `belongsTo(target, column)` and
`hasMany(target, column)`.

> SQLite (DO) has no boolean type — booleans are stored as INTEGER 0/1; the runtime
> handles the coercion for you.

## Handlers

`createApp(schema)` returns `query` and `mutation` whose `ctx.db` is fully inferred
from the schema — table names, `where` columns and value types, row results, and
insert/patch shapes are all checked at compile time.

```ts
import { createApp } from "pramen/sdk/app";

const { query, mutation } = createApp(schema);

export const handlers = {
  listNotes: query((ctx) =>
    ctx.db.find({ from: "notes", orderBy: { column: "createdAt", dir: "desc" } }),
  ),

  createNote: mutation((ctx, input: { title: string; body: string }) =>
    ctx.db.insert("notes", { title: input.title, body: input.body, createdAt: Date.now() }),
  ),
};
```

- **Queries** read; **mutations** write. A mutation is automatically wrapped in
  `storage.transaction()` — it commits on return and rolls back on throw. Do **not**
  write transaction control in handler code.
- **No raw SQL in handlers** — go through `ctx.db`. (`ctx.db.exec` is an escape
  hatch and is *not* ACL-checked.)

## Input validation

A handler may declare an `input` validator that parses the raw body and throws to
reject (surfaced as a `400`):

```ts
createNote: mutation(run, {
  input: (raw) => {
    const o = raw as Record<string, unknown>;
    if (typeof o?.title !== "string") throw new Error("title must be a string");
    return { title: o.title, body: String(o.body ?? "") };
  },
});
```

## Errors

Responses are `{ ok, result }` or `{ ok: false, error, code }` with a real status:
ACL denial → `403 forbidden`; bad input / unknown handler / failed `validate` →
`400 bad_request`. Anything unexpected is logged server-side and returned as a
generic `500` — stack traces and internal messages never reach the client.
