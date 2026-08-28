// @pramen/cms-astro — the `pramenCms()` Astro integration (issue #35).
//
// The integration is the front door: one typed `backend` descriptor instead of a base URL
// repeated at every call site, and generated collections instead of a hand-written
// `defineCollection` per content type that has to track rows in the store.
//
// These drive the real hooks with fakes for Astro's, and assert on the SOURCE the virtual
// module emits — that is the contract a site consumes.

import { describe, expect, test } from "bun:test";
import { pramenCms } from "../packages/cms-astro/src/integration";

type VitePlugin = { name: string; enforce?: string; resolveId: (id: string) => string | null; load: (id: string) => string | null };

/** Run `astro:config:setup` with fakes, and hand back what the integration produced. */
async function setup(opts: Parameters<typeof pramenCms>[0], types: string[] | Error = ["article", "page"]) {
  const logs: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    types instanceof Error
      ? new Response(JSON.stringify({ ok: false, error: types.message }), { status: 500 })
      : new Response(JSON.stringify({ ok: true, result: types.map((slug) => ({ slug, name: slug })) }))) as typeof fetch;
  try {
    let plugin: VitePlugin | undefined;
    const integration = pramenCms(opts);
    await integration.hooks["astro:config:setup"]!({
      updateConfig: (cfg: { vite?: { plugins?: VitePlugin[] } }) => { plugin = cfg.vite?.plugins?.[0]; return cfg as never; },
      logger: { info: (m: string) => logs.push(`info:${m}`), warn: (m: string) => logs.push(`warn:${m}`) },
    } as never);
    const code = plugin?.load(plugin.resolveId("pramen:cms")!) ?? "";
    return { plugin: plugin!, code, logs };
  } finally {
    globalThis.fetch = original;
  }
}

describe("pramenCms()", () => {
  test("refuses to build without a backend url rather than fetching undefined", () => {
    expect(() => pramenCms({} as never)).toThrow(/needs a backend url/);
    expect(() => pramenCms({ backend: { url: "" } })).toThrow(/needs a backend url/);
  });

  test("resolves the `pramen:cms` virtual module and nothing else", async () => {
    const { plugin } = await setup({ backend: { url: "https://cms.example.workers.dev" } });
    expect(plugin.resolveId("pramen:cms")).toBe("\0pramen:cms");
    expect(plugin.resolveId("astro:content")).toBeNull();
    expect(plugin.load("\0pramen:cms")).toContain("export const collections");
    expect(plugin.load("some/other/module.ts")).toBeNull();
    // `pre`, so a bare specifier is not reported as a missing package first.
    expect(plugin.enforce).toBe("pre");
  });

  test("generates one collection per content type, named after the slug", async () => {
    const { code, logs } = await setup({ backend: { url: "https://cms.example.workers.dev" } });
    expect(code).toContain('article: defineCollection({ loader: cmsLoader({ client, type: "article" }) })');
    expect(code).toContain('page: defineCollection({ loader: cmsLoader({ client, type: "page" }) })');
    expect(logs.join()).toContain("2 collection(s)");
  });

  test("an explicit map wins, and keeps the site's own names", async () => {
    const { code } = await setup({ backend: { url: "https://cms.example.workers.dev" }, collections: { clanky: "article" } });
    expect(code).toContain('clanky: defineCollection({ loader: cmsLoader({ client, type: "article" }) })');
    expect(code).not.toContain("page:"); // the store's other type is not generated
  });

  test("the backend descriptor reaches the client — base url, tenant and token", async () => {
    const { code } = await setup({ backend: { url: "https://cms.example.workers.dev", tenant: "acme", token: "t0ken" } });
    expect(code).toContain('createCmsClient({"baseUrl":"https://cms.example.workers.dev","tenant":"acme","token":"t0ken"})');
  });

  test("a locale restriction is threaded into every generated loader", async () => {
    const { code } = await setup({ backend: { url: "https://x.dev" }, locale: "cs" });
    expect(code.match(/locale: "cs"/g)).toHaveLength(2); // both collections
  });

  // The site imports `resolve` instead of re-instantiating the client (or duplicating the
  // base URL) just to build a media URL.
  test("the module exports the client and a bound resolve()", async () => {
    const { code } = await setup({ backend: { url: "https://x.dev" } });
    expect(code).toContain("export const client");
    expect(code).toContain("export const resolve");
  });

  // A build that cannot reach the CMS must FAIL. Producing zero collections instead would
  // build green and deploy an empty site.
  test("discovery failure fails the build, and names the way out", async () => {
    await expect(setup({ backend: { url: "https://cms.example.workers.dev" } }, new Error("boom"))).rejects.toThrow(
      /could not read content types.*collections: \{ articles: "article" \}/s,
    );
  });

  test("an empty store warns rather than failing — a legitimate early state", async () => {
    const { code, logs } = await setup({ backend: { url: "https://x.dev" } }, []);
    expect(logs.join()).toContain("warn:no content types found");
    expect(code).toContain("export const collections = {");
  });

  // A slug is author-controlled and lands in generated source as an object key.
  test("a slug that cannot be an identifier is refused with the explicit-map fix", async () => {
    await expect(setup({ backend: { url: "https://x.dev" } }, ["my type"])).rejects.toThrow(/cannot be a collection name/);
    await expect(setup({ backend: { url: "https://x.dev" } }, ["2fast"])).rejects.toThrow(/cannot be a collection name/);
  });

  test("injects the virtual module's types so the site needs no hand-written d.ts", () => {
    const injected: { filename: string; content: string }[] = [];
    pramenCms({ backend: { url: "https://x.dev" } }).hooks["astro:config:done"]!({
      injectTypes: (t: { filename: string; content: string }) => { injected.push(t); return new URL("file:///x"); },
    } as never);
    expect(injected[0]!.filename).toBe("pramen-cms.d.ts");
    expect(injected[0]!.content).toContain('declare module "pramen:cms"');
  });
});

// --- embed: the CMS inside the site's own Worker -----------------------------------
//
// Astro's Cloudflare adapter writes `dist/_worker.js/index.js` as an ordinary ES module, so
// a wrapper can import it, re-export the Durable Object and route by path — no adapter
// support needed. These pin what the wrapper says, because it is a deploy artifact nobody
// reads until it misbehaves.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run `astro:build:done` in a throwaway project directory. */
async function build(embed: NonNullable<Parameters<typeof pramenCms>[0]["embed"]>, opts: { wrangler?: string; app?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pramen-embed-"));
  mkdirSync(join(root, "src", "cms"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "my-site" }));
  if (opts.app !== false) writeFileSync(join(root, "src/cms/app.ts"), "export default {};");
  if (opts.wrangler) writeFileSync(join(root, opts.wrangler), "{}");
  const logs: string[] = [];
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await pramenCms({ backend: { url: "https://x.dev" }, collections: {}, embed }).hooks["astro:build:done"]!({
      dir: new URL(`file://${root}/dist/`),
      logger: { info: (m: string) => logs.push(`info:${m}`), warn: (m: string) => logs.push(`warn:${m}`) },
    } as never);
  } finally {
    process.chdir(cwd);
  }
  const entryPath = join(root, embed.entry ?? "dist/_pramen-entry.mjs");
  return { root, logs, entry: existsSync(entryPath) ? readFileSync(entryPath, "utf8") : "", hasWrangler: existsSync(join(root, "wrangler.jsonc")) };
}

describe("pramenCms({ embed })", () => {
  test("does nothing at all unless `embed` is set", async () => {
    const logs: string[] = [];
    await pramenCms({ backend: { url: "https://x.dev" }, collections: {} }).hooks["astro:build:done"]!({
      dir: new URL("file:///tmp/"), logger: { info: (m: string) => logs.push(m), warn: () => {} },
    } as never);
    expect(logs).toEqual([]);
  });

  test("writes an entrypoint that imports the adapter's worker and re-exports the DO", async () => {
    const { entry } = await build({ app: "./src/cms/app.ts" });
    expect(entry).toContain('import astro from "./_worker.js/index.js"');
    expect(entry).toContain("export const PramenDO = pramen.PramenDO");
    expect(entry).toContain('createPramen(app, { basePath: BASE })');
    // The outbox drain and the queue consumer are pramen's; Astro has neither.
    expect(entry).toContain("scheduled: pramen.scheduled");
    expect(entry).toContain("queue: pramen.queue");
  });

  test("the app import is RELATIVE to the entry, not an absolute machine path", async () => {
    const { entry, root } = await build({ app: "./src/cms/app.ts" });
    expect(entry).toContain('import app from "../src/cms/app.ts"');
    expect(entry).not.toContain(root); // no build machine baked into a committed artifact
  });

  test("the mount prefix defaults to /_pramen and is normalized", async () => {
    expect((await build({ app: "./src/cms/app.ts" })).entry).toContain('const BASE = "/_pramen"');
    expect((await build({ app: "./src/cms/app.ts", basePath: "cms/" })).entry).toContain('const BASE = "/cms"');
  });

  test("routes the prefix to pramen and everything else to Astro", async () => {
    const { entry } = await build({ app: "./src/cms/app.ts" });
    expect(entry).toContain('if (pathname === BASE || pathname.startsWith(BASE + "/")) return pramen.fetch');
    expect(entry).toContain("return astro.fetch(request, env, ctx)");
  });

  test("a missing app module fails the build, naming what it looked for", async () => {
    await expect(build({ app: "./src/cms/missing.ts" }, { app: false })).rejects.toThrow(/embed.app points at .*missing\.ts, which does not exist/);
  });

  test("writes a wrangler config when there is none, with the DO migration", async () => {
    const { hasWrangler, logs, root } = await build({ app: "./src/cms/app.ts" });
    expect(hasWrangler).toBe(true);
    const cfg = readFileSync(join(root, "wrangler.jsonc"), "utf8");
    expect(cfg).toContain('"new_sqlite_classes": ["PramenDO"]');
    expect(cfg).toContain('"main": "dist/_pramen-entry.mjs"');
    expect(cfg).toContain('"name": "my-site"'); // taken from package.json
    expect(logs.join()).toContain("warn:wrote wrangler.jsonc");
  });

  // A deploy config is someone's checked-in artifact. Rewriting it from a build step is not
  // something a build step gets to do.
  test("NEVER edits an existing wrangler config — it prints what to add instead", async () => {
    for (const name of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
      const { root, logs } = await build({ app: "./src/cms/app.ts" }, { wrangler: name });
      expect(readFileSync(join(root, name), "utf8")).toBe("{}"); // untouched
      expect(logs.join()).toContain(`${name} left untouched`);
      expect(logs.join()).toContain("new_sqlite_classes");
    }
  });

  test("`wrangler: false` writes no config even when none exists", async () => {
    const { hasWrangler, entry } = await build({ app: "./src/cms/app.ts", wrangler: false });
    expect(hasWrangler).toBe(false);
    expect(entry).not.toBe(""); // the entrypoint is still written
  });
});
