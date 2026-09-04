// The example Astro site, built and served for real.
//
// Everything else about the admin mount is unit-tested — the integration's hooks in
// `cms-astro-integration.test.ts`, the router wiring in `cms-editor-mount.test.ts`. What
// neither can see is the half that actually broke the last attempt at this feature: whether
// a REAL Astro build emits the editor's assets at URLs the shell can reach, and whether the
// injected route serves a deep link. Those only exist once `astro build` has run.
//
// So this builds `example/site` against a stub CMS, boots the output, and asks the server.
// The adapter is @astrojs/node because it is the one this repo can boot; a real deployment
// uses @astrojs/cloudflare, and nothing asserted below is adapter-specific.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_BASE } from "../packages/cms-astro/src/admin";

const ROOT = join(import.meta.dir, "..");
const SITE = join(ROOT, "example/site");
const CMS_PORT = 8790;
const SITE_PORT = 8791;
const SITE_BASE = `http://localhost:${SITE_PORT}`;
const CMS_URL = `http://localhost:${CMS_PORT}`;
// IMPORTED, not written out again. A second copy of the mount path is a second thing to
// remember to change, and the one time it was one, the whole admin half of this file went red
// against a site that was serving the editor perfectly well. `cms-astro-integration.test.ts`
// is where the literal value is pinned; here it only has to be the SAME value the integration
// injected.
const ADMIN = ADMIN_BASE;

/** One published article, in the shape `getPage` returns. */
const PAGE = {
  page: {
    id: "p1",
    title: "Hello world",
    slug: "hello-world",
    status: "published",
    locale: "cs",
    contentType: "article",
    translationGroupId: null,
    translations: [],
    fields: {},
    metaTitle: null,
    metaDescription: null,
    seo: { metaDescription: "An example article." },
    version: 1,
  },
  regions: {
    main: [
      {
        id: "b1",
        version: 1,
        block_id: "b1",
        block_type: "rich_text",
        title: null,
        is_shared: false,
        fields: { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body text." }] }] } },
      },
    ],
  },
};

/** The same page as an unpublished DRAFT, in the shape `/cms/preview` returns — a bare
 * `AssembledPage` with `isPreview`, not the `{ ok, result }` envelope /rpc uses. */
const DRAFT = {
  ...PAGE,
  page: { ...PAGE.page, title: "Work in progress", status: "draft" },
  regions: {
    main: [
      {
        ...PAGE.regions.main[0],
        fields: { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Unpublished body." }] }] } },
      },
    ],
  },
  isPreview: true,
};

/** A stub of the CMS's public content API — the two calls `cmsLoader` makes at build time.
 * A stub rather than the real Worker so this test costs a build and not a wrangler boot;
 * `test/suites/cms.ts` is where the real handlers are exercised. */
function stubCms() {
  return Bun.serve({
    port: CMS_PORT,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const json = (result: unknown) => Response.json({ ok: true, result });
      if (pathname === "/rpc/listPublishedPages") return json([{ slug: PAGE.page.slug, locale: PAGE.page.locale, contentType: "article", updatedAt: "2026-08-30T00:00:00.000Z" }]);
      if (pathname === "/rpc/getPage") return json(PAGE);
      // The preview redemption route — NOT an /rpc call and not an envelope: the real one is
      // public, pre-auth, and answers with the assembled draft directly. `good` stands in for
      // a valid signature; anything else is what an expired or forged token gets.
      if (pathname === "/cms/preview") {
        const token = new URL(req.url).searchParams.get("token");
        if (token !== "good") return Response.json({ error: "invalid preview link", code: "forbidden" }, { status: 403 });
        return Response.json(DRAFT);
      }
      return Response.json({ ok: false, code: "not_found" }, { status: 404 });
    },
  });
}

/** Run a build step to completion, surfacing its whole output when it fails. */
async function run(cmd: string[], cwd: string, env: Record<string, string>, label: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${label} failed (exit ${code}):\n${out}\n${err}`);
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not become ready in time`);
}

let cms: ReturnType<typeof stubCms> | undefined;
let site: ReturnType<typeof Bun.spawn> | undefined;
/** The shell, fetched once — every assertion below reads the same response. */
let shell = "";
let shellHeaders: Headers | undefined;

beforeAll(async () => {
  // The site imports the editor's build output, so it has to exist and be current.
  await run(["bun", "run", "--cwd", "packages/cms-editor", "build"], ROOT, {}, "cms-editor build");

  cms = stubCms();

  // ASYNC, not spawnSync: the stub above serves from this same event loop, and a blocking
  // spawn would deadlock the build the moment `cmsLoader` fetches from it.
  rmSync(join(SITE, "dist"), { recursive: true, force: true });
  await run(["./node_modules/.bin/astro", "build"], SITE, { PRAMEN_CMS_URL: CMS_URL }, "astro build");

  site = Bun.spawn(["node", "./dist/server/entry.mjs"], {
    cwd: SITE,
    env: { ...process.env, HOST: "localhost", PORT: String(SITE_PORT) },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForReady(`${SITE_BASE}/`, 30_000);

  const res = await fetch(`${SITE_BASE}${ADMIN}`);
  shellHeaders = res.headers;
  shell = await res.text();
}, 180_000);

afterAll(() => {
  site?.kill();
  cms?.stop(true);
});

// `bun run typecheck` at the repo root cannot cover this site: `astro check` runs the
// content loaders (it syncs before it checks), so it needs the CMS reachable — and the CMS
// is reachable exactly here, where the stub is up. It is the only thing that type-checks
// `.astro` files at all; nothing else in the repo does.
describe("example site: types", () => {
  test("the site typechecks, .astro files included", async () => {
    await run(["./node_modules/.bin/astro", "check"], SITE, { PRAMEN_CMS_URL: CMS_URL }, "astro check");
  }, 120_000);
});

describe("example site: content", () => {
  test("published pages are pulled at build time and rendered statically", async () => {
    const res = await fetch(`${SITE_BASE}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Hello world");
    expect(html).toContain(`href="/${PAGE.page.slug}"`);
  });

  test("a page renders its blocks through the site's own components", async () => {
    const res = await fetch(`${SITE_BASE}/${PAGE.page.slug}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Body text.");
    // Mapped, so the placeholder for an unknown block type is NOT what rendered.
    expect(html).not.toContain("Unknown block type");
    expect(html).toContain('content="An example article."');
  });
});

// The half a headless CMS cannot supply. `/cms/preview` answers with JSON, because the
// server has the draft and no idea what it should look like; the SITE renders it, through
// the same layout the published route uses — a preview drawn by a second copy of the markup
// is a preview of the copy.
describe("example site: preview links", () => {
  test("a valid token renders the DRAFT, through the site's own layout", async () => {
    const res = await fetch(`${SITE_BASE}/preview?token=good`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Work in progress");
    expect(html).toContain("Unpublished body.");
    // The same components as the published route: the block rendered, rather than falling
    // through to the unknown-type placeholder.
    expect(html).not.toContain("Unknown block type");
  });

  test("it says it is a draft, and refuses to be indexed", async () => {
    const html = await (await fetch(`${SITE_BASE}/preview?token=good`)).text();
    expect(html).toContain("Draft preview");
    expect(html).toContain('name="robots"');
    expect(html).toContain("noindex");
  });

  test("a draft is never cached — not by the browser and not in between", async () => {
    const res = await fetch(`${SITE_BASE}/preview?token=good`);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  test("a bad or absent token is an ordinary 404, saying nothing about what exists", async () => {
    for (const path of ["/preview?token=forged", "/preview"]) {
      const res = await fetch(`${SITE_BASE}${path}`);
      expect(res.status).toBe(404);
      // Uniform: a distinct "expired" would confirm a page id to anyone spraying tokens.
      expect(await res.text()).not.toContain("Work in progress");
    }
  });

  test("the published route is unaffected — no draft leaks into a static page", async () => {
    const html = await (await fetch(`${SITE_BASE}/${PAGE.page.slug}`)).text();
    expect(html).toContain("Hello world");
    expect(html).not.toContain("Draft preview");
    expect(html).not.toContain("Unpublished body.");
  });
});

describe("example site: the admin route", () => {
  test("the injected route serves the editor's shell", () => {
    expect(shell).toContain('<div id="app"');
    expect(shellHeaders?.get("content-type")).toContain("text/html");
  });

  // The whole point of an injected route: `/…/pages/:id` is a real server route, so a deep
  // link and a refresh are served like any other page. No SPA-fallback rewrite anywhere.
  test("a deep link is served by the server, not by a rewrite", async () => {
    for (const path of [`${ADMIN}/media`, `${ADMIN}/pages/abc`, `${ADMIN}/collections/lectures/1`]) {
      const res = await fetch(`${SITE_BASE}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="app"');
    }
  });

  test("the shell hands the editor the prefix it was injected at", () => {
    expect(shell).toContain(`data-base-path="${ADMIN}"`);
  });

  test("the shell declares the backend, so nothing asks a human for it", () => {
    expect(shell).toContain("window.PRAMEN_CMS_EDITOR=");
    expect(shell).toContain(`\\"url\\":\\"${CMS_URL}\\"`.replaceAll("\\", ""));
    expect(shell).toContain('"tenant":"main"');
  });

  test("the configured wordmark reaches the page, replacing /config.js", () => {
    expect(shell).toContain('"name":"Example"');
    expect(shell).toContain("<title>Example · cms</title>");
  });

  test("the shell is never stored by a shared cache", () => {
    expect(shellHeaders?.get("cache-control")).toBe("private, no-store");
  });
});

// The finding that sank the previous attempt: a baked index.html could only reference
// `/editor.js` root-absolute, so the one deployment shape the feature existed for was the
// one shape it could not boot in. These assert the opposite — that the site's own bundler
// emitted both assets and the shell points at where they actually are.
describe("example site: the editor's assets", () => {
  test("no index.html or config.js is shipped by the editor package", () => {
    expect(existsSync(join(ROOT, "packages/cms-editor/dist/index.html"))).toBe(false);
    expect(existsSync(join(ROOT, "packages/cms-editor/dist/config.js"))).toBe(false);
  });

  test("the bundle is emitted by the site's build and loads under the prefix", async () => {
    const src = /<script type="module" src="([^"]+)"/.exec(shell)?.[1];
    expect(src).toBeDefined();
    // Fingerprinted by the site, not by us — proof the site's bundler owns the file.
    expect(src).toMatch(/editor\..+\.js$/);
    const res = await fetch(new URL(src!, `${SITE_BASE}${ADMIN}/`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect((await res.text()).length).toBeGreaterThan(100_000);
  });

  test("the stylesheet is emitted too, with the web font inlined into it", async () => {
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(shell)?.[1];
    expect(href).toBeDefined();
    const res = await fetch(new URL(href!, `${SITE_BASE}${ADMIN}/`));
    expect(res.status).toBe(200);
    const css = await res.text();
    // Inlined, so the stylesheet references nothing relative to where it happens to land.
    expect(css).toContain("data:font/woff2;base64,");
    expect(css).not.toContain("url('./fonts/");
  });
});
