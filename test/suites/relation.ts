// Relations + nested ACL: belongsTo/hasMany eager loading; traversal applies the
// related entity's read scope; directAccess grants traversal-only access with
// field projection; a role with neither flat read nor directAccess is denied.

import { assert, http, token } from "../lib";

export async function runRelation(base: string): Promise<void> {
  const TENANT = "relation-demo";
  const post = http(base, TENANT);
  const admin = await token("admin", ["admin"]);
  const alice = await token("alice", ["author"]);
  const reader = await token("reader-user", ["reader"]);

  const u = await post("createUser", { id: "alice", name: "Alice", email: "alice@secret.example" }, admin);
  assert(u.body.ok, "admin created the alice user row");
  await post("createNote", { title: "n1", body: "b1" }, alice);
  await post("createNote", { title: "n2", body: "b2" }, alice);

  const aliceView = await post("listNotesWithOwner", {}, alice);
  assert(aliceView.status === 200 && aliceView.body.result.length >= 2, "author lists own notes with owner");
  const owner = aliceView.body.result[0].owner;
  assert(owner?.id === "alice" && owner?.name === "Alice", "owner is eager-loaded (belongsTo)");
  assert(!("email" in owner), "directAccess projection hides owner.email");

  const aliceUsers = await post("listUsers", {}, alice);
  assert(aliceUsers.status === 403, "author cannot flat-read users");

  const adminView = await post("listNotesWithOwner", {}, admin);
  assert(adminView.body.result[0].owner?.email === "alice@secret.example", "admin traversal sees owner.email");

  const withNotes = await post("getUserWithNotes", { id: "alice" }, admin);
  assert(Array.isArray(withNotes.body.result?.notes) && withNotes.body.result.notes.length >= 2, "hasMany eager-loads notes");
  assert(withNotes.body.result.notes.every((n: any) => n.ownerId === "alice"), "hasMany only includes the user's notes");

  const readerFlat = await post("listNotes", {}, reader);
  assert(readerFlat.status === 200, "reader can flat-read notes");
  const readerTraverse = await post("listNotesWithOwner", {}, reader);
  assert(readerTraverse.status === 403, "reader is denied owner traversal (no flat read, no directAccess)");
}
