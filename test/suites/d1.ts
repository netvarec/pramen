// D1-backed end-to-end: the SAME schema / ACL / read engine running over a real D1
// binding (the "Worker + D1, no DO" path, selected via `x-pramen-store: d1`). Proves
// the Driver seam works end-to-end in miniflare — auth, row scoping, field
// projection, cell-level ACL, writes, and aggregates all run over D1, not just the
// DO. (Live queries are intentionally DO-only and not exercised here.)

import { assert, token } from "../lib";

export async function runD1(base: string): Promise<void> {
  const TENANT = "d1-demo";

  // Like the shared `http` helper, but adds `x-pramen-store: d1` so the Worker runs
  // dispatch over D1 instead of routing to the Durable Object.
  const post = (name: string, input: unknown, bearer?: string) =>
    fetch(`${base}/rpc/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pramen-tenant": TENANT,
        "x-pramen-store": "d1",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(input ?? {}),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  const T = {
    admin: await token("admin", ["admin"]),
    alice: await token("alice", ["author"], { tenants: [TENANT] }),
    bob: await token("bob", ["author"], { tenants: [TENANT] }),
    reader: await token("reader-user", ["reader"], { tenants: [TENANT] }),
    aliceTeam: await token("alice", ["teammate"], { tenants: [TENANT] }),
  };

  // --- auth: anonymous denied on the D1 path too ---
  const anon = await post("listNotes", {});
  assert(anon.status === 403 && anon.body.ok === false, "D1: anonymous read is denied (403)");

  // --- create over D1 + write rules; RETURNING * round-trips through D1 ---
  const aliceNote = await post("createNote", { title: "d1-alice", body: "alice-secret" }, T.alice);
  const bobNote = await post("createNote", { title: "d1-bob", body: "bob-secret" }, T.bob);
  assert(aliceNote.body.ok && bobNote.body.ok, "D1: author can create");
  assert(aliceNote.body.result.ownerId === "alice", "D1: policy `set` stamps ownerId from identity");
  assert(typeof aliceNote.body.result.id === "number", "D1: insert returns the persisted row (RETURNING over D1)");

  // --- row-level read scope ---
  const aliceList = await post("listNotes", {}, T.alice);
  assert(
    aliceList.body.result.length > 0 && aliceList.body.result.every((n: any) => n.ownerId === "alice"),
    "D1: author read is row-scoped to own notes",
  );
  const adminList = await post("listNotes", {}, T.admin);
  const owners = new Set(adminList.body.result.map((n: any) => n.ownerId));
  assert(owners.has("alice") && owners.has("bob"), "D1: admin read sees all owners");

  // --- field projection: reader can't see `body` ---
  const readerList = await post("listNotes", {}, T.reader);
  assert(
    readerList.body.result.length > 0 && readerList.body.result.every((n: any) => !("body" in n) && "title" in n),
    "D1: reader projection drops the body field",
  );

  // --- cell-level ACL: teammate sees `body` only on its own rows ---
  const teamList = await post("listNotes", {}, T.aliceTeam);
  const teamAlice = teamList.body.result.find((n: any) => n.ownerId === "alice");
  const teamBob = teamList.body.result.find((n: any) => n.ownerId === "bob");
  assert(teamAlice && "body" in teamAlice, "D1: teammate sees body on its own note (cell-ACL)");
  assert(teamBob && !("body" in teamBob), "D1: teammate hides body on another's note (cell-ACL)");

  // --- owner-scoped update ---
  const own = await post("updateNote", { id: aliceNote.body.result.id, title: "d1-alice-edited" }, T.alice);
  assert(own.body.result?.title === "d1-alice-edited", "D1: alice can update her own note");
  const cross = await post("updateNote", { id: bobNote.body.result.id, title: "hijack" }, T.alice);
  assert(cross.body.ok && cross.body.result === null, "D1: alice updating bob's note is a no-op (row scope)");

  // --- count + grouped aggregate over D1 ---
  const count = await post("countNotes", {}, T.admin);
  assert(count.body.result >= 2, "D1: count works over D1");
  const stats = await post("statsByOwner", {}, T.admin);
  assert(
    Array.isArray(stats.body.result) && stats.body.result.length >= 2,
    "D1: grouped aggregate (groupBy ownerId) works over D1",
  );

  // --- live queries are not available on the D1 path ---
  const live = await post("listNotes", {}, T.alice); // sanity: RPC still fine; WS path is DO-only
  assert(live.body.ok, "D1: RPC remains available (live queries require the DO store)");
}
