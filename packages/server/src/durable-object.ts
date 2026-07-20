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
import { createMail } from "./runtime/mail";
import { createQueue } from "./runtime/queue";
import { ensureOutbox, drainOutbox, listTasks } from "./runtime/outbox";
import { Db } from "./runtime/db";
import { digest } from "./runtime/digest";
import { compileAcl, type AclContext, type CompiledAcl } from "./runtime/acl";
import { DoSqliteDriver, type Driver } from "./runtime/driver";
import { BadRequest, Unauthorized, toResponse, toWsError } from "./runtime/errors";
import { Kv } from "./runtime/kv";
import { registryKey } from "./runtime/registry";
import { DEFAULT_PARTITION } from "./sdk/schema";
import { createFiles, R2Adapter, type Files } from "./runtime/storage";
import type { Identity } from "./sdk/acl";
import type { HandlerContext } from "./sdk/handlers";
import type { PramenApp } from "./pramen";
import type { ClientMsg, ServerMsg, Subscription } from "./runtime/protocol";

/** Durable per-socket state — kept SMALL and stable, since it rides the WebSocket
 * attachment which workerd caps at ~2 KB. Only auth/routing identity lives here so it
 * survives hibernation; the (potentially large) subscription list does NOT — see
 * `subsBySocket`. */
interface SocketAttachment {
  identity: Identity | null;
  /** Tenant fixed at connect time (survives hibernation via the attachment). */
  tenant: string;
  /** Partition fixed at connect time (read from x-pramen-partition at upgrade);
   * survives hibernation via the attachment, like `tenant`. */
  partition: string;
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

/** WebSocket close code for an auth failure (RFC 6455 leaves 4000-4999 to the app;
 * 4401 mirrors HTTP 401). Sent when a socket's token has expired since upgrade. */
const WS_CLOSE_UNAUTHORIZED = 4401;

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
  /** Live subscriptions per socket — held IN MEMORY, not in the WS attachment. The
   * attachment is capped at ~2 KB by workerd, and 64 subs (each with arbitrary input
   * JSON + a read-set + digest) blow past that well before MAX_SUBSCRIPTIONS. The
   * tradeoff: this map is lost on DO hibernation/eviction, so a woken socket has no
   * entry and is treated as having no active subscriptions — acceptable because the
   * client replays its subscriptions on (re)connect. Keyed by the WebSocket object;
   * cleaned up in webSocketClose. */
  private readonly subsBySocket = new Map<WebSocket, Subscription[]>();

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
      await this.runBootstrap(); // converge code-defined reference data (default partition only)
      this.migrated = true;
    });
  }

  // Run app.bootstrap() once per DO lifetime, right after migration and inside the same
  // blockConcurrencyWhile block, so the first request sees a converged store and two
  // concurrent first fetches can't double-run it. Default partition ONLY: reference data
  // (content types, roles, …) lives in the default partition, and a non-default DO doesn't
  // own those tables (a write would trip assertInPartition). A failing reconciler is logged
  // and swallowed — unlike migrate(), it must never brick a tenant's boot; it retries next
  // boot. Uses a SYSTEM-scoped Db (ACL bypassed) with triggers suppressed (a boot-time seed
  // shouldn't fan out reactive side-effects).
  private async runBootstrap(): Promise<void> {
    const fns = this.app.bootstrap;
    if (!fns?.length || this.partition !== DEFAULT_PARTITION) return;
    const db = new Db(
      this.driver,
      { acl: this.acl, identity: { roles: ["admin"] }, system: true, partition: this.partition, schema: this.app.schema, suppressTriggers: true },
      this.app.schema,
    );
    for (const fn of fns) {
      try {
        await this.driver.transaction(() => Promise.resolve(fn({ db, driver: this.driver, schema: this.app.schema, partition: this.partition })));
      } catch (e) {
        console.error(`[pramen] bootstrap failed (partition=${this.partition}):`, e);
      }
    }
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
      this.setAttachment(server, { identity, tenant: this.tenant, partition: this.partition });
      this.subsBySocket.set(server, []);
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
      // Arm the drain BEFORE broadcasting so enqueued tasks are always scheduled even
      // if broadcast has trouble (broadcast is best-effort and never throws — a failed
      // push must not 500 a COMMITTED write nor skip the alarm).
      if (enqueued > 0) await this.armDrain();
      if (kind === "mutation" && touched.length > 0) await this.broadcast(touched);
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
   * Task handlers get full db access + env (e.g. ctx.env.EMAIL) + their own ctx.tasks.
   * Returns the `db` alongside the ctx so the drainer can broadcast the tables the task
   * handlers touched (live queries would otherwise go stale after deferred/trigger work). */
  private taskCtx(): { ctx: HandlerContext; db: Db } {
    const identity: Identity = { roles: ["admin"] };
    const db = new Db(
      this.driver,
      { acl: this.acl, identity, system: true, schema: this.app.schema, partition: this.partition, suppressTriggers: true },
      this.app.schema,
    );
    const ctx: HandlerContext = {
      db,
      kv: this.kv,
      files: this.filesFor(this.tenant),
      env: this.envBag,
      identity,
      tasks: tasksFacade(this.driver),
      mail: createMail(this.envBag, this.kv),
      queue: createQueue(this.envBag),
    };
    return { ctx, db };
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
   * (manual / cron). Returns the drain stats incl. `nextRunAt` for rescheduling, plus
   * the union of tables the drained task handlers touched (for a post-commit broadcast). */
  private async drainTasks(): Promise<{ result: Awaited<ReturnType<typeof drainOutbox>>; touched: string[] }> {
    await ensureOutbox(this.driver); // idempotent — the table may predate this instance (cold alarm)
    const { ctx, db } = this.taskCtx();
    const result = await drainOutbox(this.driver, bindTasks(this.app.tasks, ctx), Date.now());
    return { result, touched: [...db.touched] };
  }

  override async alarm(): Promise<void> {
    await this.loadIdentity(); // cold wake: restore tenant/partition before building taskCtx
    // A post-deploy cold alarm may run against the old schema — reconcile it first, or a
    // task handler writing a new column dead-letters. loadIdentity() restored the partition.
    await this.ensureMigrated();
    const { result, touched } = await this.drainTasks();
    // Deferred/triggered writes are invisible to live queries unless we broadcast the
    // tables the task handlers touched (post-commit — the drain has already committed).
    if (touched.length > 0) await this.broadcast(touched);
    // Reschedule to the NEXT task's due time (a backed-off retry, or the next batch if
    // the drain hit its limit) so a failed task can't stall waiting for a new enqueue.
    if (result.nextRunAt != null) await this.ctx.storage.setAlarm(Math.max(result.nextRunAt, Date.now() + 250));
  }

  private async handleDrain(): Promise<Response> {
    await this.loadIdentity();
    const { result, touched } = await this.drainTasks();
    if (touched.length > 0) await this.broadcast(touched);
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
    const att = this.getAttachment(ws);
    this.tenant = att.tenant;
    this.partition = att.partition;

    // The token was verified ONCE at upgrade; a live/hibernating socket can outlive its
    // TTL. Re-check `exp` per message so an expired session can't keep calling/subscribing
    // (role changes + the denylist only bite on reconnect, which this forces). Fail the
    // frame and close 4401 so the client re-auths. Synthetic identities carry no exp.
    if (this.isExpired(att.identity)) return this.rejectExpired(ws, msg.id);

    await this.ensureMigrated();

    switch (msg.type) {
      case "subscribe":
        return this.onSubscribe(ws, msg.id, msg.name, msg.input);
      case "unsubscribe":
        this.setSubs(ws, this.getSubs(ws).filter((s) => s.id !== msg.id));
        return;
      case "call":
        return this.onCall(ws, msg.id, msg.name, msg.input);
      default:
        return this.send(ws, { type: "error", id: "", error: "unknown message type" });
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.subsBySocket.delete(ws); // release the in-memory subscription list for this socket
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
    const att = this.getAttachment(ws);
    const subs = this.getSubs(ws);
    try {
      const replacing = subs.some((s) => s.id === id);
      if (!replacing && subs.length >= MAX_SUBSCRIPTIONS) {
        return this.send(ws, toWsError(id, new BadRequest("subscription limit reached")));
      }
      const { result, kind, touched } = await dispatch(this.app.handlers, this.app.schema, this.driver, this.kv, this.filesFor(att.tenant), this.envBag, this.ctxFor(att.identity, att.partition), name, input);
      if (kind !== "query") {
        return this.send(ws, toWsError(id, new BadRequest(`${name} is not a query`)));
      }
      const next = subs.filter((s) => s.id !== id);
      next.push({ id, name, input, tables: touched, digest: digest(result) });
      this.setSubs(ws, next);
      this.send(ws, { type: "data", id, result });
    } catch (err) {
      this.send(ws, toWsError(id, err));
    }
  }

  private async onCall(ws: WebSocket, id: string, name: string, input: unknown): Promise<void> {
    const att = this.getAttachment(ws);
    let outcome: Awaited<ReturnType<typeof dispatch>>;
    try {
      outcome = await dispatch(this.app.handlers, this.app.schema, this.driver, this.kv, this.filesFor(att.tenant), this.envBag, this.ctxFor(att.identity, att.partition), name, input);
    } catch (err) {
      return this.send(ws, toWsError(id, err));
    }
    // The mutation is committed — send its result FIRST, then run post-commit
    // side-effects that must never turn a committed write into a spurious error frame:
    // arm the drain (independent of broadcast), then broadcast (best-effort, never throws).
    const { result, kind, touched, enqueued } = outcome;
    this.send(ws, { type: "result", id, result });
    if (enqueued > 0) await this.armDrain();
    if (kind === "mutation" && touched.length > 0) await this.broadcast(touched);
  }

  // Re-run every subscription whose read-set intersects the written tables, each
  // under its own socket's identity, and push only when its result changed. Best-effort:
  // a failure for one subscription or socket is logged and skipped — it must NEVER throw,
  // because it runs after a mutation has committed (a throw here would 500 that write).
  private async broadcast(touched: string[]): Promise<void> {
    const written = new Set(touched);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = this.getAttachment(ws);
        // A live socket whose token expired while connected must not keep receiving pushes.
        // Close it 4401 and drop its subscriptions instead of pushing (an expired hibernating
        // socket already has no in-memory subs, so this only bites still-live ones).
        if (this.isExpired(att.identity)) {
          try {
            ws.close(WS_CLOSE_UNAUTHORIZED, "session expired");
          } catch {
            /* already closing */
          }
          this.subsBySocket.delete(ws);
          continue;
        }
        const subs = this.getSubs(ws);
        let dirty = false;
        for (const sub of subs) {
          if (!sub.tables.some((t) => written.has(t))) continue;
          try {
            const { result } = await dispatch(this.app.handlers, this.app.schema, this.driver, this.kv, this.filesFor(att.tenant), this.envBag, this.ctxFor(att.identity, att.partition), sub.name, sub.input);
            const next = digest(result);
            if (next === sub.digest) continue; // result unchanged for this subscription
            sub.digest = next;
            dirty = true;
            this.send(ws, { type: "data", id: sub.id, result });
          } catch (err) {
            // One subscription failing (re-dispatch error, or a send to a dead socket)
            // must not abort the other subs — surface it to that sub, swallow otherwise.
            try {
              this.send(ws, toWsError(sub.id, err));
            } catch {
              /* socket already gone */
            }
          }
        }
        if (dirty) this.setSubs(ws, subs);
      } catch (err) {
        // A bad socket must not stop the loop over the others.
        console.error("pramen: broadcast to a socket failed", err);
      }
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
          // Resolve the PK from the schema — a custom-PK table (e.g. auth_users keyed on
          // `username`) has no `id` column, so a hardcoded `{ id }` would 500.
          result = (await db.find({ from: table, where: { [db.pkOf(table)]: b.id }, limit: 1 }))[0] ?? null;
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
      // Admin-data writes fire triggers too — arm the drain if any task was enqueued
      // (independent of broadcast), then broadcast the touched tables to live queries.
      if (mutated && db.taskEnqueues > 0) await this.armDrain();
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

  /** Has this socket's token expired? `exp` (epoch seconds) rides the socket attachment
   * from the upgrade-time identity. A synthetic / non-expiring identity has no `exp` and is
   * never expired, so callPrivileged and admin sockets keep working. */
  private isExpired(identity: Identity | null): boolean {
    const exp = identity?.exp;
    return typeof exp === "number" && Date.now() / 1000 >= exp;
  }

  /** Reject a message from an expired socket: send the protocol's auth-failure error frame,
   * then close 4401 (the client should re-authenticate and reconnect). */
  private rejectExpired(ws: WebSocket, id: string): void {
    this.send(ws, toWsError(id, new Unauthorized("session expired")));
    try {
      ws.close(WS_CLOSE_UNAUTHORIZED, "session expired");
    } catch {
      /* already closing */
    }
  }

  /** The durable per-socket auth/routing state (identity + tenant + partition), read
   * from the WS attachment. Survives hibernation; kept tiny to stay under workerd's cap. */
  private getAttachment(ws: WebSocket): SocketAttachment {
    return (
      (ws.deserializeAttachment() as SocketAttachment | null) ?? {
        identity: null,
        tenant: this.tenant,
        partition: this.partition,
      }
    );
  }

  private setAttachment(ws: WebSocket, att: SocketAttachment): void {
    ws.serializeAttachment(att);
  }

  /** This socket's live subscriptions from the in-memory map (see `subsBySocket`). A
   * hibernated/woken socket has no entry → no active subscriptions until the client
   * replays them on reconnect. */
  private getSubs(ws: WebSocket): Subscription[] {
    return this.subsBySocket.get(ws) ?? [];
  }

  private setSubs(ws: WebSocket, subs: Subscription[]): void {
    this.subsBySocket.set(ws, subs);
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
