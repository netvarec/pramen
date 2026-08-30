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
