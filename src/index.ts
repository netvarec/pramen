// Worker entry — the stateless HTTP front door. Authenticates the request,
// authorizes the tenant, and routes /rpc/<handler> and /live to the per-tenant
// Durable Object. Also serves admin endpoints (/tenants, /admin/recover) that
// aren't tenant-data operations.

import { PramenDO } from "./durable-object";
import { app } from "../example/app";
import { authorizeTenant, HmacStrategy, isAdmin, JwksStrategy, resolveIdentity, type VerifyStrategy } from "./auth";
import { dispatch } from "./runtime/dispatch";
import { migrate } from "./runtime/migrate";
import { compileAcl } from "./runtime/acl";
import { D1Driver, type Driver } from "./runtime/driver";
import { toResponse } from "./runtime/errors";
import { Kv } from "./runtime/kv";
import { createFiles, handleFileRequest, R2Adapter } from "./runtime/storage";
import type { Identity } from "./sdk/acl";

export interface Env {
  PRAMEN: DurableObjectNamespace;
  /** Project KV — tenant registry (`tenant:` keys) + handler ctx.kv (`app:` keys). */
  KV: KVNamespace;
  /** HMAC secret for verifying HS256 bearer JWTs. Dev value in wrangler.jsonc;
   * production via `wrangler secret put AUTH_SECRET`. Ignored if JWKS_URL is set. */
  AUTH_SECRET: string;
  /** Optional: a JWKS endpoint. When set, tokens are verified as RS256 against the
   * fetched public keys (HmacStrategy/AUTH_SECRET is bypassed). */
  JWKS_URL?: string;
  /** D1 binding. Enables the "Worker + D1 (no DO)" path — the same schema/ACL/read
   * engine over D1 instead of a Durable Object. Selected per-request via
   * `x-pramen-store: d1`. RPC only (live queries need the DO). */
  DB?: D1Database;
  /** R2 bucket backing file storage (ctx.files + the /files/* route). */
  FILES: R2Bucket;
  /** HMAC secret for signing file tokens. Falls back to AUTH_SECRET if unset. */
  FILES_SECRET?: string;
}

/** The secret used to sign/verify file tokens — a dedicated FILES_SECRET if set,
 * else AUTH_SECRET (so HS256 setups work out of the box). */
const filesSecret = (env: Env): string => env.FILES_SECRET || env.AUTH_SECRET;

// JwksStrategy caches fetched public keys, so keep one instance per isolate (keyed
// by URL) rather than rebuilding it per request. HmacStrategy is stateless.
let jwks: JwksStrategy | undefined;
function strategyFor(env: Env): VerifyStrategy {
  if (env.JWKS_URL) {
    if (!jwks || jwks.url !== env.JWKS_URL) jwks = new JwksStrategy(env.JWKS_URL);
    return jwks;
  }
  return new HmacStrategy(env.AUTH_SECRET);
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const forbidden = (what: string) => json({ ok: false, error: `access denied: ${what}`, code: "forbidden" }, 403);
const badRequest = (msg: string) => json({ ok: false, error: msg, code: "bad_request" }, 400);

// ACL is compiled once per isolate; the Worker's D1 path reuses it (the DO compiles
// its own). Schema migration over D1 runs once per isolate (and short-circuits on a
// stored schema hash thereafter); a failed run is not cached.
const d1Acl = compileAcl(app.acl ?? []);
let d1Ready: Promise<void> | undefined;
function ensureD1Migrated(driver: Driver): Promise<void> {
  if (!d1Ready) {
    d1Ready = migrate(driver, app.schema)
      .then(() => undefined)
      .catch((e) => {
        d1Ready = undefined;
        throw e;
      });
  }
  return d1Ready;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // File upload/download stream through the Worker (bytes never touch the DO),
    // authorized purely by the HMAC token in the url — no JWT/tenant routing.
    if (url.pathname.startsWith("/files/")) {
      const res = await handleFileRequest(request, { adapter: new R2Adapter(env.FILES), secret: filesSecret(env) });
      if (res) return res;
    }

    const isWs = request.headers.get("Upgrade") === "websocket";

    // Browser WebSockets can't set headers, so /live accepts the bearer token and
    // tenant via the query string; fold them into headers for the rest of the flow.
    let req = request;
    if (isWs) {
      const h = new Headers(request.headers);
      const qToken = url.searchParams.get("token");
      if (qToken && !h.get("authorization")) h.set("authorization", `Bearer ${qToken}`);
      const qTenant = url.searchParams.get("tenant");
      if (qTenant && !h.get("x-pramen-tenant")) h.set("x-pramen-tenant", qTenant);
      req = new Request(request, { headers: h });
    }

    const identity = await resolveIdentity(req, strategyFor(env));

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
      const stub = env.PRAMEN.get(env.PRAMEN.idFromName(body.tenant));
      const internal = new Request("https://do/__recover", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pramen-tenant": body.tenant },
        body: JSON.stringify({ timestamp: body.timestamp }),
      });
      return stub.fetch(internal);
    }

    // --- admin: a tenant's applied schema (hash + tables) ---
    if (url.pathname === "/admin/schema") {
      if (!isAdmin(identity)) return forbidden("schema");
      const tenant = url.searchParams.get("tenant") ?? "main";
      const stub = env.PRAMEN.get(env.PRAMEN.idFromName(tenant));
      return stub.fetch(new Request("https://do/__schema", { headers: { "x-pramen-tenant": tenant } }));
    }

    const isRpc = url.pathname.startsWith("/rpc/");
    const isLive = url.pathname === "/live";

    if (!isRpc && !(isLive && isWs)) {
      return new Response(
        "pramen — POST /rpc/<handler> (JSON body), or WebSocket /live for live queries. " +
          "Header X-Pramen-Tenant selects the store (default: main). " +
          "Admin: GET /tenants, POST /admin/recover {tenant,timestamp}, GET /admin/schema?tenant=.\n",
        { headers: { "content-type": "text/plain" } },
      );
    }

    // Authorize the tenant against the identity before reaching the DO, so a
    // caller can't address (or register) tenants they have no claim to.
    const tenant = req.headers.get("x-pramen-tenant") ?? "main";
    if (!authorizeTenant(identity, tenant)) return forbidden(`tenant '${tenant}'`);

    // --- Worker + D1 (no DO): the same schema/ACL/read engine over a D1 binding,
    // selected per-request via `x-pramen-store: d1`. RPC only — live queries need the
    // DO (single writer + a socket host). This proof uses ONE shared D1 database
    // across tenants; a real product would add a tenant column or a per-tenant DB.
    if (req.headers.get("x-pramen-store") === "d1") {
      if (!env.DB) return badRequest("D1 store is not configured");
      if (isLive) return badRequest("live queries require the default (DO) store");
      const name = url.pathname.replace(/^\/rpc\//, "");
      let input: unknown;
      if (request.method === "POST") input = await request.json().catch(() => undefined);
      const driver = new D1Driver(env.DB);
      const files = createFiles({ tenant, secret: filesSecret(env), adapter: new R2Adapter(env.FILES) });
      try {
        await ensureD1Migrated(driver);
        const { result } = await dispatch(app.handlers, app.schema, driver, new Kv(env.KV), files, { acl: d1Acl, identity }, name, input);
        return json({ ok: true, result });
      } catch (err) {
        const { status, body } = toResponse(err);
        return json(body, status);
      }
    }

    // Forward a trusted identity to the DO (the DO never re-derives it).
    const headers = new Headers(req.headers);
    if (identity) headers.set("x-pramen-identity", JSON.stringify(identity as Identity));
    else headers.delete("x-pramen-identity");

    const stub = env.PRAMEN.get(env.PRAMEN.idFromName(tenant));
    return stub.fetch(new Request(req, { headers }));
  },
};

export { PramenDO };
