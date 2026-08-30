// @pramen/cms-astro — the `pramenCms()` Astro integration (issue #35).
//
// The integration is the front door: one typed `backend` descriptor instead of a base URL
// repeated at every call site, and generated collections instead of a hand-written
// `defineCollection` per content type that has to track rows in the store.
//
// These drive the real hooks with fakes for Astro's, and assert on the SOURCE the virtual
// module emits — that is the contract a site consumes.

import { describe, expect, test } from "bun:test";
import { ADMIN_BASE, adminDocumentTitle, adminRuntimeConfig, serializeAdminConfig } from "../packages/cms-astro/src/admin";
import { pramenCms } from "../packages/cms-astro/src/integration";

type VitePlugin = { name: string; enforce?: string; resolveId: (id: string) => string | null; load: (id: string) => string | null };

/** Run `astro:config:setup` with fakes, and hand back what the integration produced. */
async function setup(opts: Parameters<typeof pramenCms>[0], types: string[] | Error = ["article", "page"]) {
  const logs: string[] = [];
  const injected: { pattern: string; entrypoint: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    types instanceof Error
      ? new Response(JSON.stringify({ ok: false, error: types.message }), { status: 500 })
      : new Response(JSON.stringify({ ok: true, result: types.map((slug) => ({ slug, name: slug })) }))) as typeof fetch;
  try {
    let plugin: VitePlugin | undefined;
    let vite: { assetsInclude?: string[] } | undefined;
    const integration = pramenCms(opts);
    await integration.hooks["astro:config:setup"]!({
      updateConfig: (cfg: { vite?: { plugins?: VitePlugin[]; assetsInclude?: string[] } }) => { plugin = cfg.vite?.plugins?.[0]; vite = cfg.vite; return cfg as never; },
      injectRoute: (route: { pattern: string; entrypoint: string }) => injected.push(route),
      logger: { info: (m: string) => logs.push(`info:${m}`), warn: (m: string) => logs.push(`warn:${m}`) },
    } as never);
    const code = plugin?.load(plugin.resolveId("pramen:cms")!) ?? "";
    const adminId = plugin?.resolveId("pramen:cms/admin") ?? null;
    const adminCode = adminId ? (plugin!.load(adminId) ?? "") : "";
    return { plugin: plugin!, code, adminCode, injected, vite: vite!, logs };
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

// ─── The admin route ────────────────────────────────────────────────────────
//
// The editor is served BY the site, as an injected Astro route, rather than deployed as a
// static `dist/` beside it. Everything below is a property that architecture buys and the
// old index.html could not: no route unless asked for, one constant behind both the route
// pattern and the prefix the shell hands the router, and a backend the editor is TOLD
// rather than asked to have someone type.

describe("pramenCms({ admin })", () => {
  test("no admin option means no route, and nothing to resolve", async () => {
    const { injected, plugin, adminCode } = await setup({ backend: { url: "https://cms.example.workers.dev" } });
    expect(injected).toHaveLength(0);
    // Not just unrouted — unresolvable, so a stray import fails loudly instead of loading
    // a shell for a mount that does not exist.
    expect(plugin.resolveId("pramen:cms/admin")).toBeNull();
    expect(adminCode).toBe("");
  });

  test("one catch-all route, so a deep link and a refresh are served like any page", async () => {
    const { injected, logs } = await setup({ backend: { url: "https://cms.example.workers.dev" }, admin: true });
    expect(injected).toHaveLength(1);
    expect(injected[0].pattern).toBe(`${ADMIN_BASE}/[...path]`);
    expect(injected[0].entrypoint).toEndWith("/PramenAdmin.astro");
    expect(logs.join()).toContain(`editor mounted at ${ADMIN_BASE}`);
  });

  test("the shell is handed the same prefix the route was injected at", async () => {
    const { adminCode } = await setup({ backend: { url: "https://cms.example.workers.dev" }, admin: true });
    // The drift a configurable prefix invites: a router mounted somewhere the server does
    // not serve. One constant feeds both, so this is an identity, not a coincidence.
    expect(adminCode).toContain(`export const adminBasePath = ${JSON.stringify(ADMIN_BASE)};`);
  });

  test("the editor is told its backend, so the Setup screen asks for a token only", async () => {
    const { adminCode } = await setup({ backend: { url: "https://cms.example.workers.dev/", tenant: "acme" }, admin: true });
    expect(adminCode).toContain('\\"backend\\":{\\"url\\":\\"https://cms.example.workers.dev\\",\\"tenant\\":\\"acme\\"}');
  });

  test("the editor's own configuration rides along, typed", async () => {
    const { adminCode } = await setup({
      backend: { url: "https://cms.example.workers.dev" },
      admin: { brand: { name: "Acme", suffix: null }, hidePages: true, extraNav: [{ label: "Curation", href: "/curate" }] },
    });
    expect(adminCode).toContain('\\"hidePages\\":true');
    expect(adminCode).toContain('\\"label\\":\\"Curation\\"');
    // The pre-hydration tab title follows brand.ts's rule: a configured name replaces the
    // whole string, and `suffix: null` drops the second half.
    expect(adminCode).toContain('export const adminTitle = "Acme";');
  });

  test("the editor bundle is emitted as an asset, not walked as source", async () => {
    const { vite } = await setup({ backend: { url: "https://cms.example.workers.dev" }, admin: true });
    expect(vite.assetsInclude).toContain("**/@pramen/cms-editor/dist/editor.js");
  });

  test("the admin module's types are injected only when the route is", () => {
    const written: Record<string, string> = {};
    const injectTypes = ({ filename, content }: { filename: string; content: string }) => { written[filename] = content; };
    pramenCms({ backend: { url: "https://x.dev" } }).hooks["astro:config:done"]!({ injectTypes } as never);
    expect(written["pramen-cms.d.ts"]).not.toContain("pramen:cms/admin");
    pramenCms({ backend: { url: "https://x.dev" }, admin: true }).hooks["astro:config:done"]!({ injectTypes } as never);
    expect(written["pramen-cms.d.ts"]).toContain('declare module "pramen:cms/admin"');
  });
});

describe("the editor's runtime config in an inline <script>", () => {
  // Every field here is content someone types. A `</script>` in a brand name or a nav label
  // would close the tag early and drop the rest of the page into the HTML parser.
  test("a closing tag in any string value cannot break out", () => {
    const script = serializeAdminConfig({ backend: { url: "https://x.dev", tenant: "main" }, brand: { name: "</script><script>alert(1)</script>" } });
    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c/script>");
    // Still valid JS that parses back to what went in.
    const parsed = JSON.parse(script.slice("window.PRAMEN_CMS_EDITOR=".length, -1));
    expect(parsed.brand.name).toBe("</script><script>alert(1)</script>");
  });

  test("a trailing slash on the backend url is normalized once, here", () => {
    expect(adminRuntimeConfig(true, { url: "https://x.dev///" })).toEqual({ backend: { url: "https://x.dev", tenant: "main" } });
  });

  test("the fallback title mirrors brand.ts, including the unbranded default", () => {
    const backend = { url: "https://x.dev", tenant: "main" };
    expect(adminDocumentTitle({ backend })).toBe("pramen · cms editor");
    expect(adminDocumentTitle({ backend, brand: { name: "Acme" } })).toBe("Acme · cms");
    expect(adminDocumentTitle({ backend, brand: { name: "Acme", suffix: "docs" } })).toBe("Acme · docs");
    expect(adminDocumentTitle({ backend, brand: { name: "Acme", suffix: null } })).toBe("Acme");
    // A brand that yields no usable name keeps the default; the bundle warns about it.
    expect(adminDocumentTitle({ backend, brand: { name: "   " } })).toBe("pramen · cms editor");
  });
});
