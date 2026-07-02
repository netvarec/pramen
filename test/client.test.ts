// Unit tests for @pramen/client — no server boot. Uses injected fetchImpl/WebSocketImpl
// so it runs standalone (`bun test test/client.test.ts`). Covers the correctness fixes:
//   C1 — call() must NOT silently resolve undefined on a 2xx non-envelope response,
//        and the base url is normalized so a trailing slash can't produce `//rpc`.
//   C2 — the D1 read-your-writes bookmark keeps the MAXIMUM, not last-response-wins.
//   C4 — live connection failures surface via onConnectionError instead of hanging.

import { describe, expect, test } from "bun:test";
import { createClient, PramenError } from "@pramen/client";

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("call() success envelope (C1)", () => {
  test("a 2xx non-envelope response throws, never resolves undefined", async () => {
    // Simulate the Worker help page: 200 OK, plain text (JSON.parse fails → {}).
    const fetchImpl = (async () => new Response("pramen help page", { status: 200 })) as unknown as typeof fetch;
    const client = createClient({ url: "https://x.example", fetchImpl });
    await expect(client.call("anything" as never)).rejects.toBeInstanceOf(PramenError);
  });

  test("ok:false envelope throws with its error/code/status", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ ok: false, error: "nope", code: "denied" }, { status: 403 })) as unknown as typeof fetch;
    const client = createClient({ url: "https://x.example", fetchImpl });
    await expect(client.call("x" as never)).rejects.toMatchObject({ code: "denied", status: 403 });
  });

  test("ok:true envelope resolves the result", async () => {
    const fetchImpl = (async () => jsonResponse({ ok: true, result: { hi: 1 } })) as unknown as typeof fetch;
    const client = createClient({ url: "https://x.example", fetchImpl });
    expect(await client.call("x" as never)).toEqual({ hi: 1 });
  });

  test("trailing slash in the base url is normalized (no //rpc)", async () => {
    let seen = "";
    const fetchImpl = (async (url: string) => {
      seen = url;
      return jsonResponse({ ok: true, result: 1 });
    }) as unknown as typeof fetch;
    const client = createClient({ url: "https://x.example/", fetchImpl });
    await client.call("ping" as never);
    expect(seen).toBe("https://x.example/rpc/ping");
  });
});

describe("D1 bookmark replay keeps the max (C2)", () => {
  test("an older bookmark arriving later does not clobber a newer one", async () => {
    const sent: (string | null)[] = [];
    const responses = ["0000000005-abc", "0000000002-abc"]; // 2nd is lexicographically smaller
    let i = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>)["x-pramen-d1-bookmark"] ?? null);
      const bm = responses[i++];
      return jsonResponse({ ok: true, result: 1 }, bm ? { headers: { "x-pramen-d1-bookmark": bm } } : undefined);
    }) as unknown as typeof fetch;
    const client = createClient({ url: "https://x.example", fetchImpl });
    await client.call("a" as never); // stores ...5
    await client.call("b" as never); // response ...2 must NOT clobber ...5
    await client.call("c" as never); // should echo ...5
    expect(sent[0]).toBeNull();
    expect(sent[1]).toBe("0000000005-abc");
    expect(sent[2]).toBe("0000000005-abc");
  });
});

describe("live connection error surfaces (C4)", () => {
  test("no WebSocket implementation fires onConnectionError instead of hanging", () => {
    const fetchImpl = (async () => jsonResponse({ ok: true, result: 1 })) as unknown as typeof fetch;
    // Force the no-WS branch: no WebSocketImpl and no global WebSocket.
    const orig = (globalThis as { WebSocket?: unknown }).WebSocket;
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    try {
      const client = createClient({ url: "https://x.example", fetchImpl });
      let err: { error: string; code: string } | null = null;
      client.subscribe("listNotes" as never, undefined, {
        onData: () => {},
        onConnectionError: (e) => {
          err = e;
        },
      });
      expect(err).not.toBeNull();
      expect(err!.code).toBe("no_websocket");
      client.close();
    } finally {
      if (orig !== undefined) (globalThis as { WebSocket?: unknown }).WebSocket = orig;
    }
  });

  test("a socket that keeps closing exhausts reconnects and reports a connection error", async () => {
    const fetchImpl = (async () => jsonResponse({ ok: true, result: 1 })) as unknown as typeof fetch;

    // A WS that never opens — it emits `close` right after construction (a rejected
    // upgrade, e.g. auth 403). Each reconnect gets the same treatment.
    class ClosingWS {
      static OPEN = 1;
      readyState = 0;
      private handlers: Record<string, ((e: unknown) => void)[]> = {};
      constructor() {
        queueMicrotask(() => this.emit("close", {}));
      }
      addEventListener(type: string, fn: (e: unknown) => void) {
        (this.handlers[type] ??= []).push(fn);
      }
      private emit(type: string, e: unknown) {
        for (const fn of this.handlers[type] ?? []) fn(e);
      }
      send() {}
      close() {}
    }

    const client = createClient({
      url: "https://x.example",
      fetchImpl,
      WebSocketImpl: ClosingWS as unknown as typeof WebSocket,
      maxReconnectAttempts: 2,
    });
    const err = await new Promise<{ error: string; code: string }>((resolve) => {
      client.subscribe("listNotes" as never, undefined, {
        onData: () => {},
        onConnectionError: resolve,
      });
    });
    expect(err.code).toBe("connection_failed");
    client.close();
  }, 10_000);
});
