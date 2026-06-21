// @pramen/client — a typed client for a pramen backend.
//
//   import type { app } from "../../server/app";       // type-only (erased)
//   const client = createClient<typeof app.handlers>({ url, token, tenant });
//   const note = await client.call("createNote", { title, body });   // typed
//   const stop = client.subscribe("listNotes", undefined, { onData: (notes) => ... });
//
// `call` is HTTP (POST /rpc/<name>); `subscribe` is a multiplexed WebSocket
// (/live) with auto-reconnect + re-subscribe. Browser WebSockets can't set
// headers, so auth/tenant go in the query string (the Worker accepts both).

export class PramenError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PramenError";
  }
}

// Structural inference from a handler map type (no dependency on the server).
type HandlerInput<H> = H extends { run: (ctx: any, input: infer I) => any } ? I : unknown;
type HandlerOutput<H> = H extends { run: (ctx: any, input: any) => infer O } ? Awaited<O> : unknown;
export type Input<Api, K extends keyof Api> = HandlerInput<Api[K]>;
export type Output<Api, K extends keyof Api> = HandlerOutput<Api[K]>;

export interface ClientOptions {
  /** Base URL of the deployed Worker, e.g. https://app.example.workers.dev */
  url: string;
  token?: string;
  tenant?: string;
  /** Override for non-browser environments (defaults to globals). */
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
}

export interface SubHandlers<T> {
  onData: (result: T) => void;
  onError?: (err: { error: string; code: string }) => void;
}

/** Result of a file upload (the persisted blob's storage metadata). */
export interface UploadResult {
  key: string;
  size: number;
  contentType?: string;
  etag?: string;
}

export interface PramenClient<Api> {
  call<K extends keyof Api & string>(name: K, input?: HandlerInput<Api[K]>): Promise<HandlerOutput<Api[K]>>;
  subscribe<K extends keyof Api & string>(
    name: K,
    input: HandlerInput<Api[K]> | undefined,
    handlers: SubHandlers<HandlerOutput<Api[K]>>,
  ): () => void;
  /** Resolve a server-issued relative path (e.g. a signed `/files/...` url) to an
   * absolute url against the client's base. */
  fileUrl(path: string): string;
  /** Upload bytes to a signed upload url (from a handler's `signUpload`). Accepts a
   * relative or absolute url; returns the stored blob's metadata. */
  upload(uploadUrl: string, body: BodyInit, opts?: { contentType?: string }): Promise<UploadResult>;
  setToken(token: string | undefined): void;
  close(): void;
}

interface Sub {
  id: string;
  name: string;
  input: unknown;
  onData: (result: unknown) => void;
  onError?: (err: { error: string; code: string }) => void;
}

export function createClient<Api = Record<string, never>>(opts: ClientOptions): PramenClient<Api> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const WS = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  let token = opts.token;

  const subs = new Map<string, Sub>();
  let ws: WebSocket | null = null;
  let counter = 0;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  async function call(name: string, input?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.tenant) headers["x-pramen-tenant"] = opts.tenant;
    const res = await doFetch(`${opts.url}/rpc/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input ?? {}),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string; code?: string };
    if (!res.ok || body.ok === false) {
      throw new PramenError(body.error ?? `request failed (${res.status})`, body.code ?? "error", res.status);
    }
    return body.result;
  }

  function liveUrl(): string {
    const u = new URL(opts.url);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/live";
    if (opts.tenant) u.searchParams.set("tenant", opts.tenant);
    if (token) u.searchParams.set("token", token);
    return u.toString();
  }

  function ensureSocket(): void {
    if (closed || ws || !WS || subs.size === 0) return;
    const socket = new WS(liveUrl());
    ws = socket;
    socket.addEventListener("open", () => {
      reconnectAttempts = 0;
      for (const sub of subs.values()) {
        socket.send(JSON.stringify({ type: "subscribe", id: sub.id, name: sub.name, input: sub.input }));
      }
    });
    socket.addEventListener("message", (e: MessageEvent) => {
      let msg: { type: string; id: string; result?: unknown; error?: string; code?: string };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const sub = subs.get(msg.id);
      if (!sub) return;
      if (msg.type === "data") sub.onData(msg.result);
      else if (msg.type === "error") sub.onError?.({ error: msg.error ?? "error", code: msg.code ?? "error" });
    });
    socket.addEventListener("close", () => {
      if (ws === socket) ws = null;
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    });
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer || subs.size === 0) return;
    const delay = Math.min(500 * 2 ** reconnectAttempts, 10_000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureSocket();
    }, delay);
  }

  function resetSocket(): void {
    if (ws) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      ws = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    ensureSocket();
  }

  const fileUrl = (path: string): string => new URL(path, opts.url).toString();

  async function upload(uploadUrl: string, body: BodyInit, o?: { contentType?: string }): Promise<UploadResult> {
    const headers: Record<string, string> = {};
    if (o?.contentType) headers["content-type"] = o.contentType;
    const res = await doFetch(fileUrl(uploadUrl), { method: "PUT", headers, body });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: UploadResult; error?: string; code?: string };
    if (!res.ok || j.ok === false) {
      throw new PramenError(j.error ?? `upload failed (${res.status})`, j.code ?? "error", res.status);
    }
    return j.result as UploadResult;
  }

  return {
    call: call as PramenClient<Api>["call"],
    fileUrl,
    upload,
    subscribe(name, input, handlers) {
      const id = `s${counter++}`;
      const sub: Sub = {
        id,
        name: name as string,
        input,
        onData: handlers.onData as (r: unknown) => void,
        onError: handlers.onError,
      };
      subs.set(id, sub);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "subscribe", id, name, input }));
      } else {
        ensureSocket();
      }
      return () => {
        subs.delete(id);
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "unsubscribe", id }));
      };
    },
    setToken(next) {
      token = next;
      resetSocket(); // reconnect so subscriptions use the new identity
    },
    close() {
      closed = true;
      subs.clear();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        ws = null;
      }
    },
  };
}
