// Relation-aware `where`: filter an entity by a related entity's column, compiled
// to a security-scoped subquery. Covers belongsTo + hasMany traversal in a user
// query, the ACL scoping (a relation filter respects the target's read ACL), and a
// policy `where` that itself traverses a relation.

import { assert, http, token } from "../lib";

export async function runRelWhere(base: string): Promise<void> {
  const TENANT = "relwhere";
  const call = http(base, TENANT);
  const admin = await token("admin", ["admin"]);
  const reader = await token("r", ["reader"], { tenants: [TENANT] });

  // Seed via the admin data API (SYSTEM scope bypasses the ownedByCaller set rule,
  // so we can create notes with explicit owners).
  const data = (body: unknown) =>
    fetch(`${base}/admin/data`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<any>);
  await data({ tenant: TENANT, table: "users", op: "create", values: { id: "u-alice", name: "Alice", email: "a@x" } });
  await data({ tenant: TENANT, table: "users", op: "create", values: { id: "u-bob", name: "Bob", email: "b@x" } });
  for (const [title, ownerId, createdAt] of [["a1", "u-alice", 1], ["a2", "u-alice", 2], ["b1", "u-bob", 3]] as const) {
    await data({ tenant: TENANT, table: "notes", op: "create", values: { title, body: "x", ownerId, createdAt } });
  }

  // --- belongsTo traversal: notes whose owner.name == "Alice" ---
  const byOwner = await call("queryNotes", { where: { owner: { name: "Alice" } } }, admin);
  assert(
    byOwner.body.ok && byOwner.body.result.length === 2 && byOwner.body.result.every((n: any) => n.ownerId === "u-alice"),
    "relwhere: belongsTo traversal — notes filtered by owner.name",
  );
  const noMatch = await call("queryNotes", { where: { owner: { name: "Nobody" } } }, admin);
  assert(noMatch.body.ok && noMatch.body.result.length === 0, "relwhere: belongsTo traversal with no match → empty");

  // --- hasMany traversal: users who own a note with ownerId u-bob ---
  const owners = await call("queryUsers", { where: { notes: { ownerId: "u-bob" } } }, admin);
  assert(
    owners.body.ok && owners.body.result.length === 1 && owners.body.result[0].id === "u-bob",
    "relwhere: hasMany traversal — users filtered by their notes",
  );

  // --- security: a role that reads notes but NOT users can't filter through owner ---
  const all = await call("queryNotes", {}, reader);
  assert(all.body.ok && all.body.result.length >= 3, "relwhere: reader sees notes without a relation filter");
  const blocked = await call("queryNotes", { where: { owner: { name: "Alice" } } }, reader);
  assert(
    blocked.body.ok && blocked.body.result.length === 0,
    "relwhere: relation filter respects the target's read ACL (no users read → empty)",
  );

  // --- security: filtering on a field the caller can't read is denied (403), the
  // same as ordering/aggregating by a hidden column — a filter is otherwise an
  // oracle for the hidden value. reader has no `body` grant. ---
  const filterHidden = await call("queryNotes", { where: { body: "x" } }, reader);
  assert(
    filterHidden.status === 403 && filterHidden.body.code === "forbidden",
    "relwhere: filtering on a non-readable column is denied (403)",
  );

  // --- OR-branch marker semantics: an unresolvable $identity marker collapses ONLY
  // its own branch (boolean logic), so the sibling literal branch still matches. The
  // `ghost` claim never exists, so the orfallback scope reduces to `title == "a1"`. ---
  const orcaller = await token("ghosthunter", ["orfallback"], { tenants: [TENANT] });
  const fallback = await call("queryNotes", {}, orcaller);
  assert(
    fallback.body.ok && fallback.body.result.length === 1 && fallback.body.result[0].title === "a1",
    "relwhere: unresolvable marker in an OR branch collapses only that branch (sibling literal still matches)",
  );

  // --- ACL policy `where` that traverses a relation: owneronly = note.owner.id == me ---
  const aliceOnly = await token("u-alice", ["owneronly"], { tenants: [TENANT] });
  const mine = await call("listNotes", {}, aliceOnly);
  assert(
    mine.body.ok && mine.body.result.length === 2 && mine.body.result.every((n: any) => n.ownerId === "u-alice"),
    "relwhere: ACL policy `where` traverses a relation (owneronly sees only own notes)",
  );
}
