// Security regressions for the public analytics collector: the body cap is enforced while
// reading (not after buffering), and the tenant a pre-auth beacon writes into is one the
// deployment declared, on the direct path and through the queue consumer alike.

import { describe, expect, test } from "bun:test";
import { collectRoute, MAX_BODY_BYTES, readCapped } from "../packages/analytics/src/collect";
import { MemorySink } from "../packages/analytics/src/sink";
import { createAnalyticsQueues, createAnalyticsSink } from "../packages/analytics/src/index";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";
const beaconBody = JSON.stringify({ events: [{ viewId: "v1", path: "/x" }] });

/** A body stream that counts what the reader actually pulled. */
function countingStream(total: number, chunk = 4096): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= total) return c.close();
      const n = Math.min(chunk, total - sent);
      sent += n;
      c.enqueue(new Uint8Array(n).fill(0x61));
    },
  });
  return { stream, pulled: () => sent };
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [e, w] = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
    console.warn = w;
  }
};

describe("the /collect body cap is enforced while reading", () => {
  test("a declared content-length over the cap is refused without reading", async () => {
    const { stream, pulled } = countingStream(2 * 1024 * 1024);
    const req = new Request("https://x.test/collect", { method: "POST", body: stream, headers: { "content-length": String(2 * 1024 * 1024) }, duplex: "half" } as RequestInit);
    expect(await readCapped(req, MAX_BODY_BYTES)).toBeNull();
    expect(pulled()).toBeLessThanOrEqual(64 * 1024); // at most the stream's own read-ahead
  });

  test("an undeclared stream is cancelled just past the cap", async () => {
    const { stream, pulled } = countingStream(2 * 1024 * 1024);
    const req = new Request("https://x.test/collect", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(await readCapped(req, MAX_BODY_BYTES)).toBeNull();
    expect(pulled()).toBeLessThanOrEqual(MAX_BODY_BYTES + 3 * 4096);
  });

  test("a beacon-sized body still reads, and an oversized one never reaches the sink", async () => {
    const sink = new MemorySink();
    const [route] = collectRoute({ sink: () => sink });
    const ok = await route!.handler(new Request("https://x.test/collect", { method: "POST", body: beaconBody, headers: { "user-agent": UA } }), {} as never, {} as never);
    expect(ok.status).toBe(204);
    expect(sink.events.length).toBe(1);
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    await route!.handler(new Request("https://x.test/collect", { method: "POST", body: big, headers: { "user-agent": UA } }), {} as never, {} as never);
    expect(sink.events.length).toBe(1);
  });
});

describe("analytics writes only into declared tenants", () => {
  const routeCtx = () => {
    const calls: { tenant?: string }[] = [];
    return {
      calls,
      ctx: { callPrivileged: async (o: { tenant?: string }) => (calls.push(o), new Response("{}", { status: 200 })) } as never,
    };
  };
  const event = { kind: "pageview", origin: "beacon", viewId: "v", ts: "2026-01-01T00:00:00.000Z", day: "2026-01-01", path: "/" } as never;

  test("the direct sink drops a tenant outside the allowlist (default: main)", async () => {
    const { calls, ctx } = routeCtx();
    await quiet(() => createAnalyticsSink({}, ctx, { tenant: "zz-junk", queueBinding: null }).write([event]));
    expect(calls).toEqual([]);
    await createAnalyticsSink({}, ctx, { tenant: "main", queueBinding: null }).write([event]);
    expect(calls.map((c) => c.tenant)).toEqual(["main"]);
  });

  test("a declared tenant is written", async () => {
    const { calls, ctx } = routeCtx();
    await createAnalyticsSink({}, ctx, { tenant: "acme", tenants: ["main", "acme"], queueBinding: null }).write([event]);
    expect(calls.map((c) => c.tenant)).toEqual(["acme"]);
  });

  test("the queue consumer acks and drops a batch for an undeclared tenant", async () => {
    const consumer = Object.values(createAnalyticsQueues())[0]!;
    const { calls, ctx } = routeCtx();
    await quiet(() => consumer(ctx, { body: { kind: "analytics.ingest", tenant: "zz-junk", events: [event] } } as never));
    expect(calls).toEqual([]);
    await consumer(ctx, { body: { kind: "analytics.ingest", tenant: "main", events: [event] } } as never);
    expect(calls.map((c) => c.tenant)).toEqual(["main"]);
  });
});
