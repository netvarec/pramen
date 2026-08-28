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

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve as resolvePath } from "node:path";
import type { AstroIntegration } from "astro";

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
   * Run the CMS **inside this site's Worker** instead of deploying a second one.
   *
   * Astro's Cloudflare adapter writes `dist/_worker.js/index.js` as an ordinary ES module,
   * so a wrapper can import it, re-export the Durable Object, and route by path — no
   * adapter support needed. This generates that wrapper at the end of `astro build`, and
   * the wrangler config to go with it when there isn't one.
   *
   * The CMS then answers under `basePath` on the site's own origin: no second deployment,
   * no CORS, one URL. `backend.url` should point at that same origin (or be omitted for
   * a relative client).
   */
  embed?: {
    /** Path to your pramen app module, relative to the project root — the module whose
     * default export is `{ schema, handlers, acl, … }`. */
    app: string;
    /** Where the CMS answers on the site's origin. Default `"/_pramen"`. Everything pramen
     * serves lives under it, `app.routes` included, so nothing can collide with a page. */
    basePath?: string;
    /** Where to write the generated entrypoint. Default `"dist/_pramen-entry.mjs"`. */
    entry?: string;
    /** Write a `wrangler.jsonc` when none exists. Default `true`. An EXISTING file is
     * never edited — the bindings it would need are logged instead, because silently
     * rewriting a checked-in deploy config is not a thing a build step should do. */
    wrangler?: boolean;
  };
}

/** The virtual module the site imports from. */
const VIRTUAL_ID = "pramen:cms";
const RESOLVED_ID = "\0pramen:cms";

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
import { createCmsClient, cmsLoader } from "@pramen/cms-astro/runtime";

export const client = createCmsClient(${clientOpts});

/** Absolute URL for a media path the CMS returned. Same base as the client, so a component
 * never has to be handed the client (or a duplicated base URL) just to show an image. */
export const resolve = (path) => client.resolve(path);

export const collections = {
${entries}
};
`;
}

/** The generated Worker entrypoint. This is the whole trick behind running the CMS in the
 * site's Worker: the adapter writes `dist/_worker.js/index.js` as an ordinary ES module with
 * a default export, so we import it, re-export the Durable Object beside it, and route by
 * path. Nothing here depends on adapter internals or on the adapter supporting extra
 * exports — verified against @astrojs/cloudflare 12 on wrangler dev. */
function entrySource(appImport: string, basePath: string): string {
  return `// GENERATED by @pramen/cms-astro — the Worker entrypoint. Point wrangler's \`main\` here.
// Regenerated by every \`astro build\`; edit the integration options, not this file.
import astro from "./_worker.js/index.js";
import { createPramen } from "@pramen/server/worker";
import app from ${JSON.stringify(appImport)};

// Every pramen route lives under this prefix, \`app.routes\` included — so the site keeps
// its own /sitemap.xml, /robots.txt and every page path.
const BASE = ${JSON.stringify(basePath)};
const pramen = createPramen(app, { basePath: BASE });

/** The Durable Object, exported from the SAME script as the site. This is what makes it one
 * deployment instead of two. */
export const PramenDO = pramen.PramenDO;

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === BASE || pathname.startsWith(BASE + "/")) return pramen.fetch(request, env, ctx);
    return astro.fetch(request, env, ctx);
  },
  // The outbox drain (D1 store) and the Queues consumer are pramen's; Astro has neither.
  scheduled: pramen.scheduled,
  queue: pramen.queue,
};
`;
}

/** A wrangler config for the embedded topology — written only when there is none. */
function wranglerSource(name: string, entry: string): string {
  return `{
  // GENERATED by @pramen/cms-astro. Written because no wrangler config existed; it is
  // yours now and will not be overwritten.
  "name": ${JSON.stringify(name)},
  "main": ${JSON.stringify(entry)},
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
  // Astro's build output, served by the same Worker.
  "assets": { "directory": "./dist", "binding": "ASSETS" },
  "vars": { "AUTH_SECRET": "change-me-at-least-16-chars" },
  "kv_namespaces": [{ "binding": "KV", "id": "REPLACE_WITH_YOUR_KV_ID" }],
  // The CMS's storage. The DO IS the database — one per tenant.
  "durable_objects": { "bindings": [{ "name": "PRAMEN", "class_name": "PramenDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["PramenDO"] }],
  // Media (R2). Drop this if the CMS stores no files.
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "REPLACE_WITH_YOUR_BUCKET" }]
}
`;
}

/** What an EXISTING wrangler config needs, printed rather than written. */
const WRANGLER_HINT = `add to your wrangler config:
  "main": "<entry>",
  "durable_objects": { "bindings": [{ "name": "PRAMEN", "class_name": "PramenDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["PramenDO"] }],
  "kv_namespaces": [{ "binding": "KV", "id": "…" }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "…" }]   // if the CMS stores media`;

/** The `pramen:cms` module's types, injected so the site gets them with no manual d.ts. */
const TYPES = `declare module "pramen:cms" {
  import type { CmsClient } from "@pramen/cms-astro/runtime";
  /** The configured CMS client — same instance the collections load through. */
  export const client: CmsClient;
  /** Absolute URL for a media path the CMS returned. */
  export function resolve(path: string): string;
  /** Generated content collections. Re-export from src/content.config.ts:
   *  \`export { collections } from "pramen:cms";\` */
  export const collections: Record<string, unknown>;
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
      "astro:config:setup": async ({ updateConfig, logger }) => {
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
        updateConfig({
          vite: {
            plugins: [
              {
                name: "pramen:cms",
                // `enforce: "pre"` so this resolves before Astro's own alias handling sees
                // an unknown bare specifier and reports it as a missing package.
                enforce: "pre" as const,
                resolveId(id: string) {
                  return id === VIRTUAL_ID ? RESOLVED_ID : null;
                },
                load(id: string) {
                  return id === RESOLVED_ID ? code : null;
                },
              },
            ],
          },
        });
      },
      "astro:config:done": ({ injectTypes }) => {
        injectTypes({ filename: "pramen-cms.d.ts", content: TYPES });
      },
      // The site's Worker is only written at the END of the build (the adapter emits
      // dist/_worker.js there), so the wrapper that imports it has to be written after.
      "astro:build:done": async ({ dir, logger }) => {
        const embed = opts.embed;
        if (!embed) return;
        const root = process.cwd();
        const entry = embed.entry ?? "dist/_pramen-entry.mjs";
        const entryAbs = resolvePath(root, entry);
        const basePath = `/${(embed.basePath ?? "/_pramen").replace(/^\/+|\/+$/g, "")}`;

        // The app import is written RELATIVE to the entry file, because the entry lives in
        // dist/ and the app in src/ — an absolute path would bake this machine into a
        // committed artifact.
        const appRel = relative(dirname(entryAbs), resolvePath(root, embed.app)).replace(/\\/g, "/");
        const appImport = appRel.startsWith(".") ? appRel : `./${appRel}`;
        if (!existsSync(resolvePath(root, embed.app))) {
          throw new Error(`@pramen/cms-astro: embed.app points at ${embed.app}, which does not exist (resolved from ${root})`);
        }
        await mkdir(dirname(entryAbs), { recursive: true });
        await writeFile(entryAbs, entrySource(appImport, basePath));
        logger.info(`embedded CMS entrypoint → ${entry} (serving ${basePath}/* from this Worker)`);

        // A wrangler config is a deploy artifact someone owns. Write one only if there is
        // none; otherwise say what it needs and let them decide.
        const existing = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].find((f) => existsSync(resolvePath(root, f)));
        if (existing) {
          logger.info(`${existing} left untouched — ${WRANGLER_HINT.replace("<entry>", entry)}`);
        } else if (embed.wrangler !== false) {
          const name = (JSON.parse(await readFile(resolvePath(root, "package.json"), "utf8").catch(() => "{}")) as { name?: string }).name ?? "astro-pramen";
          await writeFile(resolvePath(root, "wrangler.jsonc"), wranglerSource(name, entry));
          logger.warn(`wrote wrangler.jsonc — fill in the KV id and R2 bucket before deploying`);
        }
        void dir;
      },
    },
  };
}

export default pramenCms;
