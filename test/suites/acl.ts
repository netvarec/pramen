// ACL: deny-by-default, verified JWT, row-level read scoping, field projection,
// owner-scoped update/delete, write-side set/validate, and per-identity live queries.

import { assert, http, sign, sleep, token, wsClient } from "../lib";

export async function runAcl(base: string, wsUrl: string): Promise<void> {
  const TENANT = "acl-demo";
  const post = http(base, TENANT);
  const T = {
    admin: await token("admin", ["admin"]),
    alice: await token("alice", ["author"], { tenants: [TENANT] }),
    bob: await token("bob", ["author"], { tenants: [TENANT] }),
    reader: await token("reader-user", ["reader"], { tenants: [TENANT] }),
  };

  // --- auth ---
  const anon = await post("listNotes", {});
  assert(anon.status === 403 && anon.body.ok === false, "anonymous read is denied (403)");

  const forged = await sign({ sub: "alice", roles: ["admin"] }, "wrong-secret");
  const forgedRes = await post("listNotes", {}, forged);
  assert(forgedRes.status === 403, "forged token (wrong secret) is rejected");

  // --- create + write rules ---
  const adminNote = await post("createNote", { title: "by-admin", body: "secret" }, T.admin);
  const aliceNote = await post("createNote", { title: "by-alice", body: "alice-body" }, T.alice);
  const bobNote = await post("createNote", { title: "by-bob", body: "bob-body" }, T.bob);
  assert(adminNote.body.ok && aliceNote.body.ok && bobNote.body.ok, "admin/alice/bob can create");
  assert(aliceNote.body.result.ownerId === "alice", "policy `set` stamps ownerId from identity");

  const forge = await post("createNote", { title: "forge", body: "x", ownerId: "bob" }, T.alice);
  assert(forge.body.result.ownerId === "alice", "policy `set` overrides a forged ownerId");

  const bad = await post("createNote", { title: "", body: "x" }, T.alice);
  assert(bad.status === 400 && bad.body.ok === false, "policy `validate` rejects an empty title (400)");

  // --- row-level read ---
  const aliceList = await post("listNotes", {}, T.alice);
  assert(aliceList.body.result.every((n: any) => n.ownerId === "alice"), "author read is row-scoped to own notes");
  assert(aliceList.body.result.some((n: any) => n.id === aliceNote.body.result.id), "author sees their own note");

  const adminList = await post("listNotes", {}, T.admin);
  const owners = new Set(adminList.body.result.map((n: any) => n.ownerId));
  assert(owners.has("alice") && owners.has("bob"), "admin read sees all owners");

  // --- field projection ---
  const readerList = await post("listNotes", {}, T.reader);
  assert(readerList.body.result.length > 0, "reader can read notes");
  assert(
    readerList.body.result.every((n: any) => !("body" in n) && "title" in n),
    "reader projection drops the body field",
  );

  // --- owner-scoped update/delete ---
  const cross = await post("updateNote", { id: bobNote.body.result.id, title: "hijacked" }, T.alice);
  assert(cross.body.ok && cross.body.result === null, "alice updating bob's note is a no-op");
  const bobAfter = await post("getNote", { id: bobNote.body.result.id }, T.admin);
  assert(bobAfter.body.result.title === "by-bob", "bob's note is unchanged");

  const own = await post("updateNote", { id: aliceNote.body.result.id, title: "alice-edited" }, T.alice);
  assert(own.body.result?.title === "alice-edited", "alice can update her own note");

  const crossDel = await post("deleteNote", { id: bobNote.body.result.id }, T.alice);
  assert(crossDel.body.result === false, "alice cannot delete bob's note");
  const adminDel = await post("deleteNote", { id: bobNote.body.result.id }, T.admin);
  assert(adminDel.body.result === true, "admin can delete bob's note");

  // --- per-identity live queries ---
  const live = wsClient(wsUrl, { authorization: `Bearer ${T.alice}`, "x-mrak-tenant": TENANT });
  await live.ready;
  const isMine = (m: any) => m.type === "data" && m.id === "mine";
  live.send({ type: "subscribe", id: "mine", name: "listNotes" });
  const init = await live.next(isMine, "alice initial");
  assert(init.result.every((n: any) => n.ownerId === "alice"), "alice's live sub is row-scoped");
  live.drain();

  await post("createNote", { title: "bob-live", body: "x" }, T.bob);
  await sleep(500);
  assert(!live.has(isMine), "a write by bob does NOT push to alice's scoped subscription");

  await post("createNote", { title: "alice-live", body: "y" }, T.alice);
  const push = await live.next(isMine, "alice push after her own write");
  assert(push.result.some((n: any) => n.title === "alice-live"), "alice is pushed her own new note");
  live.close();
}
