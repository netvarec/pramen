---
title: Queries & Aggregates
order: 4
summary: find, cursor pagination, count, and type-inferred aggregates — all ACL-scoped.
---

All reads go through `ctx.db`. Values are always parameterized; column names are
validated against injection. ACL row-scope and field projection are applied
automatically.

## find

`where` supports equality shorthand, per-column operators, and nestable `AND`/`OR`;
plus multi-column `orderBy` and `limit`/`offset`.

```ts
ctx.db.find({
  from: "notes",
  where: {
    ownerId: "alice",                       // eq shorthand
    createdAt: { gte: cutoff },             // gt / gte / lt / lte / ne
    title: { like: "report-%" },            // like (string columns only)
    id: { in: [1, 2, 3] },                  // in / notIn
    OR: [{ pinned: true }, { archivedAt: { isNull: true } }],
  },
  orderBy: [{ column: "createdAt", dir: "desc" }, { column: "id" }],
  limit: 20,
  offset: 40,
  with: { owner: true },                    // eager-load a relation (ACL-checked)
});
```

## Cursor pagination

For large or changing datasets prefer **cursor (keyset) pagination** — stable under
concurrent inserts/deletes. `db.page()` returns `{ items, cursor, hasMore }`; pass
the previous `cursor` back as `after`. The primary key is auto-appended to `orderBy`
as a tiebreaker.

```ts
let after: string | undefined;
do {
  const { items, cursor, hasMore } = ctx.db.page({
    from: "notes",
    orderBy: { column: "createdAt", dir: "desc" },
    limit: 50,
    after,
  });
  // ... process items ...
  after = cursor ?? undefined;
  if (!hasMore) break;
} while (after);
```

## count & aggregates

`db.count()` and `db.aggregate()` (count/sum/avg/min/max, optional `groupBy`) are
ACL-scoped — the read `where` applies, and aggregating a column you can't read is
denied (counting rows you *can* see is always allowed).

The aggregate **result row type is inferred from the spec**: group columns keep
their schema type, `count` → `number`, `min`/`max` → the column's type (nullable),
`sum`/`avg` → `number | null`.

```ts
const perOwner = ctx.db.aggregate({
  from: "notes",
  groupBy: "ownerId",
  aggregations: { count: { fn: "count" }, lastId: { fn: "max", column: "id" } },
});
// typed: { ownerId: string | null; count: number; lastId: number | null }[]
```
