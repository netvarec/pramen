// The Astro integration — one front door for a @pramen/cms backend (issue #35).
//
// Before this, a site hand-wired the kit of parts: instantiate `createCmsClient` in
// `content.config.ts`, write one `defineCollection({ loader: cmsLoader({ client, type }) })`
// per content type, then re-instantiate or re-import the client anywhere else that needs
// `resolve()` for a media URL. Two things drifted: the base URL was repeated at every call
// site, and the hand-written collection list had to be kept in step with content types that
// are runtime ROWS — so adding a type in the editor silently did nothing until someone
// remembered to edit the config.
//
// `pramenCms()` owns both. It builds the client once from a typed `backend` descriptor and
// exposes it (plus the collections) through the `pramen:cms` virtual module.
//
// ON REGISTERING COLLECTIONS. Astro has no API for an integration to define content
// collections — `astro:config:setup` offers routes, scripts, middleware, renderers and Vite
// config, and nothing for the content layer (checked against Astro 7). Collections must be
// exported from `src/content.config.ts`. So the integration generates them and the site
// re-exports in one line:
//
//   // src/content.config.ts
//   export { collections } from "pramen:cms";
//
// That is the honest version of "the integration registers them": one line that never
// changes, instead of one `defineCollection` per type that has to track the store.

import type { AstroIntegration } from "astro";
import { fileURLToPath } from "node:url";
import { ADMIN_BASE, ADMIN_ROUTE, adminDocumentTitle, adminRuntimeConfig, serializeAdminConfig, type AdminOptions } from "./admin.js";

/** Where the CMS lives. A named descriptor rather than a bare `baseUrl` string, so a future
 * local/in-process backend can be added without changing the call shape. */
export interface CmsBackend {
  /** The Worker's origin, e.g. `https://cms.example.workers.dev`. */
  url: string;
  /** Tenant to read. Default `"main"`. */
  tenant?: string;
  /** Bearer token, for reading a private deployment at build time. The public content API
   * needs none — pass one only if your ACL does not grant anonymous reads. */
  token?: string;
}

/** One generated collection: the Astro collection name, and the CMS content type it loads. */
export type CollectionMap = Record<string, string>;

export interface PramenCmsOptions {
  backend: CmsBackend;
  /**
   * Which collections to generate.
   *
   * - `"auto"` (default) — one collection per content type in the store, named after the
   *   type's slug. Discovered at config time, so adding a type in the editor takes effect
   *   on the next build with no code change.
   * - an explicit map — `{ articles: "article", pages: "page" }` — when you want your own
   *   names, or a subset.
   *
   * `"auto"` costs one request during `astro:config:setup`. If it fails (the CMS is down,
   * or unreachable from CI) the build FAILS rather than silently producing zero
   * collections, which would otherwise surface as `getCollection("articles")` returning
   * nothing and a site that builds green and empty.
   */
  collections?: "auto" | CollectionMap;
  /** Restrict every generated collection to one locale. Omit to load all of them. */
  locale?: string;
  /**
   * Serve the visual editor from this site, at `/_pramen/admin`.
   *
   * `true` mounts it against the same `backend` the collections load from; an object also
   * carries the editor's own configuration (`brand`, `signInUrl`, `hidePages`, `extraNav`).
   * Omit it and no admin route is injected at all — nothing is added to the site, and
   * `@pramen/cms-editor` need not be installed.
   *
   * The route is a real Astro route, so deep links and refreshes are served by this site's
   * router and the editor's two assets go through its bundler. There is nothing to deploy
   * separately, no SPA-fallback rewrite to configure, and no second hostname for the editor.
   *
   * It does NOT move the API: the editor still calls `backend.url`, so a CMS on its own
   * Worker stays cross-origin and still needs `CORS_ORIGINS`.
   */
  admin?: AdminOptions;
}

/** The virtual module the site imports from. */
const VIRTUAL_ID = "pramen:cms";
const RESOLVED_ID = "\0pramen:cms";

/** A second one for the admin shell. Separate from `pramen:cms` so the injected route does
 * not drag `astro:content` and the generated collections into a runtime page. */
const ADMIN_VIRTUAL_ID = "pramen:cms/admin";
const ADMIN_RESOLVED_ID = "\0pramen:cms/admin";

/** Ask the CMS which content types exist. Public and un-gated (`listPublicContentTypes`),
 * because this runs at BUILD time where there is no editor session — and a content type's
 * slug is already public: `listPublishedPages` returns it for every published page. */
async function discoverTypes(backend: CmsBackend): Promise<string[]> {
  const base = backend.url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json", "x-pramen-tenant": backend.tenant ?? "main" };
  if (backend.token) headers.authorization = `Bearer ${backend.token}`;
  const res = await fetch(`${base}/rpc/listPublicContentTypes`, { method: "POST", headers, body: "{}" });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { slug: string }[]; error?: string };
  if (body.ok !== true || !Array.isArray(body.result)) {
    throw new Error(
      `@pramen/cms-astro: collections: "auto" could not read content types from ${base} (HTTP ${res.status}${body.error ? `: ${body.error}` : ""}). ` +
        `Pass an explicit map instead — collections: { articles: "article" } — or make the CMS reachable from this build.`,
    );
  }
  return body.result.map((t) => t.slug).filter((s) => typeof s === "string" && s !== "");
}

/** A valid JS identifier-ish collection name. A content-type slug is author-controlled, and
 * it lands in generated source as an object key — quote it, and refuse the ones that cannot
 * be a collection name at all rather than emitting code that fails to parse. */
function collectionKey(slug: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(slug)) {
    throw new Error(`@pramen/cms-astro: content-type slug ${JSON.stringify(slug)} cannot be a collection name — map it explicitly, e.g. collections: { myName: ${JSON.stringify(slug)} }`);
  }
  return slug;
}

/** Generate the virtual module's source. Everything the site needs from one import:
 * the configured client, `resolve()` for media URLs, and the collections. */
function moduleSource(backend: CmsBackend, map: CollectionMap, locale?: string): string {
  const clientOpts = JSON.stringify({ baseUrl: backend.url, tenant: backend.tenant, token: backend.token });
  const entries = Object.entries(map)
    .map(([name, type]) => `  ${collectionKey(name)}: defineCollection({ loader: cmsLoader({ client, type: ${JSON.stringify(type)}${locale ? `, locale: ${JSON.stringify(locale)}` : ""} }) }),`)
    .join("\n");
  return `// GENERATED by @pramen/cms-astro (pramenCms integration) — do not edit.
import { defineCollection } from "astro:content";
import { createCmsClient, cmsLoader } from "@pramen/cms-astro";

export const client = createCmsClient(${clientOpts});

/** Absolute URL for a media path the CMS returned. Same base as the client, so a component
 * never has to be handed the client (or a duplicated base URL) just to show an image. */
export const resolve = (path) => client.resolve(path);

export const collections = {
${entries}
};
`;
}

/** Generate the admin shell's module: the mount prefix, the runtime config already
 * serialized for an inline script, and the fallback tab title. Values, not logic — the
 * shell is a template. */
function adminModuleSource(admin: AdminOptions, backend: CmsBackend): string {
  const cfg = adminRuntimeConfig(admin, backend);
  return `// GENERATED by @pramen/cms-astro (pramenCms integration) — do not edit.
export const adminBasePath = ${JSON.stringify(ADMIN_BASE)};
export const adminConfigScript = ${JSON.stringify(serializeAdminConfig(cfg))};
export const adminTitle = ${JSON.stringify(adminDocumentTitle(cfg))};
`;
}

/** The `pramen:cms` module's types, injected so the site gets them with no manual d.ts. */
const TYPES = `declare module "pramen:cms" {
  import type { CmsClient } from "@pramen/cms-astro";
  /** The configured CMS client — same instance the collections load through. */
  export const client: CmsClient;
  /** Absolute URL for a media path the CMS returned. */
  export function resolve(path: string): string;
  /** Generated content collections. Re-export from src/content.config.ts:
   *  \`export { collections } from "pramen:cms";\` */
  export const collections: Record<string, unknown>;
}
`;

/** The admin shell's module types. Injected only when the admin route is. */
const ADMIN_TYPES = `declare module "pramen:cms/admin" {
  /** The prefix the admin route was injected at — stamped onto the editor's mount node. */
  export const adminBasePath: string;
  /** The editor's runtime config, serialized for an inline <script>. */
  export const adminConfigScript: string;
  /** Pre-hydration fallback for the shell's <title>. */
  export const adminTitle: string;
}
`;

/**
 * The Astro integration for a @pramen/cms backend.
 *
 *   import pramenCms from "@pramen/cms-astro";
 *
 *   export default defineConfig({
 *     integrations: [pramenCms({ backend: { url: "https://cms.example.workers.dev" } })],
 *   });
 *
 * Then, once, in `src/content.config.ts`:
 *
 *   export { collections } from "pramen:cms";
 *
 * `createCmsClient` / `cmsLoader` stay exported — this is the front door, not a
 * replacement. A site that wants to define its own collections by hand still can.
 */
export function pramenCms(opts: PramenCmsOptions): AstroIntegration {
  if (!opts?.backend?.url) throw new Error("@pramen/cms-astro: pramenCms() needs a backend url — pramenCms({ backend: { url: \"https://cms.example.workers.dev\" } })");
  return {
    name: "@pramen/cms-astro",
    hooks: {
      "astro:config:setup": async ({ updateConfig, injectRoute, logger }) => {
        const wanted = opts.collections ?? "auto";
        const map: CollectionMap = wanted === "auto" ? Object.fromEntries((await discoverTypes(opts.backend)).map((s) => [collectionKey(s), s])) : wanted;
        const names = Object.keys(map);
        if (names.length === 0) {
          // Not an error: a store with no content types yet is a legitimate early state.
          // It IS worth saying out loud, because the symptom otherwise is `getCollection`
          // throwing about a collection the site is sure it configured.
          logger.warn(`no content types found at ${opts.backend.url} — no collections generated`);
        } else {
          logger.info(`${names.length} collection(s) from ${opts.backend.url}: ${names.join(", ")}`);
        }
        const code = moduleSource(opts.backend, map, opts.locale);
        // Only when asked. A site that just reads content never installs @pramen/cms-editor,
        // and an injected route would be a build error rather than an unused page.
        const adminCode = opts.admin ? adminModuleSource(opts.admin, opts.backend) : undefined;
        updateConfig({
          vite: {
            // The editor's bundle is a finished artifact, not source for this build to walk:
            // it is emitted verbatim and referenced by url. `?url` alone asks for that, and
            // this says so for the file itself, since a `.js` extension is otherwise the one
            // thing a bundler assumes it should follow.
            assetsInclude: ["**/@pramen/cms-editor/dist/editor.js"],
            plugins: [
              {
                name: "pramen:cms",
                // `enforce: "pre"` so this resolves before Astro's own alias handling sees
                // an unknown bare specifier and reports it as a missing package.
                enforce: "pre" as const,
                resolveId(id: string) {
                  if (id === VIRTUAL_ID) return RESOLVED_ID;
                  if (id === ADMIN_VIRTUAL_ID && adminCode) return ADMIN_RESOLVED_ID;
                  return null;
                },
                load(id: string) {
                  if (id === RESOLVED_ID) return code;
                  if (id === ADMIN_RESOLVED_ID) return adminCode;
                  return null;
                },
              },
            ],
          },
        });
        if (adminCode) {
          // One catch-all: every in-app URL is a real server route, so a deep link and a
          // refresh are served like any other page. The pattern and the prefix the shell
          // stamps on the mount node are the same constant — see admin.ts.
          injectRoute({ pattern: ADMIN_ROUTE, entrypoint: fileURLToPath(new URL("./PramenAdmin.astro", import.meta.url)) });
          logger.info(`editor mounted at ${ADMIN_BASE}`);
        }
      },
      "astro:config:done": ({ injectTypes }) => {
        injectTypes({ filename: "pramen-cms.d.ts", content: opts.admin ? `${TYPES}\n${ADMIN_TYPES}` : TYPES });
      },
    },
  };
}

export default pramenCms;
