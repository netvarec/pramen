// PramenDOBase — the database. One instance per tenant (see worker.ts routing).
// Holds the SQLite store in-process, applies the schema on boot, dispatches
// handler RPCs over HTTP, and serves live queries over WebSockets. The concrete,
// app-bound class is produced by pramenDO(app) (and createPramen) — the DO can't
// take constructor args beyond (ctx, env), so the app is closed over.
//
// ACL: policies are compiled once on boot. Identity is resolved by the Worker
// and forwarded in the X-Pramen-Identity header. For HTTP it's per request; for a
// WebSocket it's fixed at connect time and stored on the socket, so live queries
// are evaluated per-identity (row-level scopes apply to pushes too).
//
// Reactivity: the DO is the single writer, so it sees every mutation. After a
// mutation commits we re-run each subscription whose read-set intersects the
// written tables, but push only when that subscription's result actually changed
// (digest diff). Connections use Hibernatable WebSockets; per-socket state
// (identity + subscriptions) is stored via serializeAttachment().

import { DurableObject } from "cloudflare:workers";
import { migrate } from "./runtime/migrate";
import { dispatch, tasksFacade, bindTasks } from "./runtime/dispatch";
import { ensureOutbox, drainOutbox, listTasks } from "./runtime/outbox";
import { Db } from "./runtime/db";
import { digest } from "./runtime/digest";
import { compileAcl, type AclContext, type CompiledAcl } from "./runtime/acl";
import { DoSqliteDriver, type Driver } from "./runtime/driver";
import { BadRequest, toResponse, toWsError } from "./runtime/errors";
import { Kv } from "./runtime/kv";
import { registryKey } from "./runtime/registry";
import { DEFAULT_PARTITION } from "./sdk/schema";
import { createFiles, R2Adapter, type Files } from "./runtime/storage";
import type { Identity } from "./sdk/acl";
import type { HandlerContext } from "./sdk/handlers";
import type { PramenApp } from "./pramen";
import type { ClientMsg, ServerMsg, Subscription } from "./runtime/protocol";

interface SocketState {
  identity: Identity | null;
  /** Tenant fixed at connect time (survives hibernation via the attachment). */
  tenant: string;
  /** Partition fixed at connect time (read from x-pramen-partition at upgrade);
   * survives hibernation via the attachment, like `tenant`. */
  partition: string;
  subs: Subscription[];
}

export interface DoEnv {
  /** Project KV — tenant registry (`tenant:`) + handler ctx.kv (`app:`). */
  KV: KVNamespace;
  /** R2 bucket backing ctx.files + the Worker /files/* route. */
  FILES: R2Bucket;
  /** HMAC secret for signing file upload/download tokens (falls back to AUTH_SECRET). */
  FILES_SECRET?: string;
  /** Bearer-JWT secret; also the fallback for signing file tokens. */
  AUTH_SECRET?: string;
  /** "true" to apply destructive schema migrations (drop/rebuild/type-change). Off by
   * default — data-loss is gated behind this explicit opt-in. */
  PRAMEN_ALLOW_DESTRUCTIVE?: string;
}

/** Per-socket subscription cap — bounds memory and per-mutation re-run cost. */
const MAX_SUBSCRIPTIONS = 64;

export class PramenDOBase extends DurableObject<DoEnv> {
  private readonly app: PramenApp;
  private readonly acl: CompiledAcl;
  private readonly kv: Kv;
  private readonly driver: Driver;
  private registered = false;
  /** Tenant this DO serves (one per idFromName). Learned from the Worker-forwarded
   * x-pramen-tenant header; defaults to "main". */
  private tenant = "main";
  /** Partition this DO serves (one per idFromName(partitionDoName)). Learned from the
   * Worker-forwarded x-pramen-partition header on the first fetch; defaults to the
   * default partition (a single-partition app, or a stray request with no header). */
  private partition = DEFAULT_PARTITION;
  /** Boot migration runs on the FIRST fetch (once the partition is known), not in the
   * constructor — see `ensureMigrated`. Guards against re-running. */
  private migrated = false;
  private files?: Files;
  /** Have we persisted (tenant, partition) to DO storage this instance? They're
   * persisted so a COLD alarm wake (no request header) can build a correctly-scoped
   * task context — a DO can't introspect its own idFromName. */
  private identityPersisted = false;
  private identityLoaded = false;

  constructor(ctx: DurableObjectState, env: DoEnv, app: PramenApp) {
    super(ctx, env);
    this.app = app;
    this.acl = compileAcl(this.app.acl ?? []);
    this.kv = new Kv(env.KV); // app:-prefixed, handed to handlers as ctx.kv

    // The data layer runs over a Driver. The DO's store is its own in-process SQLite;
    // the D1 substrate (D1Driver) lives in the Worker (the "Worker + D1, no DO" path).
    this.driver = new DoSqliteDriver(ctx.storage);

    // NOTE: the boot migration is NOT run here. The constructor cannot know which
    // partition this DO serves — that arrives in the x-pramen-partition header on the
    // first request, after construction. Migrating the full schema here would create
    // OTHER partitions' tables in this DO (defeating partition isolation), so we defer
    // the partition-scoped migrate() to the first fetch (`ensureMigrated`), guarded by
    // ctx.blockConcurrencyWhile so concurrent first requests can't double-migrate.
  }

  // Reconcile this partition's tables with the schema before the first request is
  // served. Runs once per DO lifetime: the `migrated` flag + blockConcurrencyWhile
  // serialize concurrent first fetches (the platform queues other requests while the
  // block runs), so two in-flight first requests can't both migrate. Scoped to
  // this.partition — only this partition's tables are created/altered (migrate()
  // never touches other partitions' tables). Wrapped in a transaction so a partial
  // migration can't leave a half-rebuilt table. This preserves the single-partition
  // (default) behavior exactly: a default DO migrates its full default-partition
  // schema, just lazily on first touch instead of in the constructor.
  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return;
    const allowDestructive = this.env.PRAMEN_ALLOW_DESTRUCTIVE === "true";
    const partition = this.partition;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.migrated) return; // a concurrent first request already migrated
      await this.driver.transaction(() =>
        migrate(this.driver, this.app.schema, { allowDestructive, partition }).then(() => {}),
      );
      await ensureOutbox(this.driver); // the deferred-tasks table (internal, all partitions)
      this.migrated = true;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const tenantHeader = request.headers.get("x-pramen-tenant");
    if (tenantHeader) this.tenant = tenantHeader;
    // Learn the partition before the boot migration so it migrates the right subset.
    // Absent header (shouldn't happen post-routing) -> default partition.
    const partitionHeader = request.headers.get("x-pramen-partition");
    if (partitionHeader) this.partition = partitionHeader;

    await this.ensureMigrated();
    await this.ensureRegistered(request);
    // Persist (tenant, partition) once per instance so a cold alarm can rebuild the
    // right task context (it has no request header to learn them from). Stored in the
    // SQL store (_pramen_meta), NOT ctx.storage.put — mixing the KV-style storage API
    // with raw `PRAGMA` trips workerd's DO SQLite authorizer (SQLITE_AUTH).
    if (!this.identityPersisted) {
      await this.driver.exec(
        `INSERT OR REPLACE INTO _pramen_meta (key, value) VALUES (?, ?), (?, ?)`,
        ["_pramen_tenant", this.tenant, "_pramen_partition", this.partition].map((v) => this.driver.dialect.encode(v)),
      );
      this.identityPersisted = true;
      this.identityLoaded = true;
    }

    const path = new URL(request.url).pathname;
    if (path === "/__recover") return this.handleRecover(request);
    if (path === "/__schema") return this.handleSchema();
    if (path === "/__admin/data") return this.handleAdminData(request);
    if (path === "/__admin/tasks/drain") return this.handleDrain();
    if (path === "/__admin/tasks/list") return this.handleTasksList(request);

    const identity = this.identityOf(request);

    if (request.headers.get("Upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server); // hibernatable
      this.setState(server, { identity, tenant: this.tenant, partition: this.partition, subs: [] });
      return new Response(null, { status: 101, webSocket: client });
    }

    const name = new URL(request.url).pathname.replace(/^\/rpc\//, "");
    let input: unknown;
    if (request.method === "POST") {
      input = await request.json().catch(() => undefined);
    }

    try {
      const { result, kind, touched, enqueued } = await dispatch(
        this.app.handlers,
        this.app.schema,
        this.driver,
        this.kv,
        this.filesFor(this.tenant),
        this.envBag,
        this.ctxFor(identity),
        name,
        input,
      );
      if (kind === "mutation" && touched.length > 0) await this.broadcast(touched);
      if (enqueued > 0) await this.armDrain();
      return Response.json({ ok: true, result });
    } catch (err) {
      const { status, body } = toResponse(err);
      return Response.json(body, { status });
    }
  }

  /** Arm the drain alarm soon after a mutation enqueued task(s). setAlarm replaces any
   * pending alarm; a near-future time batches a burst of enqueues into one drain. */
  private async armDrain(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 50);
  }

  /** A privileged, system-scoped context for running task handlers (outside a request).
   * Task handlers get full db access + env (e.g. ctx.env.EMAIL) + their own ctx.tasks. */
  private taskCtx(): HandlerContext {
    const identity: Identity = { roles: ["admin"] };
    const db = new Db(
      this.driver,
      { acl: this.acl, identity, system: true, schema: this.app.schema, partition: this.partition, suppressTriggers: true },
      this.app.schema,
    );
    return { db, kv: this.kv, files: this.filesFor(this.tenant), env: this.envBag, identity, tasks: tasksFacade(this.driver) };
  }

  /** Restore (tenant, partition) on a cold wake (e.g. an alarm with no request) so the
   * task context is scoped correctly. No-op once loaded/persisted this instance. */
  private async loadIdentity(): Promise<void> {
    if (this.identityLoaded) return;
    // _pramen_meta exists: an alarm only fires after a fetch armed it, and that fetch
    // ran the boot migration which creates the table.
    const rows = (await this.driver.exec(
      `SELECT key, value FROM _pramen_meta WHERE key IN ('_pramen_tenant', '_pramen_partition')`,
      [],
    )) as { key: string; value: string }[];
    for (const r of rows) {
      if (r.key === "_pramen_tenant" && r.value) this.tenant = r.value;
      if (r.key === "_pramen_partition" && r.value) this.partition = r.value;
    }
    this.identityLoaded = true;
  }

  /** Drain due tasks. Called by the alarm (DO path) and the /__admin/tasks/drain route
   * (manual / cron). Returns the drain stats incl. `nextRunAt` for rescheduling. */
  private async drainTasks(): Promise<Awaited<ReturnType<typeof drainOutbox>>> {
    await ensureOutbox(this.driver); // idempotent — the table may predate this instance (cold alarm)
    return drainOutbox(this.driver, bindTasks(this.app.tasks, this.taskCtx()), Date.now());
  }

  override async alarm(): Promise<void> {
    await this.loadIdentity(); // cold wake: restore tenant/partition before building taskCtx
    const { nextRunAt } = await this.drainTasks();
    // Reschedule to the NEXT task's due time (a backed-off retry, or the next batch if
    // the drain hit its limit) so a failed task can't stall waiting for a new enqueue.
    if (nextRunAt != null) await this.ctx.storage.setAlarm(Math.max(nextRunAt, Date.now() + 250));
  }

  private async handleDrain(): Promise<Response> {
    await this.loadIdentity();
    const result = await this.drainTasks();
    // Keep the alarm honest even when drained manually: ensure a backed-off retry wakes.
    if (result.nextRunAt != null) await this.ctx.storage.setAlarm(Math.max(result.nextRunAt, Date.now() + 250));
    return Response.json({ ok: true, result });
  }

  private async handleTasksList(request: Request): Promise<Response> {
    await ensureOutbox(this.driver);
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const limit = Number(url.searchParams.get("limit")) || undefined;
    return Response.json({ ok: true, result: await listTasks(this.driver, { status, limit }) });
  }

  // --- Hibernatable WebSocket handlers ---

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, { type: "error", id: "", error: "invalid JSON" });
    }

    // A hibernated DO can be reconstructed and routed here WITHOUT fetch() running
    // again, so the boot migration may not have run on this fresh instance. Adopt this
    // socket's (tenant, partition) — fixed at connect time, survives via the attachment
    // — and ensure the schema is migrated before any handler/ctx.db work. Idempotent
    // (the `migrated` flag), so a no-op after the first call.
    const { tenant, partition } = this.getState(ws);
    this.tenant = tenant;
    this.partition = partition;
    await this.ensureMigrated();

    switch (msg.type) {
      case "subscribe":
        return this.onSubscribe(ws, msg.id, msg.name, msg.input);
      case "unsubscribe": {
        const state = this.getState(ws);
        this.setState(ws, { ...state, subs: state.subs.filter((s) => s.id !== msg.id) });
        return;
      }
      case "call":
        return this.onCall(ws, msg.id, msg.name, msg.input);
      default:
        return this.send(ws, { type: "error", id: "", error: "unknown message type" });
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("pramen: websocket error", error);
    try {
      ws.close(1011, "error");
    } catch {
      /* already closing */
    }
  }

  // --- live-query internals ---

  private async onSubscribe(ws: WebSocket, id: string, name: string, input: unknown): Promise<void> {
    const state = this.getState(ws);
    try {
      const replacing = state.subs.some((s) => s.id === id);
      if (!replacing && state.subs.length >= MAX_SUBSCRIPTIONS) {
        return this.send(ws, toWsError(id, new BadRequest("subscription limit reached")));
      }
      const { result, kind, touched } = await dispatch(this.app.handlers, this.app.schema, this.driver, this.kv, this.filesFor(state.tenant), this.envBag, this.ctxFor(state.identity, state.partition), name, input);
      if (kind !== "query") {
        return this.send(ws, toWsError(id, new BadRequest(`${name} is not a query`)));
      }
      const subs = state.subs.filter((s) => s.id !== id);
      subs.push({ id, name, input, tables: touched, digest: digest(result) });
      this.setState(ws, { ...state, subs });
      this.send(ws, { type: "data", id, result });
    } catch (err) {
      this.send(ws, toWsError(id, err));
    }
  }

  private async onCall(ws: WebSocket, id: string, name: string, input: unknown): Promise<void> {
    const state = this.getState(ws);
    try {
      const { result, kind, touched, enqueued } = await dispatch(this.app.handlers, this.app.schema, this.driver, this.kv, this.filesFor(state.tenant), this.envBag, this.ctxFor(state.identity, state.partition), name, input);
      this.send(ws, { type: "result", id, result });
      if (kind === "mutation" && touched.length > 0) await this.broadcast(touched);
      if (enqueued > 0) await this.armDrain();
    } catch (err) {
      this.send(ws, toWsError(id, err));
    }
  }

  // Re-run every subscription whose read-set intersects the written tables, each
  // under its own socket's identity, and push only when its result changed.
  private async broadcast(touched: string[]): Promise<void> {
    const written = new Set(touched);
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.getState(ws);
      let dirty = false;
      for (const sub of state.subs) {
        if (!sub.tables.some((t) => written.has(t))) continue;
        try {
          const { result } = await dispatch(this.app.handlers, this.app.schema, this.driver, this.kv, this.filesFor(state.tenant), this.envBag, this.ctxFor(state.identity, state.partition), sub.name, sub.input);
          const next = digest(result);
          if (next === sub.digest) continue; // result unchanged for this subscription
          sub.digest = next;
          dirty = true;
          this.send(ws, { type: "data", id: sub.id, result });
        } catch (err) {
          this.send(ws, toWsError(sub.id, err));
        }
      }
      if (dirty) this.setState(ws, state);
    }
  }

  // --- helpers ---

  // A DO addressed by idFromName(tenant) doesn't know its own name — the Worker
  // forwards it. On the first touch ever (guarded by a persisted meta flag), the
  // tenant records itself in the registry KV so it stays discoverable. Exactly
  // one KV write per tenant across its whole lifetime.
  private async ensureRegistered(request: Request): Promise<void> {
    if (this.registered) return;
    const name = request.headers.get("x-pramen-tenant");
    if (!name) return;

    const seen = await this.driver.exec(`SELECT 1 FROM _pramen_meta WHERE key = 'registered'`, []);
    if (seen.length > 0) {
      this.registered = true;
      return;
    }
    // Record under this DO's real (tenant, partition): the default partition keeps the
    // bare `tenant:<name>` key (backward-compat), a non-default one is `tenant:<name>:<p>`.
    await this.env.KV.put(registryKey(name, this.partition), JSON.stringify({ firstSeen: Date.now() }));
    await this.driver.exec(`INSERT OR REPLACE INTO _pramen_meta (key, value) VALUES ('registered', ?)`, [name]);
    this.registered = true;
  }

  // Point-in-time recovery (admin-gated at the Worker). Arms a restore to the
  // given time and returns the `undo` bookmark (the point just before recovery,
  // so the operation is reversible). We intentionally do NOT call ctx.abort()
  // here, so this response can return the undo bookmark — the restore completes
  // when the DO next restarts. PITR is unavailable in local dev (no change-log).
  private async handleRecover(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { timestamp?: unknown };
    const ts = typeof body.timestamp === "number" ? body.timestamp : Date.parse(String(body.timestamp));
    if (!Number.isFinite(ts)) {
      return Response.json({ ok: false, error: "invalid timestamp", code: "bad_request" }, { status: 400 });
    }

    const storage = this.ctx.storage as unknown as {
      getBookmarkForTime?: (t: number) => Promise<string>;
      onNextSessionRestoreBookmark?: (b: string) => Promise<string>;
    };

    try {
      const bookmark = await storage.getBookmarkForTime!(ts);
      const undo = await storage.onNextSessionRestoreBookmark!(bookmark);
      return Response.json({ ok: true, result: { restoredTo: ts, bookmark, undo, applied: false } });
    } catch (err) {
      // PITR is a platform feature — unavailable in local dev, and can otherwise
      // fail operationally. Report 501 (not a generic 500); log the real reason.
      console.error("pramen: recovery unavailable", err);
      return Response.json(
        { ok: false, error: "point-in-time recovery is unavailable in this environment", code: "unavailable" },
        { status: 501 },
      );
    }
  }

  // Introspection: this tenant's applied schema hash + table/column shape (admin-gated
  // at the Worker). Powers the CLI's `schema status`. Both are read from _pramen_meta
  // (written by migrate on boot) — NOT a request-time `PRAGMA`/introspection: once the
  // DO-storage alarm API has run in this object, workerd's SQLite authorizer rejects
  // PRAGMA (SQLITE_AUTH), so the outbox's alarm would otherwise break this endpoint.
  private async handleSchema(): Promise<Response> {
    const hashKey = `schema_hash:${this.partition}`;
    const tablesKey = `schema_tables:${this.partition}`;
    const rows = (await this.driver.exec(`SELECT key, value FROM _pramen_meta WHERE key IN (?, ?)`, [
      hashKey,
      tablesKey,
    ])) as { key: string; value: string }[];
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const tables = byKey.has(tablesKey) ? (JSON.parse(byKey.get(tablesKey)!) as Record<string, string[]>) : {};
    return Response.json({ ok: true, result: { hash: byKey.get(hashKey) ?? null, tables } });
  }

  // Generic admin data ops (admin-gated at the Worker). Runs through a SYSTEM-mode
  // Db, so ACL is bypassed — admin can browse/edit any row of any table — while the
  // json/fileRef codec, transactions, and live-query broadcast still apply.
  private async handleAdminData(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const table = typeof b.table === "string" ? b.table : "";
    const op = typeof b.op === "string" ? b.op : "";
    if (!table || !(table in this.app.schema)) {
      return Response.json({ ok: false, error: "unknown table", code: "bad_request" }, { status: 400 });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new Db(this.driver, { acl: this.acl, identity: null, system: true, partition: this.partition }, this.app.schema) as any;
    try {
      let result: unknown;
      let mutated = false;
      switch (op) {
        case "list":
          result = await db.find({ from: table, where: b.where, orderBy: b.orderBy, limit: b.limit, offset: b.offset });
          break;
        case "count":
          result = await db.count({ from: table, where: b.where });
          break;
        case "get":
          result = (await db.find({ from: table, where: { id: b.id }, limit: 1 }))[0] ?? null;
          break;
        case "create":
          result = await this.driver.transaction(() => db.insert(table, b.values));
          mutated = true;
          break;
        case "update":
          result = (await this.driver.transaction(() => db.update(table, b.id, b.patch))) ?? null;
          mutated = true;
          break;
        case "delete":
          result = await this.driver.transaction(() => db.delete(table, b.id));
          mutated = true;
          break;
        default:
          return Response.json({ ok: false, error: `unknown op: ${op}`, code: "bad_request" }, { status: 400 });
      }
      if (mutated && db.touched.size > 0) await this.broadcast([...db.touched]);
      return Response.json({ ok: true, result });
    } catch (err) {
      const { status, body } = toResponse(err);
      return Response.json(body, { status });
    }
  }

  private ctxFor(identity: Identity | null, partition: string = this.partition): AclContext {
    // Carry the schema so any consumer of this context (not just Db) can compile
    // relation-aware `where` rules into subqueries, and the active partition so Db's
    // table-access guard rejects any table outside this DO's partition.
    return { acl: this.acl, identity, schema: this.app.schema, partition };
  }

  // The DO env (bindings + vars + secrets) handed to handlers as ctx.env. Loosely
  // typed at the boundary so handlers can read any var/secret without a DoEnv cast.
  private get envBag(): Readonly<Record<string, unknown>> {
    return this.env as unknown as Record<string, unknown>;
  }

  // One Files facade per DO (a DO serves one tenant). Backed by the R2 binding;
  // signing uses FILES_SECRET. Handlers mint signed urls; the bytes never enter here.
  private filesFor(tenant: string): Files {
    if (!this.files) {
      const secret = this.env.FILES_SECRET || this.env.AUTH_SECRET || "";
      this.files = createFiles({ tenant, secret, adapter: new R2Adapter(this.env.FILES) });
    }
    return this.files;
  }

  private identityOf(request: Request): Identity | null {
    const raw = request.headers.get("x-pramen-identity");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Identity;
    } catch {
      return null;
    }
  }

  private getState(ws: WebSocket): SocketState {
    return (
      (ws.deserializeAttachment() as SocketState | null) ?? {
        identity: null,
        tenant: this.tenant,
        partition: this.partition,
        subs: [],
      }
    );
  }

  private setState(ws: WebSocket, state: SocketState): void {
    ws.serializeAttachment(state);
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    ws.send(JSON.stringify(msg));
  }
}

/** Produce the concrete, app-bound Durable Object class. A DO is constructed by the
 * platform with just (ctx, env), so the app is closed over here. Re-export the
 * result from your Worker entry under the class name wrangler expects ("PramenDO"). */
export function pramenDO(app: PramenApp): typeof PramenDOBase {
  return class PramenDO extends PramenDOBase {
    constructor(ctx: DurableObjectState, env: DoEnv) {
      super(ctx, env, app);
    }
  };
}
