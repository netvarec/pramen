// DO partitions, end-to-end. The example has two partitions sharing one PramenDO
// class: the DEFAULT partition (notes/users/signups) and the "audit" partition
// (auditLog). They are independent Durable Objects (different idFromName), so they
// migrate, store, broadcast, and are addressed in isolation. This suite is the
// integration capstone for the partitions feature — it exercises it, not builds it.
//
// Coverage (maps to issue 09's six points):
//  1. Same-partition still works: a notes tx + relation `with` read + a live push.
//  2. Partition isolation: logAudit writes land in the audit DO; /admin/schema for
//     the default partition does NOT list auditLog and the audit partition's schema
//     does NOT list notes/users.
//  3. Cross-partition relation rejected: UNIT-TESTED in test/schema-validate.test.ts
//     (adding a bad relation to the example would break boot), so NOT re-proven here.
//  4. Runtime guard: addressing auditLog through the DEFAULT-partition DO (via
//     /admin/data partition:"default") returns the partition BadRequest.
//  5. Reactivity is partition-local: an audit mutation does NOT wake a notes sub.
//  6. Admin per-partition: /admin/data and /admin/schema with partition=audit reach
//     the audit DO; without it (or partition:"default") the default DO.

import { assert, http, sleep, token, wsClient } from "../lib";

export async function runPartitions(base: string, wsUrl: string): Promise<void> {
  const TENANT = "partitions";
  const call = http(base, TENANT);
  const admin = await token("admin", ["admin"]);

  const data = (body: unknown, bearer = admin) =>
    fetch(`${base}/admin/data`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  const schemaOf = (partition?: string) => {
    const q = new URLSearchParams({ tenant: TENANT });
    if (partition) q.set("partition", partition);
    return fetch(`${base}/admin/schema?${q}`, { headers: { authorization: `Bearer ${admin}` } }).then(
      async (r) => ({ status: r.status, body: (await r.json()) as any }),
    );
  };

  // === 1. Same-partition (default) still works — regression guard ===========
  // notes tx + relation traversal, over the default partition path (no header).
  // The admin create policy's `set` forces ownerId to the caller (sub "admin"), so
  // seed a matching user for the relation traversal to resolve to a name.
  await data({ tenant: TENANT, table: "users", op: "create", values: { id: "admin", name: "Admin", email: "a@x" } });
  const note = await call("createNote", { title: "default-note", body: "b" }, admin);
  assert(note.body.ok, "same-partition: notes mutation succeeds on the default DO");
  const withOwner = await call("listNotesWithOwner", {}, admin);
  assert(
    withOwner.body.ok && withOwner.body.result.some((n: any) => n.title === "default-note" && n.owner?.name === "Admin"),
    "same-partition: notes relation `with: { owner }` traversal works",
  );

  // Live subscription on the DEFAULT partition pushes on a notes mutation.
  const liveDefault = wsClient(wsUrl, { authorization: `Bearer ${admin}`, "x-pramen-tenant": TENANT });
  await liveDefault.ready;
  const isList = (m: any) => m.type === "data" && m.id === "notes";
  liveDefault.send({ type: "subscribe", id: "notes", name: "listNotes" });
  const seed = await liveDefault.next(isList, "default-partition initial list");
  const baseCount = seed.result.length;
  liveDefault.drain();
  await call("createNote", { title: "wake-default", body: "z" }, admin);
  const push = await liveDefault.next(isList, "default-partition list push after notes mutation");
  assert(push.result.length === baseCount + 1, "same-partition: live subscription pushed on a notes mutation");

  // === 2. Partition isolation: logAudit lands in the audit DO ================
  const a1 = await call("logAudit", { action: "login" }, admin);
  assert(a1.body.ok && typeof a1.body.result.id === "number", "isolation: logAudit write succeeds (audit partition handler)");
  const audited = await call("listAudit", {}, admin);
  assert(
    audited.body.ok && audited.body.result.some((r: any) => r.action === "login"),
    "isolation: listAudit reads back the audit entry from the audit DO",
  );

  // /admin/schema for the DEFAULT partition lists notes/users but NOT auditLog;
  // the audit partition's schema lists auditLog but NOT notes/users.
  const defSchema = await schemaOf(); // omitted partition → default DO
  assert(defSchema.body.ok, "isolation: /admin/schema (default) responds");
  const defTables = Object.keys(defSchema.body.result.tables);
  assert(defTables.includes("notes") && defTables.includes("users"), "isolation: default schema lists notes + users");
  assert(!defTables.includes("auditLog"), "isolation: default schema does NOT list auditLog");

  const auditSchema = await schemaOf("audit");
  assert(auditSchema.body.ok, "isolation: /admin/schema?partition=audit responds");
  const auditTables = Object.keys(auditSchema.body.result.tables);
  assert(auditTables.includes("auditLog"), "isolation: audit schema lists auditLog");
  assert(
    !auditTables.includes("notes") && !auditTables.includes("users"),
    "isolation: audit schema does NOT list notes/users",
  );
  // The two partitions migrated independently → distinct applied-schema hashes.
  assert(
    defSchema.body.result.hash !== auditSchema.body.result.hash,
    "isolation: the two partitions have distinct applied-schema hashes",
  );

  // === 4. Runtime guard: reach auditLog through the DEFAULT-partition DO =====
  // /admin/data with partition:"default" targeting auditLog hits the default DO,
  // whose Db rejects a table outside its partition (Issue 06).
  const crossDefault = await data({ tenant: TENANT, table: "auditLog", op: "list", partition: "default" });
  assert(crossDefault.status === 400, "runtime guard: auditLog via default-partition DO → 400");
  assert(
    typeof crossDefault.body.error === "string" &&
      crossDefault.body.error.includes("partition 'audit'") &&
      crossDefault.body.error.includes("not this partition 'default'"),
    "runtime guard: error names the table's partition vs this DO's partition",
  );
  // Conversely, reaching notes through the AUDIT DO is also rejected.
  const crossAudit = await data({ tenant: TENANT, table: "notes", op: "list", partition: "audit" });
  assert(crossAudit.status === 400, "runtime guard: notes via audit-partition DO → 400");
  assert(
    typeof crossAudit.body.error === "string" && crossAudit.body.error.includes("not this partition 'audit'"),
    "runtime guard: reverse direction also names the audit partition",
  );

  // === 5. Reactivity is partition-local =====================================
  // A subscription on the audit partition; a notes (default) mutation must NOT wake
  // it, and an audit mutation must NOT wake the default-partition notes sub.
  const liveAudit = wsClient(wsUrl, {
    authorization: `Bearer ${admin}`,
    "x-pramen-tenant": TENANT,
    "x-pramen-partition": "audit",
  });
  await liveAudit.ready;
  const isAudit = (m: any) => m.type === "data" && m.id === "audit";
  liveAudit.send({ type: "subscribe", id: "audit", name: "listAudit" });
  await liveAudit.next(isAudit, "audit-partition initial list");
  liveAudit.drain();
  liveDefault.drain();

  // Audit mutation → wakes the audit sub, but NOT the default notes sub.
  await call("logAudit", { action: "logout" }, admin);
  const auditPush = await liveAudit.next(isAudit, "audit sub push after an audit mutation");
  assert(auditPush.result.some((r: any) => r.action === "logout"), "partition-local: audit mutation woke the audit sub");
  await sleep(400);
  assert(!liveDefault.has(isList), "partition-local: an audit mutation did NOT wake the notes (default) sub");

  // Notes (default) mutation → wakes the notes sub, but NOT the audit sub.
  liveAudit.drain();
  liveDefault.drain();
  await call("createNote", { title: "wake-notes-only", body: "z" }, admin);
  await liveDefault.next(isList, "notes sub push after a notes mutation (cross-check)");
  await sleep(400);
  assert(!liveAudit.has(isAudit), "partition-local: a notes mutation did NOT wake the audit sub");

  liveDefault.close();
  liveAudit.close();

  // === 6. Admin per-partition reaches the right DO ==========================
  // /admin/data?partition=audit hits the audit DO (sees the entries it wrote there);
  // partition:"default" sees notes but never the audit rows (different DO).
  const auditAdmin = await data({ tenant: TENANT, table: "auditLog", op: "list", partition: "audit" });
  assert(
    auditAdmin.body.ok && auditAdmin.body.result.some((r: any) => r.action === "login"),
    "admin per-partition: /admin/data partition=audit reaches the audit DO's rows",
  );
  const auditCount = await data({ tenant: TENANT, table: "auditLog", op: "count", partition: "audit" });
  assert(typeof auditCount.body.result === "number" && auditCount.body.result >= 2, "admin per-partition: audit count works");
  // The default DO can list notes (proving without a partition we hit the default DO).
  const notesAdmin = await data({ tenant: TENANT, table: "notes", op: "list" });
  assert(
    notesAdmin.body.ok && notesAdmin.body.result.some((r: any) => r.title === "default-note"),
    "admin per-partition: omitting partition reaches the default DO's notes",
  );
}
