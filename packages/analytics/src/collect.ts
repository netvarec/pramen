// The public collector: `POST /collect` (the beacon) and `GET /analytics.js` (the script).
//
// Both are `app.routes` — PRE-AUTH, matched in the Worker before identity resolution and
// before the DO proxy. That is required, not convenient: a visitor has no session, and the
// beacon must not pay for one.

import type { EnvBag } from "@pramen/server";
import type { PublicRoute, RouteContext } from "@pramen/server/worker";
import {
  clampMetric,
  dayOf,
  deriveDevice,
  deriveSource,
  isBot,
  normalizePath,
  type AnalyticsEvent,
  type EventKind,
} from "./events";
import { trackerScript } from "./tracker";
import type { AnalyticsSink } from "./sink";

/** Ceilings for beacon-reported numbers. A duration longer than a working day is a tab
 * left open over a weekend, not a reader. */
const MAX_DURATION_MS = 6 * 60 * 60 * 1000;
const MAX_CLICKS = 10_000;

/** Refuse a body that is too large to be a beacon. The endpoint is public and unauthenticated;
 * without a cap it is a free write amplifier. */
const MAX_BODY_BYTES = 16 * 1024;
/** And a cap on how many events one POST may carry. The tracker sends exactly one. */
const MAX_EVENTS_PER_REQUEST = 20;

/** Cloudflare's per-request geo, present on `request.cf` in the Workers runtime and absent
 * in most local/test runtimes — so every read is optional and the columns are nullable. */
interface RequestGeo {
  country?: string;
  city?: string;
}

function geoOf(request: Request): RequestGeo {
  const cf = (request as Request & { cf?: RequestGeo }).cf;
  return { country: typeof cf?.country === "string" ? cf.country : undefined, city: typeof cf?.city === "string" ? cf.city : undefined };
}

/** A per-day, per-visitor pseudonym: `sha256(salt + ip + ua + day)`, truncated.
 *
 * No cookie and no storage on the visitor's device, so there is nothing to consent to and
 * nothing to clear — and because the day is part of the input, the value cannot link a
 * visitor across days even server-side.
 *
 * WITHOUT A SALT IT RETURNS NULL, and sessions are simply unavailable. That is not
 * over-caution: the input space is one IPv4 address by one of a few thousand common User-Agent
 * strings, which is enumerable on a laptop, so an unsalted digest of it is a reversible
 * encoding of the visitor's IP rather than a pseudonym. Storing that would be strictly worse
 * than storing the IP, because it would look anonymous. */
export async function sessionId(salt: string | null, ip: string | null, ua: string | null, day: string): Promise<string | null> {
  if (!salt || salt.length === 0) return null;
  const data = new TextEncoder().encode(`${salt}|${ip ?? ""}|${ua ?? ""}|${day}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the beacon sends. Everything here is caller-controlled. */
interface BeaconEvent {
  kind?: unknown;
  viewId?: unknown;
  path?: unknown;
  referrer?: unknown;
  durationMs?: unknown;
  scrollDepth?: unknown;
  clicks?: unknown;
}

function parseBody(text: string): BeaconEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const events = (parsed as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];
  return events.slice(0, MAX_EVENTS_PER_REQUEST) as BeaconEvent[];
}

export interface CollectOptions {
  /** Where the beacon POSTs. Must match the tracker's `collectPath`. */
  path?: string;
  /** Where the script is served. */
  trackerPath?: string;
  /** Build the sink for a request. Given the env so a deployment can pick queue vs direct
   * without this module knowing about either. */
  sink: (request: Request, env: EnvBag, ctx: RouteContext) => AnalyticsSink;
  /** Salt for `sessionId`. Given the env rather than a value so a secret can be rotated
   * without rebuilding the route. Return null to disable sessions. */
  salt?: (env: EnvBag) => string | null;
  /** Host the site is served from, so an internal referral is not counted as a source.
   * Defaults to the collector's own host, which is right when they share an origin. */
  selfHost?: (request: Request, env: EnvBag) => string | null;
}

const defaultSalt = (env: EnvBag): string | null => {
  const v = (env as Record<string, unknown>).ANALYTICS_SALT ?? (env as Record<string, unknown>).AUTH_SECRET;
  return typeof v === "string" && v.length > 0 ? v : null;
};

/** CORS for a collector that is very often on a different origin from the site (a static
 * site on a CDN, this Worker on its own hostname). `*` is correct here and not a shortcut:
 * the endpoint is write-only, reads nothing back to the caller, and is reachable by anyone
 * who can make an HTTP request regardless of what this header says. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/** The beacon endpoint. Always answers 204 — see the note on failure below. */
export function collectRoute(opts: CollectOptions): PublicRoute[] {
  const path = opts.path ?? "/collect";
  const saltOf = opts.salt ?? defaultSalt;

  const handler = async (request: Request, env: EnvBag, ctx: RouteContext): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const ua = request.headers.get("user-agent");
    // A crawler that executes JavaScript is rare but real; the same filter runs on both
    // collectors so the two can be compared at all.
    if (isBot(ua)) return new Response(null, { status: 204, headers: CORS });

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return new Response(null, { status: 204, headers: CORS });

    const beacons = parseBody(raw);
    if (beacons.length === 0) return new Response(null, { status: 204, headers: CORS });

    const now = new Date().toISOString();
    const day = dayOf(now);
    const geo = geoOf(request);
    const device = deriveDevice(ua);
    const ip = request.headers.get("cf-connecting-ip");
    const session = await sessionId(saltOf(env), ip, ua, day);
    const host = opts.selfHost?.(request, env) ?? new URL(request.url).hostname;

    const events: AnalyticsEvent[] = [];
    for (const b of beacons) {
      const kind: EventKind = b.kind === "engagement" ? "engagement" : "pageview";
      const viewId = typeof b.viewId === "string" ? b.viewId.slice(0, 64) : "";
      if (viewId.length === 0) continue;
      const referrer = typeof b.referrer === "string" ? b.referrer.slice(0, 1024) : null;
      events.push({
        kind,
        origin: "beacon",
        viewId,
        ts: now,
        day,
        path: normalizePath(typeof b.path === "string" ? b.path : "/"),
        referrer,
        source: deriveSource(referrer, host),
        country: geo.country ?? null,
        city: geo.city ?? null,
        device,
        sessionId: session,
        durationMs: clampMetric(b.durationMs, MAX_DURATION_MS),
        scrollDepth: clampMetric(b.scrollDepth, 100),
        clicks: clampMetric(b.clicks, MAX_CLICKS),
      });
    }

    try {
      await opts.sink(request, env, ctx).write(events);
    } catch (e) {
      // Never surface a collector failure. `sendBeacon` discards the response, so a status
      // code here reaches nobody — but this same route shape is what the server-side hook
      // will call, and there a throw would take the PAGE down. Losing a pageview is the
      // correct trade; losing it silently is not, hence the log.
      console.error("@pramen/analytics: collect failed", e);
    }
    return new Response(null, { status: 204, headers: CORS });
  };

  return [
    { method: "POST", path, handler },
    { method: "OPTIONS", path, handler },
  ];
}

/** Serves the beacon. Cached hard: it changes only when this package does. */
export function trackerRoute(opts: { path?: string; collectPath?: string } = {}): PublicRoute {
  const body = trackerScript({ collectPath: opts.collectPath ?? "/collect" });
  return {
    method: "GET",
    path: opts.path ?? "/analytics.js",
    handler: () =>
      new Response(body, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=3600",
          ...CORS,
        },
      }),
  };
}
