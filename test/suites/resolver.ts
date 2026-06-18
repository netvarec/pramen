// Dynamic resolvers: the `member` read policy consults the DB (SYSTEM mode) per
// request — read is denied until you've authored a note, then granted for all.

import { assert, http, token } from "../lib";

export async function runResolver(base: string): Promise<void> {
  const TENANT = "resolver-demo";
  const post = http(base, TENANT);
  const admin = await token("admin", ["admin"]);
  const mia = await token("mia", ["member"]);

  const seed = await post("createNote", { title: "admin-only", body: "x" }, admin);
  assert(seed.body.ok, "admin seeded a note");

  const before = await post("listNotes", {}, mia);
  assert(before.status === 403, "member read denied before authoring (resolver -> deny)");

  const note = await post("createNote", { title: "mia-first", body: "y" }, mia);
  assert(note.body.ok && note.body.result.ownerId === "mia", "member can create; ownerId stamped");

  const after = await post("listNotes", {}, mia);
  assert(after.status === 200, "member read allowed after authoring (resolver -> allow)");
  const owners = new Set(after.body.result.map((n: any) => n.ownerId));
  assert(owners.has("admin") && owners.has("mia"), "resolver allow() grants read across all owners");
}
