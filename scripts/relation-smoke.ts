// Relation / nested ACL smoke test. Run against `wrangler dev` (default 8799):
//   bun run scripts/relation-smoke.ts [port]
//
// Demonstrates:
//  - belongsTo / hasMany eager loading via `with`
//  - nested ACL: traversal applies the related entity's read scope
//  - directAccess: author may traverse note.owner (id+name only, no email) even
//    though it has NO flat users read
//  - a role with neither flat read nor directAccess is denied traversal (403)

import { token } from "./jwt";

const port = process.argv[2] ?? "8799";
const base = `http://localhost:${port}`;
const TENANT = "relation-demo";

const TOKENS: Record<string, string> = {
  admin: await token("admin", ["admin"]),
  alice: await token("alice", ["author"]),
  reader: await token("reader-user", ["reader"]),
};

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
};

async function post(name: string, input: unknown, role?: keyof typeof TOKENS): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-mrak-tenant": TENANT };
  if (role) headers.authorization = `Bearer ${TOKENS[role]}`;
  const r = await fetch(`${base}/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(input ?? {}) });
  return { status: r.status, body: await r.json() };
}

// admin seeds a user row for alice, then alice authors notes.
const u = await post("createUser", { id: "alice", name: "Alice", email: "alice@secret.example" }, "admin");
assert(u.body.ok, "admin created the alice user row");
await post("createNote", { title: "n1", body: "b1" }, "alice");
await post("createNote", { title: "n2", body: "b2" }, "alice");

// belongsTo + directAccess: author traverses note.owner, seeing id+name but NOT email.
const aliceView = await post("listNotesWithOwner", {}, "alice");
assert(aliceView.status === 200 && aliceView.body.result.length >= 2, "author lists own notes with owner");
const owner = aliceView.body.result[0].owner;
assert(owner?.id === "alice" && owner?.name === "Alice", "owner is eager-loaded (belongsTo)");
assert(!("email" in owner), "directAccess projection hides owner.email");

// author has NO flat users read.
const aliceUsers = await post("listUsers", {}, "alice");
assert(aliceUsers.status === 403, "author cannot flat-read users");

// admin: flat users read + unrestricted traversal (email visible).
const adminView = await post("listNotesWithOwner", {}, "admin");
assert(adminView.body.result[0].owner?.email === "alice@secret.example", "admin traversal sees owner.email");

// hasMany: a user with their notes.
const withNotes = await post("getUserWithNotes", { id: "alice" }, "admin");
assert(Array.isArray(withNotes.body.result?.notes) && withNotes.body.result.notes.length >= 2, "hasMany eager-loads notes");
assert(
  withNotes.body.result.notes.every((n: any) => n.ownerId === "alice"),
  "hasMany only includes the user's notes",
);

// reader: can flat-read notes, but cannot traverse to owner (no users read, no directAccess).
const readerFlat = await post("listNotes", {}, "reader");
assert(readerFlat.status === 200, "reader can flat-read notes");
const readerTraverse = await post("listNotesWithOwner", {}, "reader");
assert(readerTraverse.status === 403, "reader is denied owner traversal (no flat read, no directAccess)");

console.log("\nALL RELATION / NESTED-ACL CHECKS PASSED");
process.exit(0);
