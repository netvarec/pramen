// Admin data API: generic, admin-gated, per-tenant data ops (list/get/create/
// update/delete/count) over any table, run in the DO under SYSTEM scope (ACL
// bypassed). The backend a dashboard sits on. Non-admins are rejected; the
// json/fileRef codec still applies.

import { assert, token } from "../lib";

export async function runAdmin(base: string): Promise<void> {
  const TENANT = "admin-data";
  const admin = await token("admin", ["admin"]);
  const author = await token("alice", ["author"], { tenants: [TENANT] });

  const data = (body: unknown, bearer = admin) =>
    fetch(`${base}/admin/data`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  // --- gate: only admins ---
  const byAuthor = await data({ tenant: TENANT, table: "notes", op: "list" }, author);
  assert(byAuthor.status === 403, "admin-data: a non-admin is denied (403)");
  const byAnon = await data({ tenant: TENANT, table: "notes", op: "list" }, "");
  assert(byAnon.status === 403, "admin-data: anonymous is denied (403)");

  // --- create (with a json column to exercise the codec) ---
  const created = await data({
    tenant: TENANT,
    table: "notes",
    op: "create",
    values: { title: "admin-made", body: "secret", ownerId: "someone", createdAt: 1, meta: { tag: "x" } },
  });
  assert(created.body.ok && typeof created.body.result.id === "number", "admin-data: create returns the row + id");
  assert(created.body.result.meta?.tag === "x", "admin-data: json codec applies on the create echo");
  const id = created.body.result.id;

  // --- list / get / count (no ACL — admin sees everything, all fields) ---
  const list = await data({ tenant: TENANT, table: "notes", op: "list" });
  assert(list.body.ok && list.body.result.some((r: any) => r.id === id && "body" in r), "admin-data: list returns full rows");
  const got = await data({ tenant: TENANT, table: "notes", op: "get", id });
  assert(got.body.result?.id === id && got.body.result.meta?.tag === "x", "admin-data: get returns the row (json decoded)");
  const count = await data({ tenant: TENANT, table: "notes", op: "count" });
  assert(typeof count.body.result === "number" && count.body.result >= 1, "admin-data: count works");

  // --- update / delete ---
  const upd = await data({ tenant: TENANT, table: "notes", op: "update", id, patch: { title: "admin-edited" } });
  assert(upd.body.result?.title === "admin-edited", "admin-data: update edits any row");
  const del = await data({ tenant: TENANT, table: "notes", op: "delete", id });
  assert(del.body.result === true, "admin-data: delete removes the row");
  const gone = await data({ tenant: TENANT, table: "notes", op: "get", id });
  assert(gone.body.ok && gone.body.result === null, "admin-data: the row is gone after delete");

  // --- guards ---
  const badTable = await data({ tenant: TENANT, table: "nope", op: "list" });
  assert(badTable.status === 400, "admin-data: unknown table -> 400");
  const badOp = await data({ tenant: TENANT, table: "notes", op: "frobnicate" });
  assert(badOp.status === 400, "admin-data: unknown op -> 400");

  // --- partition param: an explicit `partition: "default"` routes to the BARE tenant
  // DO key — byte-for-byte the DO an omitted-partition call hits (back-compat). A row
  // created without a partition is therefore visible to a list with partition:"default". ---
  const partCreated = await data({
    tenant: TENANT,
    table: "notes",
    op: "create",
    values: { title: "default-part", body: "x", ownerId: "someone", createdAt: 2 },
  });
  assert(partCreated.body.ok, "admin-data: create (no partition) succeeds");
  const partId = partCreated.body.result.id;
  const defaultList = await data({ tenant: TENANT, table: "notes", op: "list", partition: "default" });
  assert(
    defaultList.body.ok && defaultList.body.result.some((r: any) => r.id === partId),
    "admin-data: partition:'default' hits the same (bare-key) DO as omitting partition",
  );
}
