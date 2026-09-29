// The Worker-side collector: record a pageview when a Worker served the page.
//
// This is the first of the two collectors (see `tracker.ts` for the second). It sees what a
// browser beacon cannot: every visitor who blocks scripts or has JavaScript off, plus the
// request's country and city. It cannot see how long anyone stayed, so it stamps the page
// with `<meta name="pramen-view" content="…">` and the beacon, finding that tag, reports only
// engagement against the same id instead of counting the visit a second time.
//
// It is a function over `(Request, Response)` and not a framework plugin, so the same code
// serves a plain Worker, an Astro middleware (`analyticsMiddleware` below) and anything else
// that can hand it a rendered response.

import type { EnvBag } from "@pramen/server";
import { defaultSalt, sessionId } from "./collect";
import { dayOf, deriveDevice, deriveSource, isBot, normalizePath, type AnalyticsEvent } from "./events";
import type { AnalyticsSink } from "./sink";
import { VIEW_META } from "./tracker";

/** A page can tell the collector which CMS page it rendered by setting this response header.
 * The server is the only collector that can know it, and it is what keeps a page's history
 * whole across a slug rename. Stripped before the response leaves. */
export const PAGE_ID_HEADER = "x-pramen-page-id";

export interface RecordViewOptions {
  request: Request;
  response: Response;
  sink: AnalyticsSink;
  /** Where the session salt comes from when `salt` is not given: `ANALYTICS_SALT`, falling
   * back to `AUTH_SECRET`. */
  env?: EnvBag;
  /** Salt for `sessionId`; null disables sessions. */
  salt?: string | null;
  /** The signed-in user, when the site has one. Stored as given. */
  userId?: string | null;
  /** Host the site is served from, so an internal referral is not counted as a source.
   * Defaults to the request's own host. */
  selfHost?: string | null;
}

interface RequestGeo {
  country?: string;
  city?: string;
}

/** Whether this exchange is one a pageview should be recorded for.
 *
 * Every refusal below is a case where recording would be WRONG rather than merely
 * unnecessary, since a false pageview is a number someone will read as a visit:
 *  - not a GET for a 200 HTML document: an asset, an API answer or an error page is not a view;
 *  - a bot: same filter as the beacon, so the two collectors agree on what a visitor is;
 *  - a prefetch or prerender, or a fragment fetch: the browser asked, the person did not;
 *  - Do Not Track / Global Privacy Control, which the beacon honours too;
 *  - a response a shared cache may replay. The Worker then sees one request in many, and the
 *    id it stamped would be handed to every visitor the cache serves, collapsing them into a
 *    single view. The same holds for the visitor's own browser cache. Those pages fall through
 *    to the beacon, which counts each load. */
export function shouldRecord(request: Request, response: Response): boolean {
  if (request.method !== "GET") return false;
  if (response.status !== 200) return false;
  // An encoded body cannot be stamped: the rewriter and `.text()` both need it decoded, and
  // re-emitting the original `content-encoding` over a changed body corrupts the page.
  if (response.headers.has("content-encoding")) return false;
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return false;
  if (isBot(request.headers.get("user-agent"))) return false;
  const purpose = `${request.headers.get("purpose") ?? ""} ${request.headers.get("sec-purpose") ?? ""}`.toLowerCase();
  if (/prefetch|prerender/.test(purpose)) return false;
  // A document navigation says so. A fragment fetch (a server island, htmx, a client-side
  // data request) says `empty`, and has no <head> to stamp: recording it would count a view
  // the parent page's beacon then counts again. An absent header (older Safari) is allowed.
  const dest = request.headers.get("sec-fetch-dest");
  if (dest !== null && dest !== "document" && dest !== "iframe") return false;
  if (request.headers.get("hx-request") !== null) return false;
  if (request.headers.get("dnt") === "1" || request.headers.get("sec-gpc") === "1") return false;
  // ANY positive freshness lifetime means a later load may never reach the Worker: a shared
  // cache replays it, and so does the visitor's own browser (`private, max-age=300`, on a
  // reload or back navigation). The stamped id would then be reused and the beacon, finding
  // it, would send no pageview, so the visit is counted nowhere. `no-store` overrides.
  const cache = (response.headers.get("cache-control") ?? "").toLowerCase();
  if (!/\bno-store\b/.test(cache)) {
    if (/\b(?:s-maxage|max-age)\s*=\s*"?[1-9]/.test(cache)) return false;
    // With no Cache-Control at all, `Expires` in the future or a `Last-Modified` (heuristic
    // freshness) lets a browser reuse the page just the same.
    if (cache === "") {
      const expires = Date.parse(response.headers.get("expires") ?? "");
      if (Number.isFinite(expires) && expires > Date.now()) return false;
      if (response.headers.has("last-modified")) return false;
    }
  }
  return true;
}

interface RewriterCtor {
  new (): {
    on(selector: string, handlers: { element(el: { prepend(content: string, opts: { html: boolean }): void }): void }): { transform(r: Response): Response };
  };
}

/** KNOWN LIMIT: with `HTMLRewriter` (the Workers runtime) the body streams, so this cannot
 * look ahead for a `<head>`. A 200 HTML response with no `<head>` element is recorded but
 * cannot carry the tag, and the beacon then counts that load a second time. Real documents
 * have a head; fragments are refused by `shouldRecord` from their `Sec-Fetch-Dest` /
 * `HX-Request`. Buffering every page to close the gap was rejected as a memory and latency
 * cost on every request to fix a case that needs a hand-rolled template to occur.
 *
 * Put the view id into the document's `<head>`. `HTMLRewriter` streams it on the Workers
 * runtime; the string fallback buffers the page and exists for runtimes without one (tests,
 * local Node), where a page is small. */
async function stamp(response: Response, viewId: string): Promise<Response> {
  const tag = `<meta name="${VIEW_META}" content="${viewId}">`;
  const headers = new Headers(response.headers);
  headers.delete(PAGE_ID_HEADER);
  // The body length changes, so the original would truncate or hang the response.
  headers.delete("content-length");
  // Validators describe the ORIGINAL bytes. Every view's body differs by its id, so keeping
  // an ETag would let a revalidation hand one visitor another's stamped page.
  for (const h of ["etag", "content-md5", "digest"]) headers.delete(h);
  const init = { status: response.status, statusText: response.statusText, headers };

  const Rewriter = (globalThis as { HTMLRewriter?: RewriterCtor }).HTMLRewriter;
  if (Rewriter) {
    return new Rewriter().on("head", { element: (el) => el.prepend(tag, { html: true }) }).transform(new Response(response.body, init));
  }
  const html = await response.text();
  return new Response(html.replace(HEAD_RE, (m) => `${m}${tag}`), init);
}

/** `<head>` or `<head attr>`, and NOT `<header>`. */
const HEAD_RE = /<head(\s[^>]*)?>/i;

export function stripPageId(response: Response): Response {
  if (!response.headers.has(PAGE_ID_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.delete(PAGE_ID_HEADER);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Record the pageview for a served response, and return the response to send.
 *
 * The write is AWAITED, so the page waits as long as the sink does. With a queue producer
 * that is sub-millisecond; with `DirectSink` it is a write into the tenant's Durable Object
 * on every page, and contention there becomes time-to-first-byte. Bind the `ANALYTICS` queue
 * for any site with real traffic (`createEdgeSink` requires it). The wait cannot move to
 * `waitUntil`, because the stamp must not be added for an event the sink did not accept.
 *
 * NEVER THROWS, and never delays the page more than the sink does. Analytics must not be
 * able to take a page down, so any failure here returns the original response untouched and
 * logs it. The tag is added only AFTER the sink accepted the event: stamping a page whose
 * view was lost would make the beacon report engagement for a pageview that does not exist,
 * and that visit would be counted nowhere. */
export async function recordView(opts: RecordViewOptions): Promise<Response> {
  const { request, response } = opts;
  // Declared outside the try: once the body has been read, the ORIGINAL response is spent,
  // and every exit (including the catch) must serve the buffered text instead.
  let buffered: string | null = null;
  const current = (): Response => {
    if (buffered === null) return response;
    // `.text()` drops a BOM, so the original length no longer matches the body.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(buffered, { status: response.status, statusText: response.statusText, headers });
  };
  try {
    if (!shouldRecord(request, response)) return stripPageId(response);

    // Without HTMLRewriter the page is buffered anyway, so check it CAN be stamped before
    // recording: a view that cannot carry the tag would be counted again by the beacon.
    if (!(globalThis as { HTMLRewriter?: unknown }).HTMLRewriter) {
      // `.text()` decodes as UTF-8, and the page is re-emitted under its ORIGINAL charset
      // header: a windows-1250 page would come back corrupted for every recorded view. Left
      // to the beacon, unread.
      const charset = /charset\s*=\s*"?([^\s;"]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
      if (charset && !/^utf-?8$/i.test(charset)) return stripPageId(response);
      buffered = await response.text();
      if (!HEAD_RE.test(buffered)) return stripPageId(current());
    }

    const now = new Date().toISOString();
    const day = dayOf(now);
    const url = new URL(request.url);
    const ua = request.headers.get("user-agent");
    const referrer = request.headers.get("referer");
    const cf = (request as Request & { cf?: RequestGeo }).cf;
    const salt = opts.salt !== undefined ? opts.salt : opts.env ? defaultSalt(opts.env) : null;
    const pageId = response.headers.get(PAGE_ID_HEADER);
    const viewId = crypto.randomUUID();

    const event: AnalyticsEvent = {
      kind: "pageview",
      origin: "server",
      viewId,
      ts: now,
      day,
      path: normalizePath(url.pathname),
      pageId: pageId && pageId.length <= 64 ? pageId : null,
      referrer: referrer ? referrer.slice(0, 1024) : null,
      source: deriveSource(referrer, opts.selfHost ?? url.hostname),
      country: typeof cf?.country === "string" ? cf.country : null,
      city: typeof cf?.city === "string" ? cf.city : null,
      device: deriveDevice(ua),
      sessionId: await sessionId(salt, request.headers.get("cf-connecting-ip"), ua, day),
      userId: opts.userId ?? null,
    };

    // `false` is a sink that dropped the event: not stamped, so the beacon still counts it.
    if ((await opts.sink.write([event])) === false) return stripPageId(current());
    return await stamp(current(), viewId);
  } catch (e) {
    console.error("@pramen/analytics: recording a pageview failed", e);
    // If a rewriter already took the body there is nothing left to serve, and building a
    // Response from it would throw out of a function that promises not to. That state needs a
    // failure between two synchronous calls, so it is answered rather than engineered around.
    if (buffered === null && (response.bodyUsed || response.body?.locked)) return new Response("Internal Server Error", { status: 500 });
    return stripPageId(current());
  }
}

/** The slice of Astro's `APIContext` the middleware reads. Structural, so this package
 * needs no `astro` dependency and works with any version that has `onRequest(context, next)`. */
export interface MiddlewareContext {
  request: Request;
  locals?: Record<string, unknown>;
}

export interface AnalyticsMiddlewareOptions {
  /** Build the sink for a request. On a Worker that is not the pramen one, this is a queue
   * producer (`createEdgeSink`): the visitor's request cannot wait on another Worker's
   * database, and there is no `callPrivileged` here to reach it. */
  sink: (context: MiddlewareContext) => AnalyticsSink;
  env?: (context: MiddlewareContext) => EnvBag | undefined;
  userId?: (context: MiddlewareContext) => string | null | undefined;
  selfHost?: string;
}

/** An Astro middleware (`onRequest`) that records a pageview for every rendered HTML page.
 *
 *   // src/middleware.ts
 *   import { analyticsMiddleware } from "@pramen/analytics";
 *   export const onRequest = analyticsMiddleware({ sink: () => sinkFor(env), env: () => env });
 *
 * Runs AFTER the page has rendered (it wraps `next()`), so it sees the final status and
 * content type, and a page can set `x-pramen-page-id` to name the CMS page it drew. */
export function analyticsMiddleware(opts: AnalyticsMiddlewareOptions) {
  return async (context: MiddlewareContext, next: () => Promise<Response>): Promise<Response> => {
    const response = await next();
    // The option callbacks are the caller's code and run OUTSIDE `recordView`'s catch if they
    // are evaluated as its arguments: a throwing `sink` (an undefined `env`) or `userId`
    // accessor would 500 a page that already rendered. So they are evaluated here, guarded.
    try {
      return await recordView({
        request: context.request,
        response,
        sink: opts.sink(context),
        env: opts.env?.(context),
        userId: opts.userId?.(context) ?? null,
        selfHost: opts.selfHost ?? null,
      });
    } catch (e) {
      console.error("@pramen/analytics: analytics middleware failed", e);
      // Still without the internal header: it names a CMS row and must not reach a visitor.
      return stripPageId(response);
    }
  };
}
