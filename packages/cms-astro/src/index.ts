// @pramen/cms-astro — consume a @pramen/cms backend from a (static or SSR) Astro site.
//
//   - `createCmsClient({ baseUrl })` — fetch the public content API (getPage, listPublishedPages).
//   - `cmsLoader({ client })` — an Astro **content-collection loader** that pulls published
//     pages at BUILD time, so `defineCollection({ loader: cmsLoader(...) })` makes CMS content
//     available via `getCollection()` / `getEntry()` and the site renders it as static HTML.
//     Re-run the build (a publish webhook) to refresh.
//   - `BlockRenderer.astro` (separate import) renders a page's blocks with your components.
//
// Self-contained: no @pramen/server dependency — it just speaks the CMS's HTTP RPC.

import type { Loader, LoaderContext } from "astro/loaders";

// The integration — the front door (`pramenCms()`), re-exported so
// `import pramenCms from "@pramen/cms-astro"` works. The kit of parts below stays exported:
// a site that defines its own collections by hand still can.
export { pramenCms, default } from "./integration.js";
export type { CmsBackend, CollectionMap, PramenCmsOptions } from "./integration.js";

// The admin mount — the editor served as an injected route on this site (`admin: true`).
export { ADMIN_BASE, ADMIN_ROUTE } from "./admin.js";
export type { AdminOptions, AdminRuntimeConfig } from "./admin.js";

/** Any JSON value — the wire form of everything the CMS stores. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A resolved media reference (a `"media"` block field, resolved by the CMS). */
export interface ResolvedMedia {
  id: string;
  key: string;
  url: string;
  alt: string | null;
  contentType: string | null;
  filename: string | null;
}

/** A rich-text document — the structured JSON a `richtext` field stores. Mirrors
 * `RichTextDoc` in @pramen/cms; render it with `RichText.astro`. Never an HTML string:
 * nothing on this path uses `set:html`. */
export interface RichTextDoc {
  type: "doc";
  content?: RichTextNode[];
}

/** One node in a {@link RichTextDoc}. */
export interface RichTextNode {
  type: string;
  content?: RichTextNode[];
  text?: string;
  marks?: RichTextMark[];
  attrs?: Record<string, JsonValue>;
}

/** An inline mark on a text node. */
export interface RichTextMark {
  type: string;
  attrs?: Record<string, JsonValue>;
}

/** Allow-list for a link href: http(s), mailto, tel, or a relative/anchor path — a single
 * leading slash, and the next character neither `/` nor `\` (both resolve off-site while
 * looking local; the URL parser folds `\` to `/` at path-start).
 *
 * A local mirror of `isSafeHref` in @pramen/cms, because this package deliberately has no
 * dependency on it. `RichText.astro` checks every link with it: the write path normalizes,
 * but a row written by an app's own mutation, a bootstrap seed or an import script never
 * passed through that, and this renderer is what puts it on a page. */
export function isSafeHref(raw: unknown): boolean {
  return typeof raw === "string" && /^(https?:\/\/|mailto:|tel:|\/(?![/\\])|#)/i.test(normalizeHref(raw));
}

/** Strip the characters the WHATWG URL parser ignores before parsing (ASCII tab/CR/LF),
 * then trim. Without this, `/\r\n/evil.example/x` passes a naive prefix test and still
 * resolves to `https://evil.example/x`. Render THIS form, so what was checked is what
 * the browser resolves. */
export function normalizeHref(raw: string): string {
  return raw.replace(/[\t\n\r]/g, "").trim();
}

export interface RenderedBlock {
  id: string;
  /** Optimistic-concurrency token — pass back as `expectedVersion` on a write. */
  version: number;
  block_id: string;
  block_type: string;
  title: string | null;
  fields: Record<string, unknown>;
  is_shared: boolean;
}

export interface AssembledPage {
  page: {
    id: string;
    title: string;
    slug: string;
    status: string;
    locale: string;
    /** The page's content-type slug (e.g. "article", "page"). `null` if unknown. */
    contentType: string | null;
    translationGroupId: string | null;
    translations: { locale: string; slug: string }[];
    fields: Record<string, unknown> | null;
    metaTitle: string | null;
    metaDescription: string | null;
    seo?: Record<string, unknown>;
    /** Optimistic-concurrency token — pass back as `expectedVersion` on a write. */
    version: number;
  };
  regions: Record<string, RenderedBlock[]>;
  /** True when this is a live draft fetched through a preview link, not the published
   * snapshot — render a "viewing a draft" banner off it. */
  isPreview?: boolean;
}

export interface PublishedPageRef {
  slug: string;
  locale: string;
  /** Content-type slug — lets a loader filter to one type (see `CmsLoaderOptions.type`). */
  contentType: string | null;
  updatedAt: string;
}

export interface CmsClientOptions {
  /** Base URL of the deployed @pramen/cms Worker, e.g. https://cms.example.workers.dev. */
  baseUrl: string;
  /** Tenant (`x-pramen-tenant`). Default "main". */
  tenant?: string;
  /** Optional bearer token (only needed to fetch drafts via preview). */
  token?: string;
}

export interface CmsClient {
  getPage(slug: string, locale?: string): Promise<AssembledPage | null>;
  /** Redeem a signed preview link. The token names one page and carries its own expiry,
   * so this needs no session — pass through whatever arrived in the request's query. */
  getPreview(token: string): Promise<AssembledPage | null>;
  /** Published page refs, optionally narrowed to one content type and/or locale. The
   * narrowing is done by the SERVER: the handler caps its result, so filtering the answer
   * afterwards filters an already-truncated list and loses the tail of every type. */
  listPublishedPages(filter?: { contentType?: string; locale?: string }): Promise<PublishedPageRef[]>;
  /** Resolve a request path to its redirect, or `null`.
   *
   * The half of the redirects manager that makes it a feature rather than a list: the CMS
   * stores the mapping, and something has to serve it. Call this from your 404 path (see
   * `redirectResponse`), not on every request — a lookup per page view would put a round
   * trip in front of every render to answer "no" almost every time. */
  resolveRedirect(path: string): Promise<{ to: string; status: number } | null>;
  /** Absolute URL for a relative CMS path (e.g. a media `/media/...` url). */
  resolve(path: string): string;
  readonly baseUrl: string;
}

/** A typed HTTP client for the CMS public content API. */
export function createCmsClient(opts: CmsClientOptions): CmsClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const call = async <T>(name: string, input: unknown): Promise<T | null> => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-pramen-tenant": opts.tenant ?? "main",
    });
    if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
    const res = await fetch(`${base}/rpc/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input ?? {}),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; code?: string };
    if (body.ok !== true) {
      if (body.code === "not_found") return null;
      throw new Error(`@pramen/cms-astro: ${name} failed (HTTP ${res.status}${body.code ? `, ${body.code}` : ""})`);
    }
    return body.result as T;
  };
  return {
    baseUrl: base,
    getPage: (slug, locale) => call<AssembledPage>("getPage", { slug, locale }),
    getPreview: async (token) => {
      // Not an /rpc call: the preview route is public and pre-auth, and the signature IS
      // the authorization, so there is no bearer token to send.
      const res = await fetch(`${base}/cms/preview?token=${encodeURIComponent(token)}`);
      if (res.ok) return (await res.json().catch(() => null)) as AssembledPage | null;
      // 403/404 mean "this link is not valid" — an ordinary not-found for the caller.
      // Anything else (notably 503, "preview is not configured") is an operator problem
      // and must not masquerade as a missing page.
      if (res.status === 403 || res.status === 404) return null;
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new Error(`@pramen/cms-astro: preview failed (HTTP ${res.status}${body.code ? `, ${body.code}` : ""}${body.error ? `: ${body.error}` : ""})`);
    },
    listPublishedPages: async (filter) => (await call<PublishedPageRef[]>("listPublishedPages", filter ?? {})) ?? [],
    resolveRedirect: (path) => call<{ to: string; status: number } | null>("resolveRedirect", { path }).then((r) => r ?? null),
    resolve: (path) => (path.startsWith("http") ? path : `${base}${path}`),
  };
}

export interface CmsLoaderOptions {
  client: CmsClient;
  /** Restrict to one locale (else every published page of every locale is loaded). */
  locale?: string;
  /** Restrict to one content-type slug (e.g. "article" or "page"), so separate collections
   * can each load their own type. Omit to load every type. */
  type?: string;
  /**
   * Map an AssembledPage to the entry `data` stored in the collection. Default flattens the
   * page's own `fields` up to the top level and adds `title/slug/locale/seo/regions/blocks`
   * (all blocks in document order) — so an Astro schema can read the page's fields directly.
   */
  transform?: (page: AssembledPage) => Record<string, unknown>;
}

const defaultTransform = (p: AssembledPage): Record<string, unknown> => {
  const blocks = Object.values(p.regions).flat();
  return {
    ...(p.page.fields ?? {}),
    title: p.page.title,
    slug: p.page.slug,
    locale: p.page.locale,
    contentType: p.page.contentType,
    status: p.page.status,
    seo: p.page.seo ?? null,
    translations: p.page.translations,
    regions: p.regions,
    blocks,
  };
};

/** An Astro content-collection loader backed by a @pramen/cms Worker. Fetches every
 * published page at build time; the entry `id` is the page slug. Wire it into a collection:
 *
 *   const clanky = defineCollection({ loader: cmsLoader({ client }) });
 */
export function cmsLoader(opts: CmsLoaderOptions): Loader {
  const transform = opts.transform ?? defaultTransform;
  return {
    name: "@pramen/cms",
    async load({ store, logger, parseData, generateDigest }: LoaderContext): Promise<void> {
      // Narrowed SERVER-side. `listPublishedPages` caps its result, so filtering the answer
      // here would be filtering an already-truncated list: with `collections: "auto"` every
      // generated collection asks for the same capped page of rows and each one silently
      // loses the tail of its own type — with a green build. The client-side pass below is
      // kept as a belt: a CMS older than the `contentType`/`locale` inputs ignores them and
      // answers with the pooled list, and a collection quietly full of another type's pages
      // is worse than one that is merely short.
      const refs = await opts.client.listPublishedPages({ contentType: opts.type, locale: opts.locale });
      const wanted = refs.filter((r) => (opts.locale ? r.locale === opts.locale : true) && (opts.type ? r.contentType === opts.type : true));
      store.clear();
      let loaded = 0;
      for (const ref of wanted) {
        const page = await opts.client.getPage(ref.slug, ref.locale);
        if (!page) continue;
        const raw = transform(page);
        const data = await parseData({ id: ref.slug, data: raw });
        store.set({ id: ref.slug, data, digest: generateDigest(data) });
        loaded++;
      }
      logger.info(`@pramen/cms: loaded ${loaded} published page(s)`);
    },
  };
}

/**
 * A `Response` for a request that would otherwise 404, if the CMS has a redirect for it.
 *
 * Returns `null` when there is none, so the caller falls through to its own 404 — this is a
 * REPAIR for a URL that used to work, not a router.
 *
 * Wire it where your framework handles a miss:
 *
 * ```ts
 * // src/pages/404.astro (or a middleware's not-found branch)
 * const redirect = await redirectResponse(client, Astro.url);
 * if (redirect) return redirect;
 * ```
 *
 * A lookup costs a round trip, which is why it belongs on the 404 path and not in front of
 * every render: the answer is "no redirect" for essentially every request that resolves.
 *
 * The destination is re-checked here even though the CMS canonicalized it on write. This
 * function turns a value from the store into a `Location` header, and the write that
 * produced it may predate that validation — a stored `javascript:` or protocol-relative
 * target would otherwise be handed to the browser verbatim.
 */
export async function redirectResponse(client: CmsClient, url: URL | string): Promise<Response | null> {
  const path = typeof url === "string" ? url : url.pathname;
  // Every failure degrades to "no redirect", because this runs ON THE 404 PATH: a throw
  // here turns every miss on the site into a 500. And there are several — `//pricing`
  // (doubled slash) is refused by the server's own path rule, a backend predating
  // `resolveRedirect` answers 400, and an anonymous role predating the `cms_redirects`
  // grant is denied. None of those is a reason to stop rendering a 404. `getPage` already
  // degrades this way; this did not.
  let hit: { to: string; status: number } | null = null;
  try {
    hit = await client.resolveRedirect(path);
  } catch {
    return null;
  }
  if (!hit) return null;
  const to = normalizeHref(hit.to);
  const ok = /^https?:\/\//i.test(to) || (to.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\"));
  if (!ok) return null;
  // Only the four real redirect statuses; anything else in the row is treated as a
  // permanent move rather than passed through as an arbitrary response code.
  const status = [301, 302, 307, 308].includes(hit.status) ? hit.status : 301;
  return new Response(null, { status, headers: { location: to } });
}
