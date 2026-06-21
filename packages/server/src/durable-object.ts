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
import { dispatch } from "./runtime/dispatch";
import { Db } from "./runtime/db";
import { digest } from "./runtime/digest";
import { compileAcl, type AclContext, type CompiledAcl } from "./runtime/acl";
import { DoSqliteDriver, type Driver } from "./runtime/driver";
import { BadRequest, toResponse, toWsError } from "./runtime/errors";
import { Kv } from "./runtime/kv";
import { createFiles, R2Adapter, type Files } from "./runtime/storage";
import type { Identity } from "./sdk/acl";
import type { PramenApp } from "./pramen";
import type { ClientMsg, ServerMsg, Subscription } from "./runtime/protocol";

interface SocketState {
  identity: Identity | null;
  /** Tenant fixed at connect time (survives hibernation via the attachment). */
  tenant: string;
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
  private files?: Files;

  constructor(ctx: DurableObjectState, env: DoEnv, app: PramenApp) {
    super(ctx, env);
    this.app = app;
    this.acl = compileAcl(this.app.acl ?? []);
    this.kv = new Kv(env.KV); // app:-prefixed, handed to handlers as ctx.kv

    // The data layer runs over a Driver. The DO's store is its own in-process SQLite;
    // the D1 substrate (D1Driver) lives in the Worker (the "Worker + D1, no DO" path).
    this.driver = new DoSqliteDriver(ctx.storage);

    // Reconcile the store with the schema before any request is served (create/alter
    // tables; destructive changes rebuild the table). Wrapped in a transaction so a
    // partial migration can't leave a half-rebuilt table.
    const allowDestructive = env.PRAMEN_ALLOW_DESTRUCTIVE === "true";
    ctx.blockConcurrencyWhile(() =>
      this.driver.transaction(() => migrate(this.driver, this.app.schema, { allowDestructive }).then(() => {})),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureRegistered(request);
    const tenantHeader = request.headers.get("x-pramen-tenant");
    if (tenantHeader) this.tenant = tenantHeader;

    const path = new URL(request.url).pathname;
    if (path === "/__recover") return this.handleRecover(request);
    if (path === "/__schema") return this.handleSchema();
    if (path === "/__admin/data") return this.handleAdminData(request);

    const identity = this.identityOf(request);

    if (request.headers.get("Upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server); // hibernatable
      this.setState(server, { identity, tenant: this.tenant, subs: [] });
      return new Response(null, { status: 101, webSocket: client });
    }

    const name = new URL(request.url).pathname.replace(/^\/rpc\//, "");
    let input: unknown;
    if (request.method === "POST") {
      input = await request.json().catch(() => undefined);
    }

    try {
      const { result, kind, touched } = await dispatch(
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
      return Response.json({ ok: true, result });
    } catch (err) {
      const { status, body } = toResponse(err);
      return Response.json(body, { status });
    }
  }

  // --- Hibernatable WebSocket handlers ---

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, { type: "error", id: "", error: "invalid JSON" });
    }

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
      const { result, kind, touched } = await dispatch(this.app.handlers, this.app.schema, this.driver, this.kv, this.filesFor(state.tenant), this.envBag, this.ctxFor(state.identity), name, input);
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
      const { result, kind, touched } = await dispatch(this.app.handlers, this.app.schema, this.driver, this.kv, this.filesFor(state.tenant), this.envBag, this.ctxFor(state.identity), name, input);
      this.send(ws, { type: "result", id, result });
      if (kind === "mutation" && touched.length > 0) await this.broadcast(touched);
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
          const { result } = await dispatch(this.app.handlers, this.app.schema, this.driver, this.kv, this.filesFor(state.tenant), this.envBag, this.ctxFor(state.identity), sub.name, sub.input);
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
    await this.env.KV.put(`tenant:${name}`, JSON.stringify({ firstSeen: Date.now() }));
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

  // Introspection: this tenant's applied schema hash + live table/column shape
  // (admin-gated at the Worker). Powers the CLI's `schema status`.
  private async handleSchema(): Promise<Response> {
    const hashRow = (await this.driver.exec(`SELECT value FROM _pramen_meta WHERE key = 'schema_hash'`, [])) as {
      value: string;
    }[];
    const tableRows = (await this.driver.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_pramen_meta'`,
      [],
    )) as { name: string }[];
    const tables: Record<string, string[]> = {};
    for (const { name } of tableRows) {
      tables[name] = ((await this.driver.exec(`PRAGMA table_info(${name})`, [])) as { name: string }[]).map((r) => r.name);
    }
    return Response.json({ ok: true, result: { hash: hashRow[0]?.value ?? null, tables } });
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
    const db = new Db(this.driver, { acl: this.acl, identity: null, system: true }, this.app.schema) as any;
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

  private ctxFor(identity: Identity | null): AclContext {
    return { acl: this.acl, identity };
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
    return (ws.deserializeAttachment() as SocketState | null) ?? { identity: null, tenant: this.tenant, subs: [] };
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
