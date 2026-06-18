// MrakDO — the database. One instance per tenant (see src/index.ts routing).
// Holds the SQLite store in-process, applies the schema on boot, dispatches
// handler RPCs over HTTP, and serves live queries over WebSockets.
//
// ACL: policies are compiled once on boot. Identity is resolved by the Worker
// and forwarded in the X-Mrak-Identity header. For HTTP it's per request; for a
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
import { schemaDDL } from "./runtime/ddl";
import { dispatch } from "./runtime/dispatch";
import { digest } from "./runtime/digest";
import { AclDenied, compileAcl, type AclContext, type CompiledAcl } from "./runtime/acl";
import type { Identity } from "./sdk/acl";
import type { ClientMsg, ServerMsg, Subscription } from "./runtime/protocol";

interface SocketState {
  identity: Identity | null;
  subs: Subscription[];
}

export class MrakDO extends DurableObject {
  private readonly acl: CompiledAcl;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.acl = compileAcl(app.acl ?? []);

    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of schemaDDL(app.schema)) {
        ctx.storage.sql.exec(stmt);
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
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
      const { result, kind, touched } = await dispatch(app.handlers, this.ctx.storage, this.ctxFor(identity), name, input);
      if (kind === "mutation" && touched.length > 0) await this.broadcast(touched);
      return Response.json({ ok: true, result });
    } catch (err) {
      const status = err instanceof AclDenied ? 403 : 400;
      return Response.json({ ok: false, error: String(err) }, { status });
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

  // --- live-query internals ---

  private async onSubscribe(ws: WebSocket, id: string, name: string, input: unknown): Promise<void> {
    const state = this.getState(ws);
    try {
      const { result, kind, touched } = await dispatch(app.handlers, this.ctx.storage, this.ctxFor(state.identity), name, input);
      if (kind !== "query") {
        return this.send(ws, { type: "error", id, error: `${name} is not a query` });
      }
      const subs = state.subs.filter((s) => s.id !== id);
      subs.push({ id, name, input, tables: touched, digest: digest(result) });
      this.setState(ws, { ...state, subs });
      this.send(ws, { type: "data", id, result });
    } catch (err) {
      this.send(ws, { type: "error", id, error: String(err) });
    }
  }

  private async onCall(ws: WebSocket, id: string, name: string, input: unknown): Promise<void> {
    const state = this.getState(ws);
    try {
      const { result, kind, touched } = await dispatch(app.handlers, this.ctx.storage, this.ctxFor(state.identity), name, input);
      this.send(ws, { type: "result", id, result });
      if (kind === "mutation" && touched.length > 0) await this.broadcast(touched);
    } catch (err) {
      this.send(ws, { type: "error", id, error: String(err) });
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
          const { result } = await dispatch(app.handlers, this.ctx.storage, this.ctxFor(state.identity), sub.name, sub.input);
          const next = digest(result);
          if (next === sub.digest) continue; // result unchanged for this subscription
          sub.digest = next;
          dirty = true;
          this.send(ws, { type: "data", id: sub.id, result });
        } catch (err) {
          this.send(ws, { type: "error", id: sub.id, error: String(err) });
        }
      }
      if (dirty) this.setState(ws, state);
    }
  }

  // --- helpers ---

  private ctxFor(identity: Identity | null): AclContext {
    return { acl: this.acl, identity };
  }

  private identityOf(request: Request): Identity | null {
    const raw = request.headers.get("x-mrak-identity");
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
