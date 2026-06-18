// Example app — schema, handlers, and ACL. The entire user-facing surface.
// In a finished mrak this would be deployed as a bundle (cf. the prior runtime's /deploy);
// for the v0 skeleton the DO imports it statically.

import { Entity, defineSchema } from "../src/sdk/schema";
import { createApp } from "../src/sdk/app";
import { $identity, allow, deny, policy, resolve, role } from "../src/sdk/acl";

const schema = defineSchema({
  notes: Entity((t) => ({
    id: t.id(),
    title: t.text(),
    body: t.text(),
    ownerId: t.text(),
    createdAt: t.int(),
  })),
});

// Handlers bound to this schema — ctx.db is fully typed against it.
const { query, mutation } = createApp(schema);

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
      ownerId: (ctx.identity?.userId as string | undefined) ?? null,
      createdAt: Date.now(),
    }),
  ),

  updateNote: mutation((ctx, input: { id: number; title?: string; body?: string }) => {
    const { id, ...patch } = input;
    return ctx.db.update("notes", id, patch) ?? null;
  }),

  deleteNote: mutation((ctx, input: { id: number }) => ctx.db.delete("notes", input.id)),
};

// ACL — deny-by-default; roles only grant.
//  admin   : full access to notes.
//  author  : reads/updates/deletes only their own notes; may create.
//  reader  : reads every note, but not the body field.
const acl = [
  role("admin", [
    policy("admin:read", "notes", "read", allow()),
    policy("admin:create", "notes", "create", allow()),
    policy("admin:update", "notes", "update", allow()),
    policy("admin:delete", "notes", "delete", allow()),
  ]),
  role("author", [
    policy("author:read", "notes", "read", { where: { ownerId: $identity("userId") } }),
    policy("author:create", "notes", "create", allow()),
    policy("author:update", "notes", "update", { where: { ownerId: $identity("userId") } }),
    policy("author:delete", "notes", "delete", { where: { ownerId: $identity("userId") } }),
  ]),
  role("reader", [
    policy("reader:read", "notes", "read", { fields: ["id", "title", "ownerId", "createdAt"] }),
  ]),
  // member: read access is computed per request from DB state — you may read
  // everything only once you've authored at least one note; otherwise nothing.
  role("member", [
    policy("member:create", "notes", "create", allow()),
    policy(
      "member:read",
      "notes",
      "read",
      resolve(({ identity, db }) => {
        if (!identity?.userId) return deny();
        const owned = db.find({ from: "notes", where: { ownerId: identity.userId }, limit: 1 });
        return owned.length > 0 ? allow() : deny();
      }),
    ),
  ]),
];

export const app = { schema, handlers, acl };
