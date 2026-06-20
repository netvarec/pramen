// Cell-level (per-row) ACL: field visibility that depends on the row's data, not
// just the (entity, action). Covers the declarative `conditionalFields` form, the
// `fieldsFn` escape hatch, per-row write enforcement (insert + update), and the
// guards that keep conditional columns out of aggregates and orderBy/cursors.

import { assert, http, token } from "../lib";

export async function runCellAcl(base: string): Promise<void> {
  const TENANT = "cell-acl-demo";
  const post = http(base, TENANT);
  const T = {
    aliceAuthor: await token("alice", ["author"], { tenants: [TENANT] }),
    bobAuthor: await token("bob", ["author"], { tenants: [TENANT] }),
    aliceTeam: await token("alice", ["teammate"], { tenants: [TENANT] }),
    alicePeek: await token("alice", ["peeker"], { tenants: [TENANT] }),
    admin: await token("admin", ["admin"]),
  };

  // Seed one note owned by alice and one by bob (author:create stamps ownerId=self).
  const aliceNote = await post("createNote", { title: "alice-note", body: "alice-secret" }, T.aliceAuthor);
  const bobNote = await post("createNote", { title: "bob-note", body: "bob-secret" }, T.bobAuthor);
  assert(aliceNote.body.ok && bobNote.body.ok, "seed notes created");
  const aliceId = aliceNote.body.result.id;
  const bobId = bobNote.body.result.id;

  // --- read: per-row field visibility in ONE response (declarative form) ---
  const teamList = await post("listNotes", {}, T.aliceTeam);
  assert(teamList.body.ok, "teammate can read notes");
  const teamAlice = teamList.body.result.find((n: any) => n.id === aliceId);
  const teamBob = teamList.body.result.find((n: any) => n.id === bobId);
  assert("body" in teamAlice && teamAlice.body === "alice-secret", "teammate sees body on its OWN note");
  assert(!("body" in teamBob), "teammate does NOT see body on another's note");
  assert("title" in teamBob, "non-body fields are still present on another's note");

  // --- read: same per-row visibility via the function escape hatch ---
  const peekList = await post("listNotes", {}, T.alicePeek);
  const peekAlice = peekList.body.result.find((n: any) => n.id === aliceId);
  const peekBob = peekList.body.result.find((n: any) => n.id === bobId);
  assert("body" in peekAlice, "peeker (fieldsFn) sees body on its own note");
  assert(!("body" in peekBob), "peeker (fieldsFn) hides body on another's note");

  // --- write/insert: `set` forces ownerId=self, so the conditional `when` matches
  // and the teammate may set body on the note it is creating (set-before-check). ---
  const teamCreate = await post("createNote", { title: "team-note", body: "team-body" }, T.aliceTeam);
  assert(teamCreate.body.ok, "teammate can create a note with body (ownerId forced to self)");
  const teamCreatedId = teamCreate.body.result.id;
  const created = await post("getNote", { id: teamCreatedId }, T.admin);
  assert(created.body.result.body === "team-body", "teammate's created body persisted");

  // --- write/update: body editable on own note, denied on another's (post-merge eval) ---
  const updOwn = await post("updateNote", { id: teamCreatedId, body: "edited-body" }, T.aliceTeam);
  assert(updOwn.body.ok && updOwn.body.result, "teammate can edit body on its own note");

  const updOther = await post("updateNote", { id: bobId, body: "hijacked" }, T.aliceTeam);
  assert(updOther.status === 403 && updOther.body.ok === false, "teammate CANNOT edit body on another's note (403)");
  const bobUnchanged = await post("getNote", { id: bobId }, T.admin);
  assert(bobUnchanged.body.result.body === "bob-secret", "bob's body is unchanged after the denied edit");

  const updOtherTitle = await post("updateNote", { id: bobId, title: "renamed-by-team" }, T.aliceTeam);
  assert(updOtherTitle.body.ok && updOtherTitle.body.result, "teammate CAN edit title on another's note (base field)");

  // --- aggregate over a conditionally-only column is denied (set-level vs per-row) ---
  const agg = await post("maxBody", {}, T.aliceTeam);
  assert(agg.status === 403 && agg.body.ok === false, "aggregate over conditionally-granted `body` is denied");

  // --- ordering by a non-readable column is rejected (order + keyset cursor leak guard) ---
  const orderLeak = await post("queryNotes", { orderBy: { column: "body" } }, T.aliceTeam);
  assert(orderLeak.status === 403 && orderLeak.body.ok === false, "ordering by a non-readable column is denied");
}
