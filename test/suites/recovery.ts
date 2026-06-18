// Admin point-in-time recovery endpoint. The auth gating + validation are tested
// locally; the actual restore needs a deployed DO (PITR isn't available in
// miniflare), so a valid admin call reports 501 "unavailable" in local dev.

import { assert, token } from "../lib";

export async function runRecovery(base: string): Promise<void> {
  const admin = await token("admin", ["admin"]);
  const reader = await token("reader-user", ["reader"], { tenants: ["recover-probe"] });

  const recover = (body: unknown, bearer?: string) =>
    fetch(`${base}/admin/recover`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });

  const anon = await recover({ tenant: "recover-probe", timestamp: Date.now() });
  assert(anon.status === 403, "anonymous cannot trigger recovery");

  const asReader = await recover({ tenant: "recover-probe", timestamp: Date.now() }, reader);
  assert(asReader.status === 403, "non-admin cannot trigger recovery (admin-only)");

  const noTs = await recover({ tenant: "recover-probe" }, admin);
  assert(noTs.status === 400 && (await noTs.json()).code === "bad_request", "missing timestamp -> 400");

  const noTenant = await recover({ timestamp: Date.now() }, admin);
  assert(noTenant.status === 400, "missing tenant -> 400");

  // Valid admin request reaches the DO. PITR is platform-only, so local dev
  // reports 501; a deployed Worker returns 200 with an undo bookmark.
  const ok = await recover({ tenant: "recover-probe", timestamp: Date.now() - 60_000 }, admin);
  const body = await ok.json();
  assert([200, 501].includes(ok.status), "admin recover reaches the DO (200 deployed / 501 local)");
  if (ok.status === 501) assert(body.code === "unavailable", "local dev reports PITR unavailable");
  if (ok.status === 200) assert(typeof body.result?.undo === "string", "deployed recover returns an undo bookmark");
}
