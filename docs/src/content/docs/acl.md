---
title: Access Control (ACL)
order: 3
summary: Deny-by-default roles and policies, row-level scopes, cell-level field permissions, write rules, and per-handler call authorization.
---

Access is **deny-by-default**; roles only ever grant. An `Identity` (from the
verified token) carries one or more roles; grants **OR-merge** across them. Row-level
`where` scopes are **AND-merged** into queries.

```ts
import { role, policy, allow, $identity } from "pramen/sdk/acl";

role("author", [
  policy("author:read",   "notes", "read",   { where: { ownerId: $identity("userId") } }),
  policy("author:create", "notes", "create", allow()),
  policy("author:update", "notes", "update", { where: { ownerId: $identity("userId") } }),
]);
```

ACL `where` rules accept the same operators and `AND`/`OR` as queries, and
`$identity` markers can appear anywhere, including inside `in`. If a marker can't
be resolved (a missing claim), the rule safely matches nothing. A marker only ever
resolves to a non-null scalar (or, inside `in`/`notIn`, a list of them): a `null` or an
object from the token or the request input matches nothing too, so `$input("key")` fed
`{ "key": null }` never becomes `IS NULL` and never reads the rows that hold no key.

```ts
// reads notes owned by anyone on the caller's team; no `team` claim -> sees none
policy("manager:read", "notes", "read", { where: { ownerId: { in: $identity("team") } } });
```

## Field permissions

A policy's `fields` restricts which columns are visible on read (projection) and
settable on write:

```ts
policy("reader:read", "notes", "read", { fields: ["id", "title", "ownerId", "createdAt"] });
```

A policy's fields stay **bound to its own rows** when grants merge. An identity holding
both `author` (own notes, every column) and `reader` (every note, no `body`) reads every
note, sees `body` on its own notes only, and can't filter, order or aggregate by `body`,
because it isn't readable on every row in scope. Rows OR-merge; a field is readable on a
row only if one single policy admits that row AND grants that field. The same holds for
writes: a policy's writable fields apply only to the rows its `where` admits.

A caller's `where` may only name columns it can read: a field outside its grant is a
403, a `hidden()` column is a 403 under every scope (`allow()` and SYSTEM included, like
`orderBy`/`select`), and an undeclared key is a 400.

## Cell-level (per-row) field ACL

Field visibility can depend on the **row's data**, not just the (entity, action).
Use the declarative `conditionalFields` (a row predicate, statically analyzable) or
the `fieldsFn` escape hatch for arbitrary logic. Conditional grants are **additive**
and they only ever add fields to the base.

```ts
// teammate reads every note, but sees `body` only on the notes they own
policy("teammate:read", "notes", "read", {
  fields: ["id", "title", "ownerId", "createdAt"],
  conditionalFields: [{ fields: ["body"], when: { ownerId: $identity("userId") } }],
  // or, equivalently, the function form:
  // fieldsFn: (identity, row) => (row.ownerId === identity?.userId ? ["body"] : []),
});
```

In a single list response, the teammate's own notes include `body` while others'
notes omit it.

The same rules enforce **writes** per row: insert evaluates the candidate values,
update the post-merge row. So a teammate may edit `body` on their own note but not
on another's, even though both are writable for `title`. An update authorized this way
re-asserts, in the UPDATE itself, the stored values its decision read, so on D1 (where
the pre-image read and the write are separate statements) a concurrent change to those
columns makes the update re-evaluate against the fresh row rather than land on a row
the grant no longer covers. Contention that persists across retries is a 409.

> A conditionally-visible column can't be aggregated or used in `orderBy`, since that
> would leak its value (or relative ordering) across rows. Such requests are denied.

## Write rules: `set` and `validate`

A write policy may force server-controlled columns with `set` (overriding client
input, so values like the owner can't be forged) and `validate` the final values:

```ts
policy("author:create", "notes", "create", {
  set: { ownerId: (i) => i?.userId },                       // forced; bypasses field restriction
  validate: ({ values }) => { if (!values.title) throw new Error("title required"); },
});
```

`set` is applied before the field check, so a conditional `when` that references a
forced column (e.g. `ownerId`) sees the server value.

A write policy's `where` binds the row being written. On **create** it must hold on the
candidate row (after `set`; an omitted column counts at its literal default), else the
insert is a 403, so a where-only create policy is a real constraint. On **update** the
`where` gates the row as stored before the write. To also constrain what the row
becomes, add an opt-in `check`, evaluated on the post-image before the UPDATE runs:

```ts
policy("author:update", "notes", "update", {
  where: { ownerId: $identity("userId") },  // may edit own notes…
  check: { ownerId: $identity("userId") },  // …and they must stay own notes
});
```

`check` is opt-in because moving a row out of the update scope is sometimes the point: a
soft delete that sets `deletedAt` under a `deletedAt IS NULL` scope. When grants merge,
a policy whose `check` fails contributes nothing to that write, and a write no policy
still covers is a 403. `check` is accepted on create (AND-ed with `where`) and update;
`compileAcl` rejects it on read and delete.

## Relations & nested ACL

Each eager-loaded relation is independently ACL-checked. A relation loads under the
related entity's own read scope, or via a parent policy's `relations` grant with
`directAccess` (traversal-only access to an otherwise unreadable entity, optionally
field-restricted):

```ts
policy("author:read", "notes", "read", {
  where: { ownerId: $identity("userId") },
  relations: { owner: { directAccess: true, fields: ["id", "name"] } }, // owner, but not email
});
```

A `directAccess` grant reaches only targets linked from parent rows that ITS policy's
`where` admits: if another role lets the same caller read every note, the author still
gets no `owner` on notes it doesn't own.

Traversal never widens a direct read, and a join is a read of its join column:

- `with` attaches a belongsTo/oneHasOne target only where the caller can read the FK on
  that parent row, and a hasMany/oneHasOneInverse target only where it can read the FK on
  that target row. Otherwise the relation is `null`/`[]`.
- A relation key in a `where` filters on the join column, so the FK must be readable
  (at every hop), else it is a 403, as filtering on the FK directly would be.
- A `hidden()` FK never joins, not even under SYSTEM.
- A manyToMany goes through its junction's own read scope: a link row the caller can't
  read directly is invisible to both `with` and `where`. Grant the junction to whoever
  traverses it.

## Dynamic resolvers

A policy rule can be computed per request from DB state via `resolve(...)`. It runs
once per request (warmup) through a SYSTEM-mode DB (ACL bypassed) so it can consult
data without recursing into itself.

```ts
policy("member:read", "notes", "read", resolve(({ identity, db }) => {
  if (!identity?.userId) return deny();
  const owned = db.find({ from: "notes", where: { ownerId: identity.userId }, limit: 1 });
  return owned.length > 0 ? allow() : deny();
}));
```

## Authorizing handlers

The policies above gate **`ctx.db`**: they decide which rows/fields a role can
read/write. They do **not** gate a handler that reaches `ctx.kv` / `ctx.env` /
`ctx.mail` / `ctx.tasks` / `ctx.queue` directly: those bypass the row-ACL, so an
un-gated such handler is callable by **anyone** (including anonymous) on an open tenant.

Gate the *call* with the `auth` option, enforced **before** the handler runs (and
before input parsing); it throws `403` on failure:

```ts
// Only an admin can call this, even though it never touches ctx.db.
adminStats: query(async (ctx) => ctx.kv.get("stats", "json"), { auth: ["admin"] }),

// Any authenticated caller:
whoami: query((ctx) => ctx.identity, { auth: "authenticated" }),

// Custom predicate:
beta: query(run, { auth: (id) => id?.flags?.beta === true }),
```

`auth` is `"authenticated"` (any non-anonymous identity), a **role list** (the caller
must hold one), or a `(identity) => boolean` predicate. Absent ⇒ open (a `ctx.db`
handler is still ACL-gated). Rule of thumb: **if a handler uses `ctx.kv`/`ctx.env`/
`ctx.mail`/`ctx.tasks`/`ctx.queue` for anything privileged, give it an `auth`.**
