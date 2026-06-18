// Worker entry — the stateless HTTP front door. Routes /rpc/<handler> to the
// per-tenant Durable Object. This is the axum layer of the prior runtime, except routing
// and dispatch to the single writer are handled by the DO namespace.

import { MrakDO } from "./durable-object";
import { resolveIdentity } from "./auth";

export interface Env {
  MRAK: DurableObjectNamespace;
  /** HMAC secret for verifying bearer JWTs. Dev value in wrangler.jsonc;
   * production via `wrangler secret put AUTH_SECRET`. */
  AUTH_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isWs = request.headers.get("Upgrade") === "websocket";
    const isRpc = url.pathname.startsWith("/rpc/");
    const isLive = url.pathname === "/live";

    if (!isRpc && !(isLive && isWs)) {
      return new Response(
        "mrak — POST /rpc/<handler> (JSON body), or WebSocket /live for live queries. " +
          "Header X-Mrak-Tenant selects the store (default: main).\n",
        { headers: { "content-type": "text/plain" } },
      );
    }

    // Authenticate at the edge, then forward a trusted identity to the DO.
    const identity = await resolveIdentity(request, env.AUTH_SECRET);
    const headers = new Headers(request.headers);
    if (identity) headers.set("x-mrak-identity", JSON.stringify(identity));
    else headers.delete("x-mrak-identity");
    const forwarded = new Request(request, { headers });

    // One DO instance per tenant => writes serialize within a tenant and
    // parallelize across tenants, for free. Both HTTP RPC and the live-query
    // socket route to the same per-tenant DO, so a mutation can push to sockets.
    const tenant = request.headers.get("x-mrak-tenant") ?? "main";
    const stub = env.MRAK.get(env.MRAK.idFromName(tenant));
    return stub.fetch(forwarded);
  },
};

export { MrakDO };
