// Worker entry — the stateless HTTP front door. Authenticates the request,
// authorizes the tenant, and routes /rpc/<handler> and /live to the per-tenant
// Durable Object. Also serves admin endpoints (/tenants, /admin/recover) that
// aren't tenant-data operations.

import { MrakDO } from "./durable-object";
import { authorizeTenant, isAdmin, resolveIdentity } from "./auth";
import type { Identity } from "./sdk/acl";

export interface Env {
  MRAK: DurableObjectNamespace;
  /** Project KV — tenant registry (`tenant:` keys) + handler ctx.kv (`app:` keys). */
  KV: KVNamespace;
  /** HMAC secret for verifying bearer JWTs. Dev value in wrangler.jsonc;
   * production via `wrangler secret put AUTH_SECRET`. */
  AUTH_SECRET: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const forbidden = (what: string) => json({ ok: false, error: `access denied: ${what}`, code: "forbidden" }, 403);
const badRequest = (msg: string) => json({ ok: false, error: msg, code: "bad_request" }, 400);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isWs = request.headers.get("Upgrade") === "websocket";

    // Browser WebSockets can't set headers, so /live accepts the bearer token and
    // tenant via the query string; fold them into headers for the rest of the flow.
    let req = request;
    if (isWs) {
      const h = new Headers(request.headers);
      const qToken = url.searchParams.get("token");
      if (qToken && !h.get("authorization")) h.set("authorization", `Bearer ${qToken}`);
      const qTenant = url.searchParams.get("tenant");
      if (qTenant && !h.get("x-mrak-tenant")) h.set("x-mrak-tenant", qTenant);
      req = new Request(request, { headers: h });
    }

    const identity = await resolveIdentity(req, env.AUTH_SECRET);

    // --- admin: list known tenants ---
    if (url.pathname === "/tenants") {
      if (!isAdmin(identity)) return forbidden("tenants");
      const list = await env.KV.list({ prefix: "tenant:" });
      return json({ ok: true, result: list.keys.map((k) => k.name.slice("tenant:".length)) });
    }

    // --- admin: point-in-time recovery for a tenant ---
    if (url.pathname === "/admin/recover" && request.method === "POST") {
      if (!isAdmin(identity)) return forbidden("recover");
      const body = (await request.json().catch(() => ({}))) as { tenant?: unknown; timestamp?: unknown };
      if (typeof body.tenant !== "string" || !body.tenant) return badRequest("tenant required");
      if (typeof body.timestamp !== "number" && typeof body.timestamp !== "string") return badRequest("timestamp required");
      const stub = env.MRAK.get(env.MRAK.idFromName(body.tenant));
      const internal = new Request("https://do/__recover", {
        method: "POST",
        headers: { "content-type": "application/json", "x-mrak-tenant": body.tenant },
        body: JSON.stringify({ timestamp: body.timestamp }),
      });
      return stub.fetch(internal);
    }

    // --- admin: a tenant's applied schema (hash + tables) ---
    if (url.pathname === "/admin/schema") {
      if (!isAdmin(identity)) return forbidden("schema");
      const tenant = url.searchParams.get("tenant") ?? "main";
      const stub = env.MRAK.get(env.MRAK.idFromName(tenant));
      return stub.fetch(new Request("https://do/__schema", { headers: { "x-mrak-tenant": tenant } }));
    }

    const isRpc = url.pathname.startsWith("/rpc/");
    const isLive = url.pathname === "/live";

    if (!isRpc && !(isLive && isWs)) {
      return new Response(
        "mrak — POST /rpc/<handler> (JSON body), or WebSocket /live for live queries. " +
          "Header X-Mrak-Tenant selects the store (default: main). " +
          "Admin: GET /tenants, POST /admin/recover {tenant,timestamp}, GET /admin/schema?tenant=.\n",
        { headers: { "content-type": "text/plain" } },
      );
    }

    // Authorize the tenant against the identity before reaching the DO, so a
    // caller can't address (or register) tenants they have no claim to.
    const tenant = req.headers.get("x-mrak-tenant") ?? "main";
    if (!authorizeTenant(identity, tenant)) return forbidden(`tenant '${tenant}'`);

    // Forward a trusted identity to the DO (the DO never re-derives it).
    const headers = new Headers(req.headers);
    if (identity) headers.set("x-mrak-identity", JSON.stringify(identity as Identity));
    else headers.delete("x-mrak-identity");

    const stub = env.MRAK.get(env.MRAK.idFromName(tenant));
    return stub.fetch(new Request(req, { headers }));
  },
};

export { MrakDO };
