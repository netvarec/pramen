// Compile-time proof that schema inference works. This file is type-checked by
// `bun run typecheck`; every @ts-expect-error must trigger a real error, and the
// positive cases must compile. It is not imported at runtime.

import { Entity, defineSchema } from "../src/sdk/schema";
import { createApp } from "../src/sdk/app";

const schema = defineSchema({
  users: Entity(
    (t) => ({ id: t.textId(), name: t.text() }),
    (r) => ({ notes: r.hasMany("notes", "ownerId") }),
  ),
  notes: Entity(
    (t) => ({
      id: t.id(),
      title: t.text(),
      views: t.int(),
      pinned: t.bool(),
      ownerId: t.text(),
    }),
    (r) => ({ owner: r.belongsTo("users", "ownerId") }),
  ),
});

const { query, mutation } = createApp(schema);

export const readChecks = query((ctx) => {
  const rows = ctx.db.find({
    from: "notes",
    where: { title: "hi", pinned: true },
    orderBy: { column: "views", dir: "desc" },
    limit: 5,
  });

  // Results are typed: id non-null (PK), title nullable (no NOT NULL).
  const id: number = rows[0]!.id;
  const title: string | null = rows[0]!.title;
  const pinned: boolean | null = rows[0]!.pinned;

  // @ts-expect-error unknown table
  ctx.db.find({ from: "comments" });
  // @ts-expect-error unknown column in where
  ctx.db.find({ from: "notes", where: { author: "x" } });
  // @ts-expect-error wrong value type in where (title is text -> string)
  ctx.db.find({ from: "notes", where: { title: 123 } });
  // @ts-expect-error unknown orderBy column
  ctx.db.find({ from: "notes", orderBy: { column: "nope" } });

  // operators, OR/AND groups, multi-column orderBy, pagination all type-check
  ctx.db.find({
    from: "notes",
    where: { views: { gte: 1, lt: 100 }, title: { like: "a%" }, OR: [{ pinned: true }, { id: { in: [1, 2] } }] },
    orderBy: [{ column: "views", dir: "desc" }, { column: "id" }],
    limit: 10,
    offset: 20,
  });
  // @ts-expect-error like is string-only (views is a number)
  ctx.db.find({ from: "notes", where: { views: { like: "x" } } });
  // @ts-expect-error wrong operator value type
  ctx.db.find({ from: "notes", where: { views: { gt: "big" } } });

  return { id, title, pinned };
});

export const relationChecks = query((ctx) => {
  // belongsTo: owner is the users row (or null).
  const notes = ctx.db.find({ from: "notes", with: { owner: true } });
  const ownerName: string | null | undefined = notes[0]?.owner?.name;

  // hasMany: notes is an array of note rows.
  const users = ctx.db.find({ from: "users", with: { notes: true } });
  const firstTitle: string | null | undefined = users[0]?.notes?.[0]?.title;

  // @ts-expect-error unknown relation
  ctx.db.find({ from: "notes", with: { author: true } });

  return { ownerName, firstTitle };
});

export const writeChecks = mutation((ctx) => {
  // id is auto (optional); other columns optional (nullable).
  const created = ctx.db.insert("notes", { title: "x", views: 1, pinned: false });
  const newId: number = created.id;

  // @ts-expect-error wrong value type on insert (views is integer -> number)
  ctx.db.insert("notes", { views: "lots" });
  // @ts-expect-error unknown column on insert
  ctx.db.insert("notes", { nope: true });

  ctx.db.update("notes", newId, { pinned: true }); // patch typed & partial
  // @ts-expect-error wrong patch value type
  ctx.db.update("notes", newId, { pinned: "yes" });

  return newId;
});
