// Example app — schema, handlers, and ACL. The entire user-facing surface.
// In a finished mrak this would be deployed as a bundle (cf. the prior runtime's /deploy);
// for the v0 skeleton the DO imports it statically.

import { Entity, defineSchema } from "../src/sdk/schema";
import { createApp } from "../src/sdk/app";
import { $identity, allow, deny, policy, resolve, role } from "../src/sdk/acl";

const schema = defineSchema({
  users: Entity(
    (t) => ({
      id: t.textId(), // PK = the JWT subject (e.g. "alice")
      name: t.text(),
      email: t.text(), // sensitive — not exposed via relation traversal
    }),
    (r) => ({ notes: r.hasMany("notes", "ownerId") }),
  ),
  notes: Entity(
    (t) => ({
      id: t.id(),
      title: t.text(),
      body: t.text(),
      ownerId: t.text(),
      createdAt: t.int(),
    }),
    (r) => ({ owner: r.belongsTo("users", "ownerId") }),
  ),
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

  // Relations: notes with their owner; a user with their notes.
  listNotesWithOwner: query((ctx) =>
    ctx.db.find({ from: "notes", with: { owner: true }, orderBy: { column: "id", dir: "desc" } }),
  ),

  getUserWithNotes: query((ctx, input: { id: string }) => {
    const rows = ctx.db.find({ from: "users", where: { id: input.id }, with: { notes: true }, limit: 1 });
    return rows[0] ?? null;
  }),

  listUsers: query((ctx) => ctx.db.find({ from: "users" })),

  createUser: mutation((ctx, input: { id: string; name: string; email: string }) =>
    ctx.db.insert("users", input),
  ),
};

// ACL — deny-by-default; roles only grant.
//  admin   : full access to notes and users.
//  author  : own notes only; may create; may traverse note.owner (id+name, no
//            email) via directAccess, but has NO flat users read.
//  reader  : reads every note (no body); cannot traverse to owner.
const acl = [
  role("admin", [
    policy("admin:read", "notes", "read", allow()),
    policy("admin:create", "notes", "create", allow()),
    policy("admin:update", "notes", "update", allow()),
    policy("admin:delete", "notes", "delete", allow()),
    policy("admin:users:read", "users", "read", allow()),
    policy("admin:users:create", "users", "create", allow()),
  ]),
  role("author", [
    policy("author:read", "notes", "read", {
      where: { ownerId: $identity("userId") },
      relations: { owner: { directAccess: true, fields: ["id", "name"] } },
    }),
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
