// Worker entry — the stateless HTTP front door. Routes /rpc/<handler> to the
// per-tenant Durable Object. This is the axum layer of the prior runtime, except routing
// and dispatch to the single writer are handled by the DO namespace.

import { MrakDO } from "./durable-object";

export interface Env {
  MRAK: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/rpc/")) {
      return new Response(
        "mrak — POST /rpc/<handler> with a JSON body. Header X-Mrak-Tenant selects the store (default: main).\n",
        { headers: { "content-type": "text/plain" } },
      );
    }

    // One DO instance per tenant => writes serialize within a tenant and
    // parallelize across tenants, for free.
    const tenant = request.headers.get("x-mrak-tenant") ?? "main";
    const stub = env.MRAK.get(env.MRAK.idFromName(tenant));
    return stub.fetch(request);
  },
};

export { MrakDO };
