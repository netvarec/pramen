// count + aggregates: ACL read scope applies, grouped aggregation works, and an
// aggregate over a field the caller can't read is denied.

import { assert, http, token } from "../lib";

export async function runAggregate(base: string): Promise<void> {
  const TENANT = "agg-demo";
  const post = http(base, TENANT);
  const admin = await token("admin", ["admin"]);
  const alice = await token("alice", ["author"], { tenants: [TENANT] });
  const bob = await token("bob", ["author"], { tenants: [TENANT] });
  const reader = await token("reader-user", ["reader"], { tenants: [TENANT] });

  // ownerId is forced to the caller by policy `set`.
  await post("createNote", { title: "a1", body: "x" }, alice);
  await post("createNote", { title: "a2", body: "x" }, alice);
  await post("createNote", { title: "b1", body: "x" }, bob);
  await post("createNote", { title: "ad1", body: "x" }, admin);

  // count
  const total = await post("countNotes", {}, admin);
  assert(total.body.result === 4, "count returns total visible rows");
  const aliceCount = await post("countNotes", { ownerId: "alice" }, admin);
  assert(aliceCount.body.result === 2, "count honors a where filter");

  // grouped aggregate
  const stats = await post("statsByOwner", {}, admin);
  const byOwner = new Map<string, any>(stats.body.result.map((r: any) => [r.ownerId, r]));
  assert(byOwner.get("alice")?.count === 2, "group count for alice is 2");
  assert(byOwner.get("bob")?.count === 1, "group count for bob is 1");
  assert(typeof byOwner.get("alice")?.firstId === "number" && byOwner.get("alice").lastId >= byOwner.get("alice").firstId, "min/max aggregates returned");

  // anonymous is denied
  const anon = await post("countNotes", {});
  assert(anon.status === 403, "anonymous count is denied (403)");

  // reader can count rows in scope, but cannot aggregate a hidden column (body)
  const readerCount = await post("countNotes", {}, reader);
  assert(readerCount.body.result === 4, "reader can count (rows are readable)");
  const readerBody = await post("maxBody", {}, reader);
  assert(readerBody.status === 403 && readerBody.body.code === "forbidden", "aggregate over a hidden field is denied (403)");
  const adminBody = await post("maxBody", {}, admin);
  assert(adminBody.status === 200, "admin can aggregate body");
}
