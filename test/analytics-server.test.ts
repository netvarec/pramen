// @pramen/analytics: the Worker-side collector, the self-scheduling rollup and the chart
// block. Unit-level, since each is a decision (what counts as a view, when the next run is
// due, what a chart may carry) whose failure produces a plausible number, not an error.

import { describe, expect, test } from "bun:test";
import { MemorySink } from "../packages/analytics/src/sink";
import { PAGE_ID_HEADER, analyticsMiddleware, recordView, shouldRecord } from "../packages/analytics/src/server";
import { assertKeepDays, ensureRollupScheduled, nextRollupAt, resetRollupMemo, ROLLUP_TASK, runScheduledRollup, scheduleRollup } from "../packages/analytics/src/schedule";
import { normalizeAdminResponse, MAX_ADMIN_CHART_POINTS } from "../packages/cms/src/blockkit";
import { niceMax } from "../packages/cms-editor/src/chart";
import type { HandlerContext } from "../packages/server/src";
import { validateHandlerTasks, mutation } from "../packages/server/src";
import { createApp } from "../packages/server/src/sdk/app";
import { createAnalytics, createAnalyticsTasks, createEdgeSink } from "../packages/analytics/src/index";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";
const html = (init: ResponseInit = {}, body = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>") =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
const get = (path = "/about?utm=1", headers: Record<string, string> = {}) =>
  new Request(`https://example.com${path}`, { headers: { "user-agent": UA, ...headers } });

describe("shouldRecord", () => {
  test("a browser GET of a 200 HTML page is a view", () => {
    expect(shouldRecord(get(), html())).toBe(true);
  });

  test.each([
    ["a bot", get("/", { "user-agent": "Googlebot/2.1" }), html()],
    ["a prefetch", get("/", { purpose: "prefetch" }), html()],
    ["Do Not Track", get("/", { dnt: "1" }), html()],
    ["a fragment fetch", get("/", { "sec-fetch-dest": "empty" }), html()],
    ["Global Privacy Control", get("/", { "sec-gpc": "1" }), html()],
    ["a non-HTML answer", get(), new Response("{}", { headers: { "content-type": "application/json" } })],
    ["an error page", get(), html({ status: 404 })],
    ["a POST", new Request("https://example.com/", { method: "POST", headers: { "user-agent": UA } }), html()],
    // The cache would replay one stamped id to every visitor, collapsing them into one view.
    ["a shared-cacheable page", get(), html({ headers: { "content-type": "text/html", "cache-control": "public, s-maxage=300" } })],
  ])("%s is not a view", (_name, req, res) => {
    expect(shouldRecord(req, res)).toBe(false);
  });

  test("a page the browser itself may cache is not a view", () => {
    expect(shouldRecord(get(), html({ headers: { "content-type": "text/html", "cache-control": "private, max-age=300" } }))).toBe(false);
    expect(shouldRecord(get(), html({ headers: { "content-type": "text/html", "cache-control": "max-age=3600" } }))).toBe(false);
    expect(shouldRecord(get(), html({ headers: { "content-type": "text/html", "cache-control": "no-store, max-age=300" } }))).toBe(true);
  });

  test("Expires or Last-Modified with no Cache-Control may also be replayed", () => {
    const future = new Date(Date.now() + 3_600_000).toUTCString();
    expect(shouldRecord(get(), html({ headers: { "content-type": "text/html", expires: future } }))).toBe(false);
    expect(shouldRecord(get(), html({ headers: { "content-type": "text/html", "last-modified": new Date().toUTCString() } }))).toBe(false);
    expect(shouldRecord(get(), html({ headers: { "content-type": "text/html", expires: "0" } }))).toBe(true);
  });

  test("a private, uncached page is still a view", () => {
    expect(shouldRecord(get(), html({ headers: { "content-type": "text/html", "cache-control": "private, max-age=0" } }))).toBe(true);
  });
});

describe("recordView", () => {
  test("records one server-origin pageview and stamps the page with its id", async () => {
    const sink = new MemorySink();
    const res = await recordView({ request: get("/about/?utm=1", { referer: "https://www.google.com/" }), response: html(), sink, salt: "s" });
    expect(sink.events).toHaveLength(1);
    const e = sink.events[0]!;
    expect(e.origin).toBe("server");
    expect(e.kind).toBe("pageview");
    expect(e.path).toBe("/about");
    expect(e.source).toBe("search");
    expect(e.device).toBe("desktop");
    expect(e.sessionId).toMatch(/^[0-9a-f]{32}$/);
    const body = await res.text();
    expect(body).toContain(`<meta name="pramen-view" content="${e.viewId}">`);
    // Inside <head>, so the beacon's querySelector finds it before it runs.
    expect(body.indexOf("pramen-view")).toBeGreaterThan(body.indexOf("<head>"));
    expect(body.indexOf("pramen-view")).toBeLessThan(body.indexOf("</head>"));
  });

  test("no salt means no session, rather than an unsalted hash of the visitor", async () => {
    const sink = new MemorySink();
    await recordView({ request: get(), response: html(), sink, salt: null });
    expect(sink.events[0]!.sessionId).toBeNull();
  });

  test("takes the CMS page id from the response header and strips it", async () => {
    const sink = new MemorySink();
    const res = await recordView({ request: get(), response: html({ headers: { "content-type": "text/html", [PAGE_ID_HEADER]: "page-123" } }), sink });
    expect(sink.events[0]!.pageId).toBe("page-123");
    expect(res.headers.has(PAGE_ID_HEADER)).toBe(false);
  });

  test("a page that is not a view comes back untouched and records nothing", async () => {
    const sink = new MemorySink();
    const res = await recordView({ request: get("/", { "user-agent": "curl/8" }), response: html(), sink });
    expect(sink.events).toHaveLength(0);
    expect(await res.text()).not.toContain("pramen-view");
  });

  // The whole point of stamping AFTER the write: a stamped page whose view was lost would
  // have the beacon report engagement for a pageview that does not exist.
  test("a failing sink never breaks the page and never stamps it", async () => {
    const res = await recordView({
      request: get(),
      response: html(),
      sink: { write: async () => { throw new Error("queue down"); } },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("pramen-view");
  });

  test("a document without <head> is not recorded, and <header> is not mistaken for it", async () => {
    const sink = new MemorySink();
    const frag = "<header>nav</header><p>partial</p>";
    // Bun ships an HTMLRewriter, which streams and cannot look ahead; the buffered path is
    // the one that can, so exercise that one.
    const g = globalThis as { HTMLRewriter?: unknown };
    const saved = g.HTMLRewriter;
    g.HTMLRewriter = undefined;
    try {
      const res = await recordView({ request: get(), response: html({}, frag), sink });
      expect(sink.events).toHaveLength(0);
      expect(await res.text()).toBe(frag);
    } finally {
      g.HTMLRewriter = saved;
    }
  });

  // The buffered path spends the original body; the catch must serve the buffered text.
  test("a failing sink on the buffered path still serves the page", async () => {
    const g = globalThis as { HTMLRewriter?: unknown };
    const saved = g.HTMLRewriter;
    g.HTMLRewriter = undefined;
    try {
      const res = await recordView({
        request: get(),
        response: html({ headers: { "content-type": "text/html", [PAGE_ID_HEADER]: "p1" } }),
        sink: { write: async () => { throw new Error("queue down"); } },
      });
      const body = await res.text();
      expect(body).toContain("<body>hi</body>");
      expect(body).not.toContain("pramen-view");
      expect(res.headers.has(PAGE_ID_HEADER)).toBe(false);
    } finally {
      g.HTMLRewriter = saved;
    }
  });

  test("validators are dropped, since every view's body differs", async () => {
    const res = await recordView({ request: get(), response: html({ headers: { "content-type": "text/html", etag: '"abc"', "content-md5": "x" } }), sink: new MemorySink() });
    expect(res.headers.has("etag")).toBe(false);
    expect(res.headers.has("content-md5")).toBe(false);
  });

  test("an encoded response is left alone", async () => {
    const sink = new MemorySink();
    await recordView({ request: get(), response: html({ headers: { "content-type": "text/html", "content-encoding": "gzip" } }), sink });
    expect(sink.events).toHaveLength(0);
  });

  test("drops content-length, since the body grew", async () => {
    const res = await recordView({ request: get(), response: html({ headers: { "content-type": "text/html", "content-length": "5" } }), sink: new MemorySink() });
    expect(res.headers.has("content-length")).toBe(false);
  });
});

describe("nextRollupAt", () => {
  test("is 00:10 UTC, today if that is still ahead, else tomorrow", () => {
    expect(nextRollupAt(new Date("2026-09-29T00:05:00Z")).toISOString()).toBe("2026-09-29T00:10:00.000Z");
    expect(nextRollupAt(new Date("2026-09-29T00:10:00Z")).toISOString()).toBe("2026-09-30T00:10:00.000Z");
    expect(nextRollupAt(new Date("2026-09-29T15:00:00Z")).toISOString()).toBe("2026-09-30T00:10:00.000Z");
    expect(nextRollupAt(new Date("2026-12-31T23:59:00Z")).toISOString()).toBe("2027-01-01T00:10:00.000Z");
  });
});

/** Just enough of a handler ctx: an outbox that honours the idempotency key, as the real one does. */
function fakeCtx(tenant = "main") {
  const queue: { kind: string; payload: unknown; delayMs?: number; key?: string }[] = [];
  const ctx = {
    tenant,
    store: "do",
    kv: { get: async () => "1", put: async () => {} },
    // One old event day, so the store has something pending and the chain keeps going.
    db: { exec: async () => [], find: async () => [], aggregate: async () => [{ day: "2020-01-01", n: 1, newest: null }] },
    tasks: {
      enqueue: async (t: { kind: string; payload: unknown; delayMs?: number; key?: string }) => {
        if (t.key && queue.some((q) => q.key === t.key)) return;
        queue.push(t);
      },
    },
  } as unknown as HandlerContext;
  return { ctx, queue };
}

describe("scheduleRollup", () => {
  test("queues the next run once, however often it is asked", async () => {
    const { ctx, queue } = fakeCtx();
    const now = new Date("2026-09-29T15:00:00Z");
    await scheduleRollup(ctx, { after: now, now });
    await scheduleRollup(ctx, { after: now, now });
    expect(queue).toHaveLength(1);
    expect(queue[0]!.kind).toBe(ROLLUP_TASK);
    expect(queue[0]!.delayMs).toBe(new Date("2026-09-30T00:10:00Z").getTime() - now.getTime());
  });

  test("ingest seeds the chain, once per tenant even in one isolate", async () => {
    resetRollupMemo();
    const a = fakeCtx("a");
    const b = fakeCtx("b");
    await ensureRollupScheduled(a.ctx);
    await ensureRollupScheduled(a.ctx);
    await ensureRollupScheduled(b.ctx);
    expect(a.queue).toHaveLength(1);
    expect(b.queue).toHaveLength(1);
  });

  // A drain that fires a few ms early computes the same target as its own row; the chain
  // must still queue the NEXT day.
  test("a run that fires before its due instant still queues the following day", async () => {
    const { ctx, queue } = fakeCtx();
    const due = nextRollupAt(new Date(Date.now() - 1000)); // a due instant in the future
    queue.push({ kind: ROLLUP_TASK, payload: { at: due.toISOString() }, key: `${ROLLUP_TASK}:${due.toISOString()}` });
    await runScheduledRollup(ctx, { at: due.toISOString() });
    expect(queue).toHaveLength(2);
    expect((queue[1]!.payload as { at: string }).at).toBe(new Date(due.getTime() + 86_400_000).toISOString());
  });

  test("an idle store's chain ends: nothing pending, nothing re-queued", async () => {
    const { ctx, queue } = fakeCtx();
    (ctx.db as unknown as { aggregate: () => Promise<unknown[]> }).aggregate = async () => [];
    await runScheduledRollup(ctx, { at: new Date().toISOString() });
    expect(queue).toHaveLength(0);
  });

  test("keepDays is validated when the tasks are built", () => {
    for (const bad of [Number.NaN, -1, 0, 3, Number.POSITIVE_INFINITY]) expect(() => assertKeepDays(bad)).toThrow(/keepDays/);
    expect(() => createAnalyticsTasks({ keepDays: Number.NaN })).toThrow(/keepDays/);
    expect(() => assertKeepDays(undefined)).not.toThrow();
    expect(() => assertKeepDays(90)).not.toThrow();
  });

  test("createAnalytics hands back the halves that must agree", () => {
    const a = createAnalytics();
    expect(Object.keys(a.tasks)).toEqual([ROLLUP_TASK]);
    expect(a.handlers.__analyticsIngest.requiresTasks).toEqual([ROLLUP_TASK]);
  });

  test("createApp's mutation keeps requiresTasks, so the boot check sees it", () => {
    const { mutation: m } = createApp({});
    expect(validateHandlerTasks({ x: m(() => 1, { requiresTasks: ["k"] }) }, {})).toEqual(["k"]);
  });

  test("an edge sink with no queue is one instance however often it is asked, so it warns once", () => {
    expect(createEdgeSink({})).toBe(createEdgeSink({}));
  });

  test("a task-less app is warned about, a wired one is not", () => {
    const h = { ingest: mutation(() => 1, { requiresTasks: [ROLLUP_TASK] }) };
    expect(validateHandlerTasks(h, {})).toEqual([ROLLUP_TASK]);
    expect(validateHandlerTasks(h, { [ROLLUP_TASK]: async () => {} })).toEqual([]);
  });
});

describe("chart block", () => {
  const chart = (points: { label: string; value: number }[]) => normalizeAdminResponse({ blocks: [{ type: "chart", points }] });

  test("a valid series passes through", () => {
    expect(chart([{ label: "09-28", value: 3 }, { label: "09-29", value: 0 }]).blocks).toHaveLength(1);
  });

  // A NaN coordinate draws nothing and reads as "no traffic".
  test("a non-finite value is refused at the boundary", () => {
    expect(() => chart([{ label: "a", value: Number.NaN }])).toThrow(/non-finite/);
    expect(() => chart([{ label: "a", value: Number.POSITIVE_INFINITY }])).toThrow(/non-finite/);
  });

  test("a middleware whose option callbacks throw still serves the page", async () => {
    const onRequest = analyticsMiddleware({ sink: () => { throw new Error("env missing"); } });
    const res = await onRequest({ request: get() }, async () => html());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<body>hi</body>");
  });

  test("an unknown chart type or a missing label is refused", () => {
    expect(() => normalizeAdminResponse({ blocks: [{ type: "chart", chart: "area" as never, points: [] }] })).toThrow(/bar" or "line/);
    expect(() => chart([{ value: 1 } as never])).toThrow(/label/);
  });

  test("a sink that drops the event leaves the page unstamped", async () => {
    const res = await recordView({ request: get(), response: html(), sink: { write: async () => false } });
    expect(await res.text()).not.toContain("pramen-view");
  });

  test("a non-UTF-8 page is left alone on the buffered path", async () => {
    const g = globalThis as { HTMLRewriter?: unknown };
    const saved = g.HTMLRewriter;
    g.HTMLRewriter = undefined;
    try {
      const sink = new MemorySink();
      await recordView({ request: get(), response: html({ headers: { "content-type": "text/html; charset=windows-1250" } }), sink });
      expect(sink.events).toHaveLength(0);
    } finally {
      g.HTMLRewriter = saved;
    }
  });

  test("non-string text in a chart is refused rather than crashing the page", () => {
    expect(() => normalizeAdminResponse({ blocks: [{ type: "chart", title: { en: "x" } as never, points: [] }] })).toThrow(/title/);
    expect(() => normalizeAdminResponse({ blocks: [{ type: "chart", unit: 5 as never, points: [] }] })).toThrow(/unit/);
    expect(() => chart([{ label: "a", value: 1, title: 3 as never }])).toThrow(/title/);
  });

  test("a negative value is refused", () => {
    expect(() => chart([{ label: "a", value: -1 }])).toThrow(/negative/);
  });

  test("more than the cap is refused", () => {
    const many = Array.from({ length: MAX_ADMIN_CHART_POINTS + 1 }, (_, i) => ({ label: String(i), value: i }));
    expect(() => chart(many)).toThrow(/at most/);
  });

  test("the axis rounds up to a readable maximum", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(37)).toBe(50);
    expect(niceMax(100)).toBe(100);
    expect(niceMax(101)).toBe(200);
    expect(niceMax(4)).toBe(5);
    expect(niceMax(0.3)).toBe(0.5);
  });
});
