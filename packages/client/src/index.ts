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
  /** Give up reconnecting the live socket after this many consecutive failed
   * attempts and surface a connection error to every subscriber (default 8). */
  maxReconnectAttempts?: number;
}

export interface SubHandlers<T> {
  onData: (result: T) => void;
  /** Called when the server rejects THIS subscription (a `{type:"error"}` frame). */
  onError?: (err: { error: string; code: string }) => void;
  /** Called when the underlying live connection itself fails — no WebSocket
   * implementation is available, or the socket has closed and stayed down past
   * `maxReconnectAttempts`. Distinct from `onError` (a per-subscription server error):
   * this is a transport-level failure that affects every sub on the connection.
   * Optional and additive — omitting it preserves the prior (silent) behavior for
   * existing callers. */
  onConnectionError?: (err: { error: string; code: string }) => void;
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
  onConnectionError?: (err: { error: string; code: string }) => void;
}

export function createClient<Api = Record<string, never>>(opts: ClientOptions): PramenClient<Api> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const WS = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  // Normalize the base url: strip any trailing slash so `${base}/rpc/...` can't become
  // `//rpc/...` (which the Worker serves as a plain-text help page — a 200 that isn't an
  // envelope, silently resolving `call()` to undefined for every RPC).
  const baseUrl = opts.url.replace(/\/+$/, "");
  const maxReconnectAttempts = opts.maxReconnectAttempts ?? 8;
  let token = opts.token;

  // D1 read-your-writes: when the backend runs on the D1 store it returns an
  // `x-pramen-d1-bookmark` header marking the latest write this client has observed.
  // We stash it and echo it on the next request so a fresh D1 session anchors there and
  // reads our own writes (even off a lagging replica). The DO path never sets the
  // header, so `d1Bookmark` stays undefined there and nothing changes.
  let d1Bookmark: string | undefined;

  const subs = new Map<string, Sub>();
  let ws: WebSocket | null = null;
  let counter = 0;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  // How long a connection must stay open before we trust it and reset the backoff.
  const STABLE_MS = 3000;

  async function call(name: string, input?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.tenant) headers["x-pramen-tenant"] = opts.tenant;
    if (d1Bookmark) headers["x-pramen-d1-bookmark"] = d1Bookmark;
    const res = await doFetch(`${baseUrl}/rpc/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input ?? {}),
    });
    // Capture the D1 read-your-writes bookmark (D1 store only; absent on the DO path).
    // Keep the MAXIMUM bookmark seen — D1 session bookmarks are lexicographically
    // ordered, so a slower earlier response arriving after a mutation must not clobber a
    // newer one and regress read-your-writes.
    const bookmark = res.headers.get("x-pramen-d1-bookmark");
    if (bookmark && (!d1Bookmark || bookmark > d1Bookmark)) d1Bookmark = bookmark;
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string; code?: string };
    // Require the success envelope explicitly: only `{ ok: true }` is a success. Any
    // other 2xx body (e.g. a non-JSON help page parsed to `{}`, or `ok` absent) is an
    // error, so a call never silently resolves undefined.
    if (!res.ok || body.ok !== true) {
      throw new PramenError(body.error ?? `request failed (${res.status})`, body.code ?? "error", res.status);
    }
    return body.result;
  }

  function liveUrl(): string {
    const u = new URL(baseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/live";
    if (opts.tenant) u.searchParams.set("tenant", opts.tenant);
    if (token) u.searchParams.set("token", token);
    return u.toString();
  }

  /** Surface a transport-level failure (no WS impl, or reconnects exhausted) to every
   * subscriber so a `useLiveQuery` can leave its loading state instead of hanging. */
  function reportConnectionError(error: string, code: string): void {
    for (const sub of subs.values()) sub.onConnectionError?.({ error, code });
  }

  function ensureSocket(): void {
    if (closed || ws || subs.size === 0) return;
    if (!WS) {
      // No WebSocket implementation in this environment — the subscription can never
      // fire. Surface it instead of returning silently (the old hang-forever behavior).
      reportConnectionError("no WebSocket implementation available", "no_websocket");
      return;
    }
    const socket = new WS(liveUrl());
    ws = socket;
    socket.addEventListener("open", () => {
      // Don't reset the backoff on open alone: an accept-then-immediately-close server
      // would otherwise hot-loop with no backoff growth. Only clear it once the
      // connection has stayed up (stableTimer below).
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        stableTimer = null;
        if (ws === socket) reconnectAttempts = 0;
      }, STABLE_MS);
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
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
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
    if (reconnectAttempts >= maxReconnectAttempts) {
      // Give up rather than reconnect forever at the 10s cap — a rejected upgrade (e.g.
      // auth 403) would otherwise spin silently behind a permanent spinner.
      reportConnectionError(`live connection failed after ${reconnectAttempts} attempts`, "connection_failed");
      return;
    }
    // Exponential backoff with jitter (so a fleet of clients doesn't reconnect in lockstep).
    const base = Math.min(500 * 2 ** reconnectAttempts, 10_000);
    const delay = base / 2 + Math.random() * (base / 2);
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
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    reconnectAttempts = 0;
    ensureSocket();
  }

  const fileUrl = (path: string): string => new URL(path, baseUrl).toString();

  async function upload(uploadUrl: string, body: BodyInit, o?: { contentType?: string }): Promise<UploadResult> {
    const headers: Record<string, string> = {};
    if (o?.contentType) headers["content-type"] = o.contentType;
    const res = await doFetch(fileUrl(uploadUrl), { method: "PUT", headers, body });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: UploadResult; error?: string; code?: string };
    if (!res.ok || j.ok !== true) {
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
        onConnectionError: handlers.onConnectionError,
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
      if (stableTimer) clearTimeout(stableTimer);
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
