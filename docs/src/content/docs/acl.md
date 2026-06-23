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
`$identity` markers can appear anywhere — including inside `in`. If a marker can't
be resolved (a missing claim), the rule safely matches nothing.

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

## Cell-level (per-row) field ACL

Field visibility can depend on the **row's data**, not just the (entity, action).
Use the declarative `conditionalFields` (a row predicate, statically analyzable) or
the `fieldsFn` escape hatch for arbitrary logic. Conditional grants are **additive**
— they only ever add fields to the base.

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
on another's, even though both are writable for `title`.

> A conditionally-visible column can't be aggregated or used in `orderBy` — that
> would leak its value (or relative ordering) across rows. Such requests are denied.

## Write rules: `set` and `validate`

A write policy may force server-controlled columns with `set` (overriding client
input — so values like the owner can't be forged) and `validate` the final values:

```ts
policy("author:create", "notes", "create", {
  set: { ownerId: (i) => i?.userId },                       // forced; bypasses field restriction
  validate: ({ values }) => { if (!values.title) throw new Error("title required"); },
});
```

`set` is applied before the field check, so a conditional `when` that references a
forced column (e.g. `ownerId`) sees the server value.

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

The policies above gate **`ctx.db`** — they decide which rows/fields a role can
read/write. They do **not** gate a handler that reaches `ctx.kv` / `ctx.env` /
`ctx.mail` / `ctx.tasks` directly: those bypass the row-ACL, so an un-gated such
handler is callable by **anyone** (including anonymous) on an open tenant.

Gate the *call* with the `auth` option — enforced **before** the handler runs (and
before input parsing); it throws `403` on failure:

```ts
// Only an admin can call this — even though it never touches ctx.db.
adminStats: query(async (ctx) => ctx.kv.get("stats", "json"), { auth: ["admin"] }),

// Any authenticated caller:
whoami: query((ctx) => ctx.identity, { auth: "authenticated" }),

// Custom predicate:
beta: query(run, { auth: (id) => id?.flags?.beta === true }),
```

`auth` is `"authenticated"` (any non-anonymous identity), a **role list** (the caller
must hold one), or a `(identity) => boolean` predicate. Absent ⇒ open (a `ctx.db`
handler is still ACL-gated). Rule of thumb: **if a handler uses `ctx.kv`/`ctx.env`/
`ctx.mail` for anything privileged, give it an `auth`.**
