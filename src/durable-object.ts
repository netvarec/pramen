// PramenDO — the database. One instance per tenant (see src/index.ts routing).
// Holds the SQLite store in-process, applies the schema on boot, dispatches
// handler RPCs over HTTP, and serves live queries over WebSockets.
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
import { app } from "../example/app";
import { migrate } from "./runtime/migrate";
import { dispatch } from "./runtime/dispatch";
import { digest } from "./runtime/digest";
import { compileAcl, type AclContext, type CompiledAcl } from "./runtime/acl";
import { DoSqliteDriver, type Driver } from "./runtime/driver";
import { BadRequest, toResponse, toWsError } from "./runtime/errors";
import { Kv } from "./runtime/kv";
import type { Identity } from "./sdk/acl";
import type { ClientMsg, ServerMsg, Subscription } from "./runtime/protocol";

interface SocketState {
  identity: Identity | null;
  subs: Subscription[];
}

export interface DoEnv {
  /** Project KV — tenant registry (`tenant:`) + handler ctx.kv (`app:`). */
  KV: KVNamespace;
}

/** Per-socket subscription cap — bounds memory and per-mutation re-run cost. */
const MAX_SUBSCRIPTIONS = 64;

export class PramenDO extends DurableObject<DoEnv> {
  private readonly acl: CompiledAcl;
  private readonly kv: Kv;
  private readonly driver: Driver;
  private registered = false;

  constructor(ctx: DurableObjectState, env: DoEnv) {
    super(ctx, env);
    this.acl = compileAcl(app.acl ?? []);
    this.kv = new Kv(env.KV); // app:-prefixed, handed to handlers as ctx.kv

    // The data layer runs over a Driver. The DO's store is its own in-process SQLite;
    // the D1 substrate (D1Driver) lives in the Worker (the "Worker + D1, no DO" path).
    this.driver = new DoSqliteDriver(ctx.storage);

    // Reconcile the store with the schema before any request is served (create/alter
    // tables; destructive changes rebuild the table). Wrapped in a transaction so a
    // partial migration can't leave a half-rebuilt table.
    ctx.blockConcurrencyWhile(() => this.driver.transaction(() => migrate(this.driver, app.schema).then(() => {})));
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureRegistered(request);

    const path = new URL(request.url).pathname;
    if (path === "/__recover") return this.handleRecover(request);
    if (path === "/__schema") return this.handleSchema();

    const identity = this.identityOf(request);

    if (request.headers.get("Upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server); // hibernatable
      this.setState(server, { identity, subs: [] });
      return new Response(null, { status: 101, webSocket: client });
    }

    const name = new URL(request.url).pathname.replace(/^\/rpc\//, "");
    let input: unknown;
    if (request.method === "POST") {
      input = await request.json().catch(() => undefined);
    }

    try {
      const { result, kind, touched } = await dispatch(app.handlers, app.schema, this.driver, this.kv, this.ctxFor(identity), name, input);
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
      const { result, kind, touched } = await dispatch(app.handlers, app.schema, this.driver, this.kv, this.ctxFor(state.identity), name, input);
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
      const { result, kind, touched } = await dispatch(app.handlers, app.schema, this.driver, this.kv, this.ctxFor(state.identity), name, input);
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
          const { result } = await dispatch(app.handlers, app.schema, this.driver, this.kv, this.ctxFor(state.identity), sub.name, sub.input);
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

  private ctxFor(identity: Identity | null): AclContext {
    return { acl: this.acl, identity };
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
    return (ws.deserializeAttachment() as SocketState | null) ?? { identity: null, subs: [] };
  }

  private setState(ws: WebSocket, state: SocketState): void {
    ws.serializeAttachment(state);
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    ws.send(JSON.stringify(msg));
  }
}
