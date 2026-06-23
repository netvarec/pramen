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
`int()`, `real()`, `bool()`, `json()` (arbitrary JSON, typed as `JsonValue`),
`fileRef()` (an R2 file), `uuid()` (a TEXT column typed as `string`). Relations:
`belongsTo(target, column)` and `hasMany(target, column)`.

**Modifiers** wrap a builder and compose: `notNull()`, `unique()`, `indexed()`,
`defaultTo(value)`, `primaryKey()`, `generated()`, and `hidden()` — e.g.
`code: unique(t.text())`, `status: defaultTo(t.text(), "pending")`.

### Hidden columns

`hidden()` marks a column **never readable through the ORM**: it's stripped from every
read projection — `find`/`get`, mutation echoes, relation loads, and even the
SYSTEM-scope admin data API — regardless of ACL, including a full `allow()` grant. It
stays writable on insert/update and visible to the raw `ctx.db.exec` escape hatch, so
credential code can still read it. Use it for secrets like a password hash:

```ts
accounts: Entity((t) => ({
  username: t.textId(),
  passwordHash: hidden(t.text()), // writable + readable via exec; never via find/get
  email: t.text(),
}));

await ctx.db.find({ from: "accounts" });
// -> [{ username: "alice", email: "a@x.com" }]   // no passwordHash, ever
```

### Defaults

`defaultTo(field, value)` gives a column a `DEFAULT` and makes it optional on insert.
Pass a **literal** (rendered as a quoted SQL literal) or a **SQL expression** via the
`expr` helper, rendered raw:

```ts
posts: Entity((t) => ({
  id: t.id(),
  status: defaultTo(t.text(), "draft"),       // literal  -> DEFAULT 'draft'
  createdAt: defaultTo(t.text(), expr.now()),  // expr     -> DEFAULT (datetime('now'))
}));

await ctx.db.insert("posts", { });
// -> { id: 1, status: "draft", createdAt: "2026-06-22 21:05:00" }  (DB-filled)
```

`expr.now()` is the current UTC timestamp as TEXT (the `CURRENT_TIMESTAMP` shape);
`expr.raw(sql)` is an escape hatch for any other SQLite default expression. Expr-default
columns are filled by the database, so they're optional on insert.

### UUIDs

`t.uuid()` is a string column. Wrap it with `generated()` to auto-mint a v4 on
insert (via `crypto.randomUUID()`) when you omit it, and `primaryKey()` to use it as
the primary key. A generated column is optional on insert; a value you supply is
validated and rejected (400) if it isn't a well-formed UUID.

```ts
events: Entity((t) => ({
  id: primaryKey(generated(t.uuid())), // auto-minted on insert, optional in the type
  kind: t.text(),
  traceId: generated(t.uuid()),        // a generated non-PK uuid
}));

await ctx.db.insert("events", { kind: "signup" });
// -> { id: "9f1c2e3a-…", kind: "signup", traceId: "1b7d…" }   (uuids minted server-side)
```

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
