// The event shape, and the pure derivations that turn a Request into one.
//
// Everything here is deliberately free of Cloudflare types and of `ctx`: a collector is
// mostly parsing and classification, and that is the part worth testing directly rather
// than through a booted Worker.
//
// TWO SOURCES, ONE SHAPE. A pageview can be recorded by the Worker that served the page,
// or by the browser beacon when no Worker was in the path (a prerendered page off a CDN —
// which is how `@pramen/cms-astro` sites are built by default). The two see different
// things, so several columns are nullable BY CONSTRUCTION, not by accident:
//
//   server-only  country, city, userId, pageId   (request.cf, the session, the CMS row)
//   beacon-only  durationMs, scrollDepth, clicks (only the browser can measure these)
//
// A reader that treats a null `country` as "unknown country" rather than "this view was
// not seen by a Worker" will draw the wrong conclusion, so `origin` records which
// collector produced the row.

/** What produced the row. See the nullability note above. */
export const EVENT_ORIGINS = ["server", "beacon"] as const;
export type EventOrigin = (typeof EVENT_ORIGINS)[number];

/** A `pageview` is one page load. An `engagement` is the beacon reporting on a pageview
 * that was ALREADY recorded (by either collector), keyed by the same `viewId` — it is an
 * update in event form, not a second visit, and must never be counted as one. */
export const EVENT_KINDS = ["pageview", "engagement"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface AnalyticsEvent {
  kind: EventKind;
  origin: EventOrigin;
  /** Correlates a beacon's engagement with the pageview it belongs to. Minted by whichever
   * collector recorded the pageview; see `collect.ts` for why that is the whole hybrid. */
  viewId: string;
  /** ISO-8601 UTC, matching `expr.now()`. */
  ts: string;
  /** `YYYY-MM-DD` of `ts`. Stored rather than derived so the rollup and every range read
   * are an indexed equality/BETWEEN instead of a `substr()` over the table. */
  day: string;
  path: string;
  pageId?: string | null;
  referrer?: string | null;
  source?: string | null;
  country?: string | null;
  city?: string | null;
  device?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  durationMs?: number | null;
  scrollDepth?: number | null;
  clicks?: number | null;
}

export const DEVICES = ["desktop", "mobile", "tablet"] as const;
export type Device = (typeof DEVICES)[number];

/** `YYYY-MM-DD` in UTC. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Strip the query string and fragment, collapse a trailing slash, cap the length.
 *
 * Analytics paths are GROUPING KEYS, and an unnormalized one fragments a page's history
 * across `/a`, `/a/`, `/a?utm_source=x` — three rows in Top Pages for one page. The query
 * string is dropped rather than kept because campaign parameters are per-visitor and would
 * make the cardinality unbounded; the campaign itself is carried by `source`.
 *
 * Not lowercased: paths are case-sensitive on the wire, and folding them would merge two
 * pages that a server genuinely serves differently. */
export function normalizePath(raw: string): string {
  let path = raw;
  const cut = Math.min(...[path.indexOf("?"), path.indexOf("#")].filter((i) => i >= 0), path.length);
  path = path.slice(0, cut);
  if (path.length === 0) return "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path.slice(0, 512);
}

/** Classify a User-Agent into a device bucket.
 *
 * Order matters: every tablet UA also says "Mobile" or is an Android, so tablet is tested
 * first. An unrecognized UA is `desktop` — the majority case, and one bucket is better
 * than an "unknown" slice that only ever means "our regex is out of date". */
export function deriveDevice(ua: string | null | undefined): Device {
  const s = (ua ?? "").toLowerCase();
  if (s.length === 0) return "desktop";
  if (s.includes("ipad") || s.includes("tablet") || (s.includes("android") && !s.includes("mobile"))) return "tablet";
  if (s.includes("mobi") || s.includes("iphone") || s.includes("ipod") || s.includes("android")) return "mobile";
  return "desktop";
}

/** Substrings that mark a non-human client.
 *
 * This list exists because the two collectors disagree about bots and would otherwise
 * disagree about the totals: a crawler runs no JavaScript, so the beacon never sees it,
 * while the Worker sees every crawl. On a well-indexed site that gap is not a rounding
 * error — it can be most of the traffic. Filtering at the collector keeps ONE definition
 * of a pageview instead of a dashboard that has to explain which number to believe. */
const BOT_MARKERS = [
  "bot", "crawl", "spider", "slurp", "curl", "wget", "python-requests", "httpclient",
  "headlesschrome", "phantomjs", "puppeteer", "playwright", "lighthouse", "pingdom",
  "uptimerobot", "monitoring", "preview", "fetcher", "feedfetcher", "scraper",
];

/** Whether a User-Agent looks automated. Deliberately substring matching and deliberately
 * not exhaustive — a bot list is never finished, and the cost of a miss is one inflated
 * pageview, while the cost of a false positive is a silently dropped human. */
export function isBot(ua: string | null | undefined): boolean {
  const s = (ua ?? "").toLowerCase();
  if (s.length === 0) return true; // no UA at all is a script, not a browser
  return BOT_MARKERS.some((m) => s.includes(m));
}

/** Bucket a referrer into a traffic source.
 *
 * `selfHost` is what separates a real referral from internal navigation — without it every
 * click from one page of the site to the next counts as a referral from the site itself,
 * which is both wrong and, on any content site, the largest "source" in the report. */
export function deriveSource(referrer: string | null | undefined, selfHost?: string | null): string {
  if (!referrer) return "direct";
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "direct"; // an unparseable referrer is not a source we can name
  }
  if (host.length === 0) return "direct";
  const self = (selfHost ?? "").toLowerCase().replace(/^www\./, "");
  if (self.length > 0 && (host === self || host.endsWith(`.${self}`))) return "internal";
  if (/(^|\.)(google|bing|duckduckgo|yahoo|seznam|ecosia|baidu|yandex)\./.test(`.${host}.`)) return "search";
  if (/(^|\.)(facebook|instagram|twitter|x|t|linkedin|reddit|youtube|pinterest|tiktok|mastodon)\./.test(`.${host}.`)) return "social";
  return host.slice(0, 128);
}

/** Clamp a beacon-reported number into a sane range, or drop it.
 *
 * The beacon is caller-controlled input: these values arrive from a public endpoint that
 * anyone can POST to. A negative duration or a scroll depth of 10^9 would not throw — it
 * would quietly poison an average that someone then reads as fact. */
export function clampMetric(v: unknown, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 0) return null;
  return n > max ? max : n;
}
