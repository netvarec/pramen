// Operators in ACL where rules: the `manager` role reads notes whose ownerId is
// `in` the caller's team (an $identity marker resolving to an array). Demonstrates
// operator + array-marker resolution, and the safe-deny when the marker is absent.

import { assert, http, sign, token } from "../lib";

export async function runAclOperators(base: string): Promise<void> {
  const TENANT = "acl-ops-demo";
  const post = http(base, TENANT);

  const alice = await token("alice", ["author"], { tenants: [TENANT] });
  const bob = await token("bob", ["author"], { tenants: [TENANT] });
  const carol = await token("carol", ["author"], { tenants: [TENANT] });

  await post("createNote", { title: "a", body: "x" }, alice);
  await post("createNote", { title: "b", body: "x" }, bob);
  await post("createNote", { title: "c", body: "x" }, carol);

  // manager whose team is [alice, bob]
  const mgr = await sign({ sub: "mgr", roles: ["manager"], team: ["alice", "bob"], tenants: [TENANT] });
  const view = await post("listNotes", {}, mgr);
  assert(view.status === 200, "manager read is allowed");
  const owners = new Set(view.body.result.map((n: any) => n.ownerId));
  assert(owners.has("alice") && owners.has("bob"), "manager sees team members' notes (ownerId IN team)");
  assert(!owners.has("carol"), "manager does NOT see a non-team member's notes");

  // manager with no `team` claim -> marker unresolved -> rule matches nothing
  const mgrNoTeam = await sign({ sub: "mgr2", roles: ["manager"], tenants: [TENANT] });
  const empty = await post("listNotes", {}, mgrNoTeam);
  assert(empty.status === 200 && empty.body.result.length === 0, "unresolved marker denies all rows (not leaks them)");
}
