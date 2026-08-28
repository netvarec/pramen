// `basePath` — mounting the pramen worker under a prefix so it can SHARE an origin with a
// site (the Astro-in-one-worker topology). Absolute routes are right for a Worker that is
// only pramen, and wrong the moment something else owns the origin: an Astro app would find
// pramen had taken `/sitemap.xml`.
//
// Drives `makeWorker` directly — no DO needed, because every assertion here is about which
// path matches, which is decided before any dispatch.

import { describe, expect, test } from "bun:test";
import { makeWorker } from "../packages/server/src/worker";
import { defineSchema, Entity, primaryKey, generated } from "../packages/server/src/sdk/schema";

const schema = defineSchema({ notes: Entity((t) => ({ id: primaryKey(generated(t.uuid())), title: t.text() })) });
const routes = [{ method: "GET", path: "/sitemap.xml", handler: () => Promise.resolve(new Response("<urlset/>", { status: 200 })) }];
const app = { schema, handlers: {}, acl: [], routes };

const env = { AUTH_SECRET: "a-sufficiently-long-test-secret" } as never;
const ctx = {} as never;
const get = (worker: ReturnType<typeof makeWorker>, path: string) => worker.fetch(new Request(`https://x.dev${path}`), env, ctx);

describe("worker basePath", () => {
  // An unmatched path answers with pramen's usage banner (200 text/plain), NOT a 404 —
  // so these assert on the body, which is what actually distinguishes "the route matched"
  // from "fell through".
  const isSitemap = async (res: Response) => (await res.text()).includes("<urlset/>");

  test("unmounted (the default) keeps every route absolute", async () => {
    const w = makeWorker(app);
    expect(await isSitemap(await get(w, "/sitemap.xml"))).toBe(true);
    expect(await isSitemap(await get(w, "/_pramen/sitemap.xml"))).toBe(false); // falls through to the banner
  });

  test("mounted, the SAME routes answer under the prefix", async () => {
    const w = makeWorker(app, { basePath: "/_pramen" });
    expect(await isSitemap(await get(w, "/_pramen/sitemap.xml"))).toBe(true);
  });

  // The point of the prefix: everything pramen serves moves, `app.routes` included, so the
  // embedding worker forwards exactly one pattern and nothing leaks to the site's paths.
  test("mounted, the unprefixed path is NOT ours — the site keeps it", async () => {
    const w = makeWorker(app, { basePath: "/_pramen" });
    const res = await get(w, "/sitemap.xml");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not found", code: "not_found" });
  });

  test("a request outside the prefix never reaches a route that would match unprefixed", async () => {
    const w = makeWorker(app, { basePath: "/_pramen" });
    // `/tenants` is a built-in; unmounted it answers (403 without an admin token), and
    // under a prefix it must not answer at the bare path at all.
    expect((await get(w, "/tenants")).status).toBe(404);
    expect((await get(w, "/_pramen/tenants")).status).toBe(403);
  });

  test("the prefix is normalized, so `/p`, `p` and `/p/` all mount the same", async () => {
    for (const basePath of ["/_pramen", "_pramen", "/_pramen/"]) {
      const w = makeWorker(app, { basePath });
      expect(await isSitemap(await get(w, "/_pramen/sitemap.xml"))).toBe(true);
    }
  });

  test("a path that merely starts with the prefix STRING is not inside the mount", async () => {
    const w = makeWorker(app, { basePath: "/_pramen" });
    expect((await get(w, "/_pramenade/sitemap.xml")).status).toBe(404);
  });
});
