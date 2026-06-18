// Example app — the entire user-facing surface: a schema plus handlers.
// In a finished mrak this would be deployed as a bundle (cf. the prior runtime's /deploy);
// for the v0 skeleton the DO imports it statically.

import { Entity, defineSchema } from "../src/sdk/schema";
import { mutation, query } from "../src/sdk/handlers";

const schema = defineSchema({
  notes: Entity((t) => ({
    id: t.id(),
    title: t.text(),
    body: t.text(),
    createdAt: t.int(),
  })),
});

const handlers = {
  listNotes: query((ctx) =>
    ctx.db.find({ from: "notes", orderBy: { column: "id", dir: "desc" } }),
  ),

  getNote: query((ctx, input: { id: number }) => {
    const rows = ctx.db.find({ from: "notes", where: { id: input.id }, limit: 1 });
    return rows[0] ?? null;
  }),

  createNote: mutation((ctx, input: { title: string; body: string }) =>
    ctx.db.insert("notes", {
      title: input.title,
      body: input.body,
      createdAt: Date.now(),
    }),
  ),

  updateNote: mutation((ctx, input: { id: number; title?: string; body?: string }) => {
    const { id, ...patch } = input;
    return ctx.db.update("notes", id, patch);
  }),
};

export const app = { schema, handlers };
