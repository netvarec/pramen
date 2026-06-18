// MrakDO — the database. One instance per tenant (see src/index.ts routing).
// Holds the SQLite store in-process, applies the schema on boot, dispatches
// handler RPCs over HTTP, and serves live queries over WebSockets.
//
// Reactivity model: the DO is the single writer, so it sees every mutation.
// After a mutation commits we know which tables it wrote (DispatchResult.touched);
// we re-run every subscription whose read-set intersects those tables and push
// fresh results. Connections use Hibernatable WebSockets — subscriptions are
// stored on the socket via serializeAttachment(), so they survive hibernation.

import { DurableObject } from "cloudflare:workers";
import { app } from "../example/app";
import { schemaDDL } from "./runtime/ddl";
import { dispatch } from "./runtime/dispatch";
import { digest } from "./runtime/digest";
import type { ClientMsg, ServerMsg, Subscription } from "./runtime/protocol";

export class MrakDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);

    // Apply DDL before any request is served. blockConcurrencyWhile guarantees
    // no fetch()/webSocketMessage() runs until the schema is in place.
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of schemaDDL(app.schema)) {
        ctx.storage.sql.exec(stmt);
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    // WebSocket upgrade -> live-query connection.
    if (request.headers.get("Upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server); // hibernatable
      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP RPC: POST /rpc/<name>
    const name = new URL(request.url).pathname.replace(/^\/rpc\//, "");
    let input: unknown;
    if (request.method === "POST") {
      input = await request.json().catch(() => undefined);
    }

    try {
      const { result, kind, touched } = await dispatch(app.handlers, this.ctx.storage, name, input);
      if (kind === "mutation" && touched.length > 0) await this.broadcast(touched);
      return Response.json({ ok: true, result });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 400 });
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
      case "unsubscribe":
        return this.setSubs(ws, this.getSubs(ws).filter((s) => s.id !== msg.id));
      case "call":
        return this.onCall(ws, msg.id, msg.name, msg.input);
      default:
        return this.send(ws, { type: "error", id: "", error: "unknown message type" });
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    // Subscriptions live on the socket's attachment, so they vanish with it.
    ws.close();
  }

  // --- live-query internals ---

  private async onSubscribe(ws: WebSocket, id: string, name: string, input: unknown): Promise<void> {
    try {
      const { result, kind, touched } = await dispatch(app.handlers, this.ctx.storage, name, input);
      if (kind !== "query") {
        return this.send(ws, { type: "error", id, error: `${name} is not a query` });
      }
      const subs = this.getSubs(ws).filter((s) => s.id !== id);
      subs.push({ id, name, input, tables: touched, digest: digest(result) });
      this.setSubs(ws, subs);
      this.send(ws, { type: "data", id, result });
    } catch (err) {
      this.send(ws, { type: "error", id, error: String(err) });
    }
  }

  private async onCall(ws: WebSocket, id: string, name: string, input: unknown): Promise<void> {
    try {
      const { result, kind, touched } = await dispatch(app.handlers, this.ctx.storage, name, input);
      this.send(ws, { type: "result", id, result });
      if (kind === "mutation" && touched.length > 0) await this.broadcast(touched);
    } catch (err) {
      this.send(ws, { type: "error", id, error: String(err) });
    }
  }

  // Re-run every subscription whose read-set intersects the written tables, but
  // push only when that subscription's *result* actually changed (digest diff).
  // This is the row-level guarantee: a write notifies a subscription only when
  // its visible rows change — e.g. inserting a note wakes listNotes but not a
  // getNote({id}) view of a different row. Table intersection is just a cheap
  // prefilter to skip re-running queries on untouched tables entirely.
  private async broadcast(touched: string[]): Promise<void> {
    const written = new Set(touched);
    for (const ws of this.ctx.getWebSockets()) {
      const subs = this.getSubs(ws);
      let dirty = false;
      for (const sub of subs) {
        if (!sub.tables.some((t) => written.has(t))) continue;
        try {
          const { result } = await dispatch(app.handlers, this.ctx.storage, sub.name, sub.input);
          const next = digest(result);
          if (next === sub.digest) continue; // result unchanged for this subscription — no push
          sub.digest = next;
          dirty = true;
          this.send(ws, { type: "data", id: sub.id, result });
        } catch (err) {
          this.send(ws, { type: "error", id: sub.id, error: String(err) });
        }
      }
      if (dirty) this.setSubs(ws, subs); // persist updated digests (hibernation-safe)
    }
  }

  private getSubs(ws: WebSocket): Subscription[] {
    return (ws.deserializeAttachment() as Subscription[] | null) ?? [];
  }

  private setSubs(ws: WebSocket, subs: Subscription[]): void {
    ws.serializeAttachment(subs);
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    ws.send(JSON.stringify(msg));
  }
}
