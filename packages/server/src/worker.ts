// makeWorker(app) — builds the stateless HTTP front door bound to an app. It
// authenticates the request, authorizes the tenant, and routes /rpc/<handler> and
// /live to the per-tenant Durable Object, plus the /files/* route and admin
// endpoints (/tenants, /admin/recover, /admin/schema). createPramen() pairs the
// returned fetch with the matching DO class; a consumer just re-exports both.

import { authorizeTenant, HmacStrategy, isAdmin, JwksStrategy, resolveIdentity, type VerifyStrategy } from "./auth";
import { dispatch } from "./runtime/dispatch";
import { migrate } from "./runtime/migrate";
import { compileAcl } from "./runtime/acl";
import { D1Driver, type Driver } from "./runtime/driver";
import { toResponse } from "./runtime/errors";
import { Kv } from "./runtime/kv";
import { listDOs } from "./runtime/registry";
import { createFiles, handleFileRequest, R2Adapter } from "./runtime/storage";
import type { Identity } from "./sdk/acl";
import type { PramenApp } from "./pramen";

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
  /** Optional CORS allowlist for /rpc + /live: comma-separated origins, or `*`.
   * Unset = no CORS headers (same-origin only). Lets a browser client call a
   * cross-origin Worker directly (e.g. a separate dev port). */
  CORS_ORIGINS?: string;
  /** "true" to apply destructive schema migrations on the D1 path. Off by default. */
  PRAMEN_ALLOW_DESTRUCTIVE?: string;
}

/** The secret used to sign/verify file tokens — a dedicated FILES_SECRET if set,
 * else AUTH_SECRET (so HS256 setups work out of the box). */
const filesSecret = (env: Env): string => env.FILES_SECRET || env.AUTH_SECRET;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const forbidden = (what: string) => json({ ok: false, error: `access denied: ${what}`, code: "forbidden" }, 403);
const badRequest = (msg: string) => json({ ok: false, error: msg, code: "bad_request" }, 400);

/** CORS response headers for an allowed origin, or `{}` when CORS is off / the
 * origin isn't allowlisted. Authorization is a request header, never a cookie, so
 * `*` is safe (no credentials mode). */
function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  if (!origin || !env.CORS_ORIGINS) return {};
  const allow = env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allow.includes("*") && !allow.includes(origin)) return {};
  return {
    "access-control-allow-origin": allow.includes("*") ? "*" : origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-pramen-tenant, x-pramen-store",
    vary: "origin",
  };
}

/** Return a copy of `res` with the CORS headers merged in (no-op if none). */
function withCors(res: Response, cors: Record<string, string>): Response {
  if (Object.keys(cors).length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Forward a privileged mutation into a tenant's DO from a public route. The
 * synthetic identity (default `["admin"]`) is trusted because the call originates
 * in the Worker — the same internal mechanism the admin endpoints use. Returns the
 * DO's JSON response (`{ ok, result }` / `{ ok: false, … }`). */
export async function callPrivileged(
  env: Env,
  opts: { name: string; input?: unknown; tenant?: string; roles?: string[] },
): Promise<Response> {
  const tenant = opts.tenant ?? "main";
  const stub = env.PRAMEN.get(env.PRAMEN.idFromName(tenant));
  return stub.fetch(
    new Request(`https://do/rpc/${opts.name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pramen-tenant": tenant,
        "x-pramen-identity": JSON.stringify({ roles: opts.roles ?? ["admin"] }),
      },
      body: JSON.stringify(opts.input ?? {}),
    }),
  );
}

/** Build the Worker fetch handler for an app. State (the JWKS cache, the D1
 * compiled-ACL + one-time migration) is per-app, held in this closure. */
export function makeWorker(app: PramenApp) {
  // JwksStrategy caches fetched public keys, so keep one instance per isolate (keyed
  // by URL) rather than rebuilding it per request. HmacStrategy is stateless.
  let jwks: JwksStrategy | undefined;
  const strategyFor = (env: Env): VerifyStrategy => {
    if (env.JWKS_URL) {
      if (!jwks || jwks.url !== env.JWKS_URL) jwks = new JwksStrategy(env.JWKS_URL);
      return jwks;
    }
    return new HmacStrategy(env.AUTH_SECRET);
  };

  // ACL is compiled once per isolate; the Worker's D1 path reuses it (the DO compiles
  // its own). Schema migration over D1 runs once per isolate (and short-circuits on a
  // stored schema hash thereafter); a failed run is not cached.
  const d1Acl = compileAcl(app.acl ?? []);
  let d1Ready: Promise<void> | undefined;
  const ensureD1Migrated = (driver: Driver, allowDestructive: boolean): Promise<void> => {
    if (!d1Ready) {
      d1Ready = migrate(driver, app.schema, { allowDestructive })
        .then(() => undefined)
        .catch((e) => {
          d1Ready = undefined;
          throw e;
        });
    }
    return d1Ready;
  };

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // File upload/download stream through the Worker (bytes never touch the DO),
    // authorized purely by the HMAC token in the url — no JWT/tenant routing.
    if (url.pathname.startsWith("/files/")) {
      const res = await handleFileRequest(request, { adapter: new R2Adapter(env.FILES), secret: filesSecret(env) });
      if (res) return res;
    }

    // Public (pre-auth) routes — matched before identity resolution, so a
    // signature-authed webhook can live outside the JWT-gated /rpc surface.
    for (const r of app.routes ?? []) {
      if (request.method === r.method && url.pathname === r.path) {
        const routeCtx = { callPrivileged: (opts: Parameters<typeof callPrivileged>[1]) => callPrivileged(env, opts) };
        return r.handler(request, env as unknown as Record<string, unknown>, routeCtx);
      }
    }

    // CORS (opt-in via CORS_ORIGINS) for cross-origin browser clients. Answer the
    // preflight before any auth so the actual request can carry the bearer token.
    const cors = corsHeaders(request.headers.get("origin"), env);
    if (request.method === "OPTIONS" && Object.keys(cors).length > 0) {
      return new Response(null, { status: 204, headers: cors });
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

    // --- admin: list known (tenant, partition) DOs from the registry ---
    if (url.pathname === "/tenants") {
      if (!isAdmin(identity)) return withCors(forbidden("tenants"), cors);
      const result = await listDOs(env.KV);
      return withCors(json({ ok: true, result }), cors);
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
      if (!isAdmin(identity)) return withCors(forbidden("schema"), cors);
      const tenant = url.searchParams.get("tenant") ?? "main";
      const stub = env.PRAMEN.get(env.PRAMEN.idFromName(tenant));
      const res = await stub.fetch(new Request("https://do/__schema", { headers: { "x-pramen-tenant": tenant } }));
      return withCors(res, cors);
    }

    // --- admin: generic data ops over a tenant's tables (browse/edit any row).
    // Body: { tenant, table, op: list|get|create|update|delete|count, ... }. Runs
    // in the DO under SYSTEM scope (ACL bypassed) — gated to admins here. ---
    if (url.pathname === "/admin/data" && request.method === "POST") {
      if (!isAdmin(identity)) return forbidden("data");
      const body = (await request.json().catch(() => ({}))) as { tenant?: unknown };
      const tenant = typeof body.tenant === "string" && body.tenant ? body.tenant : "main";
      const stub = env.PRAMEN.get(env.PRAMEN.idFromName(tenant));
      const res = await stub.fetch(
        new Request("https://do/__admin/data", {
          method: "POST",
          headers: { "content-type": "application/json", "x-pramen-tenant": tenant },
          body: JSON.stringify(body),
        }),
      );
      return withCors(res, cors);
    }

    const isRpc = url.pathname.startsWith("/rpc/");
    const isLive = url.pathname === "/live";

    if (!isRpc && !(isLive && isWs)) {
      return new Response(
        "pramen — POST /rpc/<handler> (JSON body), or WebSocket /live for live queries. " +
          "Header X-Pramen-Tenant selects the store (default: main). " +
          "Admin: GET /tenants, POST /admin/recover {tenant,timestamp}, GET /admin/schema?tenant=, " +
          "POST /admin/data {tenant,table,op}.\n",
        { headers: { "content-type": "text/plain" } },
      );
    }

    // Authorize the tenant against the identity before reaching the DO, so a
    // caller can't address (or register) tenants they have no claim to.
    const tenant = req.headers.get("x-pramen-tenant") ?? "main";
    if (!authorizeTenant(identity, tenant)) return withCors(forbidden(`tenant '${tenant}'`), cors);

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
      const envBag = env as unknown as Record<string, unknown>;
      try {
        await ensureD1Migrated(driver, env.PRAMEN_ALLOW_DESTRUCTIVE === "true");
        const { result } = await dispatch(app.handlers, app.schema, driver, new Kv(env.KV), files, envBag, { acl: d1Acl, identity }, name, input);
        return withCors(json({ ok: true, result }), cors);
      } catch (err) {
        const { status, body } = toResponse(err);
        return withCors(json(body, status), cors);
      }
    }

    // Forward a trusted identity to the DO (the DO never re-derives it).
    const headers = new Headers(req.headers);
    if (identity) headers.set("x-pramen-identity", JSON.stringify(identity as Identity));
    else headers.delete("x-pramen-identity");

    const stub = env.PRAMEN.get(env.PRAMEN.idFromName(tenant));
    // WebSocket upgrades (101) must be returned untouched; only add CORS to HTTP.
    const res = await stub.fetch(new Request(req, { headers }));
    return isWs ? res : withCors(res, cors);
    },
  };
}
