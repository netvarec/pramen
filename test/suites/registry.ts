// Tenant registry: touching a tenant records it (so DOs stay discoverable), and
// GET /tenants lists them for admins only.

import { assert, token } from "../lib";

export async function runRegistry(base: string): Promise<void> {
  const admin = await token("admin", ["admin"]);
  const reader = await token("reader-user", ["reader"]);
  const probe = "registry-probe";

  // First touch of a fresh tenant registers it (registration runs before dispatch,
  // so even a denied call registers — here we use admin).
  await fetch(`${base}/rpc/listNotes`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mrak-tenant": probe, authorization: `Bearer ${admin}` },
    body: "{}",
  });

  const listTenants = (bearer?: string) =>
    fetch(`${base}/tenants`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : undefined);

  const asAdmin = await listTenants(admin);
  const body = await asAdmin.json();
  assert(asAdmin.status === 200 && body.ok === true, "admin can list tenants");
  assert(Array.isArray(body.result) && body.result.includes(probe), "the touched tenant is registered & listed");

  const asReader = await listTenants(reader);
  assert(asReader.status === 403, "non-admin cannot list tenants");

  const asAnon = await listTenants();
  assert(asAnon.status === 403, "anonymous cannot list tenants");
}
