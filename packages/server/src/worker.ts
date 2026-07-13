// makeWorker(app) — builds the stateless HTTP front door bound to an app. It
// authenticates the request, authorizes the tenant, and routes /rpc/<handler> and
// /live to the per-tenant Durable Object, plus the /files/* route and admin
// endpoints (/tenants, /admin/recover, /admin/schema). createPramen() pairs the
// returned fetch with the matching DO class; a consumer just re-exports both.

import { authorizeTenant, HmacStrategy, isAdmin, JwksStrategy, resolveIdentity, type VerifyOptions, type VerifyStrategy } from "./auth";
import { dispatch, tasksFacade, bindTasks } from "./runtime/dispatch";
import { ensureOutbox, drainOutbox, listTasks } from "./runtime/outbox";
import { createMail } from "./runtime/mail";
import { createQueue, type QueueProducerBinding } from "./runtime/queue";
import { dispatchQueueBatch, type QueueBatch, type QueueContext } from "./runtime/queue-consumer";
import { migrate } from "./runtime/migrate";
import { compileAcl } from "./runtime/acl";
import { Db } from "./runtime/db";
import { D1Driver, type D1SessionStart, type Driver } from "./runtime/driver";
import { toResponse } from "./runtime/errors";
import { Kv } from "./runtime/kv";
import { listDOs, partitionDoName } from "./runtime/registry";
import { createFiles, handleFileRequest, handleMediaRequest, R2Adapter } from "./runtime/storage";
import type { Identity } from "./sdk/acl";
import type { HandlerContext } from "./sdk/handlers";
import { DEFAULT_PARTITION, partitionsOf } from "./sdk/schema";
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
  /** "true" to REJECT any bearer token with no numeric `exp` claim. Off by default
   * (a token without exp is accepted) so existing issuers keep working; turn it on to
   * refuse non-expiring tokens. Applies to both the HS256 and JWKS strategies. */
  AUTH_REQUIRE_EXP?: string;
  /** Optional required audience. When set, a token's `aud` (string or array) must
   * contain this value or the token is rejected. Unset ⇒ `aud` is not checked. */
  AUTH_AUDIENCE?: string;
  /** Optional required issuer. When set, a token's `iss` must equal this exactly.
   * Unset ⇒ `iss` is not checked. */
  AUTH_ISSUER?: string;
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
  /** Default store for /rpc when no `x-pramen-store` header is sent: `"d1"` runs the
   * Worker+D1 path by default (requires DB bound); `"do"` (the default) routes to the
   * per-tenant Durable Object. The header still overrides per-request. /live always
   * needs the DO regardless of this setting. */
  PRAMEN_STORE?: string;
  /** "true" to allow the shared D1 store to serve a non-`main` tenant. OFF by default:
   * the D1 proof uses ONE database with no tenant column, so multiple tenants would
   * commingle. Only set this if the app genuinely single-tenants that D1 (or has added
   * its own tenant isolation). */
  PRAMEN_D1_ALLOW_MULTITENANT?: string;
  /** Cloudflare Queues producer binding for ctx.queue (declared in oblaka.ts). Optional —
   * ctx.queue discovers any producer binding by name; this just types the common one. */
  JOBS?: QueueProducerBinding;
}

/** The secret used to sign/verify file tokens — a dedicated FILES_SECRET if set,
 * else AUTH_SECRET (so HS256 setups work out of the box). */
const filesSecret = (env: Env): string => env.FILES_SECRET || env.AUTH_SECRET;

/** Request/response header carrying the D1 session bookmark for read-your-writes: a
 * client echoes the last response's value on its next request, anchoring a fresh
 * session at that write so it reads its own writes (even off a lagging replica). */
const D1_BOOKMARK_HEADER = "x-pramen-d1-bookmark";

/** Decide whether an /rpc request runs on the D1 store. **Live queries ALWAYS use the
 * DO** (they need a single writer + a socket host), regardless of header or default —
 * so enabling `PRAMEN_STORE=d1` never silently breaks `/live`. Otherwise an explicit
 * `x-pramen-store` header wins (`d1`/`do`), then the `PRAMEN_STORE` default. Pure +
 * exported for unit testing. */
export function useD1Store(opts: { storeHeader: string | null; isLive: boolean; defaultStore: string | undefined }): boolean {
  if (opts.isLive) return false; // live is DO-only — never the D1 path
  if (opts.storeHeader === "d1") return true;
  if (opts.storeHeader === "do") return false;
  return opts.defaultStore === "d1";
}

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
    "access-control-allow-headers": "content-type, authorization, x-pramen-tenant, x-pramen-store, x-pramen-d1-bookmark",
    // Cache the preflight so a browser doesn't re-OPTIONS every /rpc/<name> path. 7200s is
    // Chrome's cap; without it each RPC pays an extra round trip after the ~5s default.
    "access-control-max-age": "7200",
    // Expose the D1 read-your-writes bookmark so a browser client can read it off the
    // response and carry it forward on the next request.
    "access-control-expose-headers": "x-pramen-d1-bookmark",
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

/** Resolve the Durable Object stub for a `(tenant, partition)`. The DO name comes from
 * `partitionDoName`, so routing and the registry stay in lockstep: it returns the BARE
 * `tenant` for the default partition (so `idFromName(tenant)` is byte-for-byte unchanged
 * — backward-compat) and `${tenant}:${partition}` for any other partition. */
function partitionStubFor(env: Env, tenant: string, partition: string = DEFAULT_PARTITION): DurableObjectStub {
  // Fail with a clear message rather than a cryptic `Cannot read 'get' of undefined`
  // when the Durable Object isn't bound (e.g. a D1-only deployment that fell through to
  // the DO path). The Worker RPC surface depends on this binding existing.
  if (!env.PRAMEN) {
    throw new Error(
      "pramen: no Durable Object bound (PRAMEN). Pin the D1 store per request with the " +
        "'x-pramen-store: d1' header (or set PRAMEN_STORE=d1), or bind the PramenDO.",
    );
  }
  return env.PRAMEN.get(env.PRAMEN.idFromName(partitionDoName(tenant, partition)));
}

/** Forward a privileged mutation into a tenant's DO from a public route. The
 * synthetic identity (default `["admin"]`) is trusted because the call originates
 * in the Worker — the same internal mechanism the admin endpoints use. Returns the
 * DO's JSON response (`{ ok, result }` / `{ ok: false, … }`). */
export async function callPrivileged(
  env: Env,
  opts: { name: string; input?: unknown; tenant?: string; roles?: string[]; partition?: string },
): Promise<Response> {
  const tenant = opts.tenant ?? "main";
  const partition = opts.partition ?? DEFAULT_PARTITION;
  const stub = partitionStubFor(env, tenant, partition);
  return stub.fetch(
    new Request(`https://do/rpc/${opts.name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pramen-tenant": tenant,
        "x-pramen-partition": partition,
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
  // Opt-in claim validation from env — default OFF (unset) so existing tokens keep
  // verifying. Threaded into whichever strategy the deployment uses.
  const verifyOptsFor = (env: Env): VerifyOptions => ({
    requireExp: env.AUTH_REQUIRE_EXP === "true",
    audience: env.AUTH_AUDIENCE || undefined,
    issuer: env.AUTH_ISSUER || undefined,
  });
  const strategyFor = (env: Env): VerifyStrategy => {
    const opts = verifyOptsFor(env);
    if (env.JWKS_URL) {
      if (!jwks || jwks.url !== env.JWKS_URL) jwks = new JwksStrategy(env.JWKS_URL, undefined, opts);
      return jwks;
    }
    return new HmacStrategy(env.AUTH_SECRET, opts);
  };

  // ACL is compiled once per isolate; the Worker's D1 path reuses it (the DO compiles
  // its own). Schema migration over D1 runs once per isolate (and short-circuits on a
  // stored schema hash thereafter); a failed run is not cached.
  const d1Acl = compileAcl(app.acl ?? []);

  // Converge code-defined reference data on the D1 path — the mirror of the DO's
  // runBootstrap(), run once per isolate after migration. D1 is a single shared store (no
  // partition split), so every reconciler runs under the default partition. SYSTEM-scoped
  // Db (ACL bypassed), triggers suppressed; a failing reconciler is logged, never fatal.
  const runBootstrapD1 = async (driver: Driver): Promise<void> => {
    const fns = app.bootstrap;
    if (!fns?.length) return;
    const db = new Db(driver, { acl: d1Acl, identity: { roles: ["admin"] }, system: true, schema: app.schema, suppressTriggers: true }, app.schema);
    for (const fn of fns) {
      try {
        await driver.transaction(() => Promise.resolve(fn({ db, driver, schema: app.schema, partition: DEFAULT_PARTITION })));
      } catch (e) {
        console.error("[pramen] bootstrap failed (d1):", e);
      }
    }
  };

  let d1Ready: Promise<void> | undefined;
  const ensureD1Migrated = (driver: Driver, allowDestructive: boolean): Promise<void> => {
    if (!d1Ready) {
      d1Ready = migrate(driver, app.schema, { allowDestructive })
        .then(() => ensureOutbox(driver)) // the deferred-tasks table also lives in D1
        .then(() => runBootstrapD1(driver)) // converge code-defined reference data
        .then(() => undefined)
        .catch((e) => {
          d1Ready = undefined;
          throw e;
        });
    }
    return d1Ready;
  };

  // A privileged, system-scoped context for running task handlers on the D1 (Worker)
  // path — mirrors the DO's taskCtx. No live socket, so no DO; drained by a Cron / the
  // /admin/tasks/drain route, never a DO alarm.
  const d1TaskCtx = (driver: Driver, env: Env): HandlerContext => {
    const identity: Identity = { roles: ["admin"] };
    const files = createFiles({ tenant: "main", secret: filesSecret(env), adapter: new R2Adapter(env.FILES) });
    const db = new Db(driver, { acl: d1Acl, identity, system: true, schema: app.schema, suppressTriggers: true }, app.schema);
    const kv = new Kv(env.KV);
    return { db, kv, files, env: env as unknown as Record<string, unknown>, identity, tasks: tasksFacade(driver), mail: createMail(env as unknown as Record<string, unknown>, kv), queue: createQueue(env as unknown as Record<string, unknown>) };
  };

  /** Drain the D1 outbox in the Worker (no DO/alarm on this path) — called by the
   * /admin/tasks/drain route with `x-pramen-store: d1`, and by `scheduled()` (Cron). */
  const drainD1 = async (env: Env): Promise<unknown> => {
    if (!env.DB) throw new Error("D1 store is not configured");
    // The drain reads due tasks then writes their status — pin the primary so it sees
    // and updates current outbox state (not a lagging replica).
    const driver = new D1Driver(env.DB, { start: "first-primary" });
    await ensureD1Migrated(driver, env.PRAMEN_ALLOW_DESTRUCTIVE === "true");
    return drainOutbox(driver, bindTasks(app.tasks, d1TaskCtx(driver, env)), Date.now());
  };

  const listD1Tasks = async (env: Env, status?: string, limit?: number): Promise<unknown> => {
    if (!env.DB) throw new Error("D1 store is not configured");
    // Inspection listing — pin the primary so it reflects current outbox state.
    const driver = new D1Driver(env.DB, { start: "first-primary" });
    await ensureD1Migrated(driver, env.PRAMEN_ALLOW_DESTRUCTIVE === "true");
    return listTasks(driver, { status, limit });
  };

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // File upload/download stream through the Worker (bytes never touch the DO),
    // authorized purely by the HMAC token in the url — no JWT/tenant routing.
    if (url.pathname.startsWith("/files/")) {
      const res = await handleFileRequest(request, { adapter: new R2Adapter(env.FILES), secret: filesSecret(env) });
      if (res) return res;
    }

    // Public media serving: `GET /media/<tenant>/media/<key>` streams a CMS media blob
    // from R2 (cache-friendly, no auth — published-site assets are public). Put Cloudflare
    // Image Resizing (/cdn-cgi/image) in front for transforms. Restricted to media keys.
    if (url.pathname.startsWith("/media/") && env.FILES) {
      const res = await handleMediaRequest(request, { adapter: new R2Adapter(env.FILES) });
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
      // A single socket lives in one partition (cross-partition live is out of scope);
      // accept it via ?partition= and default to the default partition.
      const qPartition = url.searchParams.get("partition");
      if (!h.get("x-pramen-partition")) h.set("x-pramen-partition", qPartition || DEFAULT_PARTITION);
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
      const body = (await request.json().catch(() => ({}))) as { tenant?: unknown; timestamp?: unknown; partition?: unknown };
      if (typeof body.tenant !== "string" || !body.tenant) return badRequest("tenant required");
      if (typeof body.timestamp !== "number" && typeof body.timestamp !== "string") return badRequest("timestamp required");
      const partition = typeof body.partition === "string" && body.partition ? body.partition : DEFAULT_PARTITION;
      const stub = partitionStubFor(env, body.tenant, partition);
      const internal = new Request("https://do/__recover", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pramen-tenant": body.tenant, "x-pramen-partition": partition },
        body: JSON.stringify({ timestamp: body.timestamp }),
      });
      return stub.fetch(internal);
    }

    // --- admin: a tenant's applied schema (hash + tables) ---
    if (url.pathname === "/admin/schema") {
      if (!isAdmin(identity)) return withCors(forbidden("schema"), cors);
      const tenant = url.searchParams.get("tenant") ?? "main";
      const partition = url.searchParams.get("partition") || DEFAULT_PARTITION;
      const stub = partitionStubFor(env, tenant, partition);
      const res = await stub.fetch(
        new Request("https://do/__schema", { headers: { "x-pramen-tenant": tenant, "x-pramen-partition": partition } }),
      );
      return withCors(res, cors);
    }

    // --- admin: generic data ops over a tenant's tables (browse/edit any row).
    // Body: { tenant, table, op: list|get|create|update|delete|count, ... }. Runs
    // in the DO under SYSTEM scope (ACL bypassed) — gated to admins here. ---
    if (url.pathname === "/admin/data" && request.method === "POST") {
      if (!isAdmin(identity)) return forbidden("data");
      const body = (await request.json().catch(() => ({}))) as { tenant?: unknown; partition?: unknown };
      const tenant = typeof body.tenant === "string" && body.tenant ? body.tenant : "main";
      const partition = typeof body.partition === "string" && body.partition ? body.partition : DEFAULT_PARTITION;
      const stub = partitionStubFor(env, tenant, partition);
      const res = await stub.fetch(
        new Request("https://do/__admin/data", {
          method: "POST",
          headers: { "content-type": "application/json", "x-pramen-tenant": tenant, "x-pramen-partition": partition },
          body: JSON.stringify(body),
        }),
      );
      return withCors(res, cors);
    }

    // --- admin: drain the deferred-task outbox now (the DO also self-drains via an
    // alarm; this is the manual / Cron entry, and the ONLY drain for the D1 path).
    // `x-pramen-store: d1` drains the D1 outbox in the Worker; else the tenant's DO. ---
    if (url.pathname === "/admin/tasks/drain" && request.method === "POST") {
      if (!isAdmin(identity)) return forbidden("tasks");
      if (request.headers.get("x-pramen-store") === "d1") {
        try {
          return withCors(json({ ok: true, result: await drainD1(env) }), cors);
        } catch (err) {
          const { status, body } = toResponse(err);
          return withCors(json(body, status), cors);
        }
      }
      const body = (await request.json().catch(() => ({}))) as { tenant?: unknown; partition?: unknown };
      const tenant = typeof body.tenant === "string" && body.tenant ? body.tenant : "main";
      const partition = typeof body.partition === "string" && body.partition ? body.partition : DEFAULT_PARTITION;
      const stub = partitionStubFor(env, tenant, partition);
      const res = await stub.fetch(
        new Request("https://do/__admin/tasks/drain", {
          method: "POST",
          headers: { "content-type": "application/json", "x-pramen-tenant": tenant, "x-pramen-partition": partition },
        }),
      );
      return withCors(res, cors);
    }

    // --- admin: list outbox tasks (inspect dead-letters etc.). ?status=&limit=,
    // ?tenant=&partition= (DO store) or x-pramen-store: d1 (Worker outbox). ---
    if (url.pathname === "/admin/tasks/list") {
      if (!isAdmin(identity)) return withCors(forbidden("tasks"), cors);
      const status = url.searchParams.get("status") ?? undefined;
      const limit = Number(url.searchParams.get("limit")) || undefined;
      if (request.headers.get("x-pramen-store") === "d1") {
        try {
          return withCors(json({ ok: true, result: await listD1Tasks(env, status, limit) }), cors);
        } catch (err) {
          const { status: s, body } = toResponse(err);
          return withCors(json(body, s), cors);
        }
      }
      const tenant = url.searchParams.get("tenant") ?? "main";
      const partition = url.searchParams.get("partition") || DEFAULT_PARTITION;
      const q = new URLSearchParams();
      if (status) q.set("status", status);
      if (limit) q.set("limit", String(limit));
      const stub = partitionStubFor(env, tenant, partition);
      const res = await stub.fetch(
        new Request(`https://do/__admin/tasks/list?${q}`, {
          headers: { "x-pramen-tenant": tenant, "x-pramen-partition": partition },
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
          "Admin (optional partition selects the partition DO, default: " + DEFAULT_PARTITION + "): " +
          "GET /tenants, POST /admin/recover {tenant,timestamp,partition?}, GET /admin/schema?tenant=&partition=, " +
          "POST /admin/data {tenant,table,op,partition?}.\n",
        { headers: { "content-type": "text/plain" } },
      );
    }

    // Authorize the tenant against the identity before reaching the DO, so a
    // caller can't address (or register) tenants they have no claim to.
    const tenant = req.headers.get("x-pramen-tenant") ?? "main";
    if (!authorizeTenant(identity, tenant)) return withCors(forbidden(`tenant '${tenant}'`), cors);

    // --- Worker + D1 (no DO): the same schema/ACL/read engine over a D1 binding.
    // Selected per-request via `x-pramen-store: d1`, OR as the app-wide default when
    // PRAMEN_STORE=d1 (the header still overrides: `x-pramen-store: do` forces the DO).
    // RPC only — live queries need the DO (single writer + a socket host). This proof
    // uses ONE shared D1 database across tenants; a real product would add a tenant
    // column or a per-tenant DB.
    const storeHeader = req.headers.get("x-pramen-store");
    const useD1 = useD1Store({ storeHeader, isLive, defaultStore: env.PRAMEN_STORE });
    if (useD1) {
      if (!env.DB) return badRequest("D1 store is not configured");
      // COMMINGLING GUARD: this D1 path is ONE shared database with no tenant column, so
      // every tenant's rows live together. Selecting it for a non-`main` tenant (a
      // multi-tenant scenario) would leak/mix tenants — and `PRAMEN_STORE=d1` makes it a
      // silent global default. Fail closed unless the operator explicitly opts in.
      if (tenant !== "main" && env.PRAMEN_D1_ALLOW_MULTITENANT !== "true") {
        return withCors(
          forbidden(`D1 store for tenant '${tenant}' (shared D1 has no tenant isolation — set PRAMEN_D1_ALLOW_MULTITENANT=true to allow)`),
          cors,
        );
      }
      // (isLive is excluded by useD1Store — live always routes to the DO below.)
      const name = url.pathname.replace(/^\/rpc\//, "");
      let input: unknown;
      if (request.method === "POST") input = await request.json().catch(() => undefined);

      // Pick where the D1 session may start its first read. A mutation ALWAYS pins the
      // primary (`first-primary` is a superset of read-your-writes) so a read-modify-write
      // can't run off a lagging replica — an inbound bookmark must not widen that window.
      // A query honors a client-supplied bookmark (read-your-writes), else the nearest replica.
      const inboundBookmark = req.headers.get(D1_BOOKMARK_HEADER);
      const kind = app.handlers[name]?.kind;
      let start: D1SessionStart;
      if (kind === "mutation") start = "first-primary";
      else if (inboundBookmark) start = inboundBookmark;
      else start = "first-unconstrained";

      const driver = new D1Driver(env.DB, { start });
      const files = createFiles({ tenant, secret: filesSecret(env), adapter: new R2Adapter(env.FILES) });
      const envBag = env as unknown as Record<string, unknown>;
      try {
        await ensureD1Migrated(driver, env.PRAMEN_ALLOW_DESTRUCTIVE === "true");
        const { result, enqueued } = await dispatch(app.handlers, app.schema, driver, new Kv(env.KV), files, envBag, { acl: d1Acl, identity }, name, input);
        // Kick an immediate drain in the request tail when this handler enqueued tasks
        // (e.g. sendMagicLinkEmail). Without this, tasks wait for the next Cron trigger
        // — up to a full minute. `waitUntil` lets the response return now while the
        // drain runs; the Cron trigger remains the safety net for delayed / retried
        // tasks that no request happens to coincide with.
        if (enqueued > 0) ctx.waitUntil(drainD1(env));
        const res = json({ ok: true, result });
        // Thread the session's latest bookmark back so the client can read its own writes.
        const bookmark = driver.getBookmark();
        if (bookmark) res.headers.set(D1_BOOKMARK_HEADER, bookmark);
        return withCors(res, cors);
      } catch (err) {
        const { status, body } = toResponse(err);
        return withCors(json(body, status), cors);
      }
    }

    // Resolve the partition to route to. For /rpc it's declared statically on the
    // handler; for /live it's the socket's partition (already folded into the header
    // from ?partition=). Forward it to the DO in x-pramen-partition either way.
    let partition: string;
    if (isRpc) {
      const name = url.pathname.replace(/^\/rpc\//, "");
      partition = app.handlers[name]?.partition ?? DEFAULT_PARTITION;
    } else {
      // /live's partition is client-supplied (?partition= / x-pramen-partition), so
      // validate it against the schema's known partitions BEFORE routing — otherwise an
      // anonymous caller could spin up unbounded junk DOs + permanent registry KV keys.
      partition = req.headers.get("x-pramen-partition") || DEFAULT_PARTITION;
      if (!partitionsOf(app.schema).includes(partition)) {
        return withCors(badRequest(`unknown partition '${partition}'`), cors);
      }
    }

    // Forward a trusted identity to the DO (the DO never re-derives it). Also set the
    // tenant header so the DO learns its own name — without it, `main` (the default when
    // the client omits x-pramen-tenant) never registers and re-runs its guard forever.
    const headers = new Headers(req.headers);
    if (identity) headers.set("x-pramen-identity", JSON.stringify(identity as Identity));
    else headers.delete("x-pramen-identity");
    headers.set("x-pramen-tenant", tenant);
    headers.set("x-pramen-partition", partition);

    // Routed to the DO but no DO is bound — return a clear, actionable error instead of
    // crashing the whole RPC surface. (A D1-only deployment should pin the D1 store with
    // the `x-pramen-store: d1` header; the `PRAMEN_STORE` env default can be dropped by
    // some adapters' env proxies, so the header is the reliable way to pin it.)
    if (!env.PRAMEN) {
      return withCors(
        badRequest(
          isLive
            ? "live queries require a Durable Object, but no PRAMEN binding is configured"
            : "no Durable Object (PRAMEN) is bound — pin the D1 store with the 'x-pramen-store: d1' header (or bind the DO)",
        ),
        cors,
      );
    }

    const stub = partitionStubFor(env, tenant, partition);
    // WebSocket upgrades (101) must be returned untouched; only add CORS to HTTP.
    const res = await stub.fetch(new Request(req, { headers }));
    return isWs ? res : withCors(res, cors);
    },

    // Cron Trigger entry: drains the D1 outbox (the DO path self-drains via an alarm,
    // so it needs no cron). Wire a `[triggers] crons` in wrangler/oblaka to call this.
    async scheduled(_event: unknown, env: Env): Promise<void> {
      if (env.DB) await drainD1(env);
    },

    // Cloudflare Queues consumer entry: routes a batch to the matching `app.queues`
    // handler (ACK on success / RETRY on throw, per message). A consumer is Worker-level
    // (no tenant DO): its ctx carries env/kv/mail/queue + callPrivileged to reach a DO.
    async queue(batch: QueueBatch, env: Env): Promise<void> {
      const envBag = env as unknown as Record<string, unknown>;
      const kv = new Kv(env.KV);
      const ctx: QueueContext = {
        env: envBag,
        kv,
        mail: createMail(envBag, kv),
        queue: createQueue(envBag),
        callPrivileged: (opts) => callPrivileged(env, opts),
      };
      await dispatchQueueBatch(app.queues ?? {}, ctx, batch);
    },
  };
}
