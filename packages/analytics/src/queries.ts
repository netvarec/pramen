// Reads for the dashboard.
//
// Every number the dashboard shows comes from here, and every one of them is assembled the
// same way: take the days that have been ROLLED UP from `analytics_daily`, compute the rest
// from raw events, and add them together. The dashboard is therefore correct whether or not
// the rollup has ever run — which matters, because the rollup is on a cron and the cron is
// the part most likely to be missing in a new deployment.
//
// RATES ARE NEVER STORED, only counts. A stored bounce RATE cannot be combined across days:
// averaging Monday's 80% with Tuesday's 20% weights a day with nine visits the same as one
// with nine hundred. Counts sum; rates are computed at the end, once.

import type { JsonValue } from "@pramen/server";
import type { AnalyticsDb } from "./ingest";

/** A breakdown: one count per bucket (device, source, country). */
export type Counts = Record<string, number>;

export interface DayMetrics {
  day: string;
  pageviews: number;
  sessions: number;
  bounces: number;
  engagedViews: number;
  totalDurationMs: number;
  totalScrollDepth: number;
  byDevice: Counts;
  bySource: Counts;
  byCountry: Counts;
}

export interface RangeMetrics {
  from: string;
  to: string;
  pageviews: number;
  sessions: number;
  bounces: number;
  /** null when nothing in the range was measurable — see `engagedViews`. A zero would be a
   * claim (visitors left instantly); null is the truth (no beacon reported). */
  bounceRate: number | null;
  avgDurationMs: number | null;
  avgScrollDepth: number | null;
  /** Pageviews the beacon reported engagement for. The divisor for both averages above, and
   * worth surfacing: on a site whose pages are prerendered and whose visitors block scripts,
   * this is how much of the traffic the averages actually describe. */
  engagedViews: number;
  byDevice: Counts;
  bySource: Counts;
  byCountry: Counts;
  days: { day: string; pageviews: number }[];
}

export interface PageMetrics {
  path: string;
  pageId: string | null;
  pageviews: number;
}

const EMPTY_DAY = (day: string): DayMetrics => ({
  day, pageviews: 0, sessions: 0, bounces: 0, engagedViews: 0, totalDurationMs: 0, totalScrollDepth: 0,
  byDevice: {}, bySource: {}, byCountry: {},
});

/** Every `YYYY-MM-DD` from `from` to `to` inclusive. Capped so a mistyped range cannot ask
 * for a million days of reads. */
export function daysInRange(from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  let t = new Date(`${from}T00:00:00Z`).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(end)) return out;
  while (t <= end && out.length < max) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

function addInto(target: Counts, key: string | null | undefined, n: number): void {
  const k = key && key.length > 0 ? key : "unknown";
  target[k] = (target[k] ?? 0) + n;
}

/** A stored breakdown column, read back. `t.json()` gives whatever was written, so the
 * numbers are re-established here rather than trusted — a breakdown with a string count
 * would otherwise concatenate its way into a total. */
function asCounts(v: JsonValue | null | undefined): Counts {
  const out: Counts = {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v)) if (typeof n === "number") out[k] = n;
  return out;
}

/** Aggregate raw events for a set of days.
 *
 * One pass per breakdown rather than per DAY: a range with nothing rolled up would otherwise
 * be four queries times thirty days. Sessions are grouped by `(day, sessionId)` because a
 * session id already encodes its day — the pair is the natural key, and counting the groups
 * is how distinct sessions are obtained without a COUNT(DISTINCT) the engine does not have. */
export async function computeDays(db: AnalyticsDb, days: readonly string[]): Promise<Map<string, DayMetrics>> {
  const out = new Map<string, DayMetrics>();
  if (days.length === 0) return out;
  for (const d of days) out.set(d, EMPTY_DAY(d));

  const inDays = { day: { in: [...days] } };
  const dayOf = (r: { day: unknown }): DayMetrics | undefined => out.get(String(r.day));

  // Pageviews, split by each breakdown in turn.
  for (const [column, pick] of [
    ["device", (m: DayMetrics) => m.byDevice],
    ["source", (m: DayMetrics) => m.bySource],
    ["country", (m: DayMetrics) => m.byCountry],
  ] as const) {
    const rows = await db.aggregate({
      from: "analytics_events",
      where: { ...inDays, kind: "pageview" },
      groupBy: ["day", column],
      aggregations: { n: { fn: "count" } },
    });
    for (const r of rows) {
      const m = dayOf(r);
      if (!m) continue;
      addInto(pick(m), r[column] as string | null, r.n);
      // Totalled from the FIRST breakdown only; the three group the same rows, so adding
      // on each pass would triple every pageview count.
      if (column === "device") m.pageviews += r.n;
    }
  }

  // Sessions and bounces: one row per (day, session).
  const sessions = await db.aggregate({
    from: "analytics_events",
    where: { ...inDays, kind: "pageview", sessionId: { isNull: false } },
    groupBy: ["day", "sessionId"],
    aggregations: { views: { fn: "count" } },
  });
  for (const r of sessions) {
    const m = dayOf(r);
    if (!m) continue;
    m.sessions += 1;
    if (r.views === 1) m.bounces += 1;
  }

  // Engagement: only the beacon produces these rows.
  const engagement = await db.aggregate({
    from: "analytics_events",
    where: { ...inDays, kind: "engagement" },
    groupBy: "day",
    aggregations: { n: { fn: "count" }, duration: { fn: "sum", column: "durationMs" }, scroll: { fn: "sum", column: "scrollDepth" } },
  });
  for (const r of engagement) {
    const m = dayOf(r);
    if (!m) continue;
    m.engagedViews += r.n;
    m.totalDurationMs += r.duration ?? 0;
    m.totalScrollDepth += r.scroll ?? 0;
  }

  return out;
}

/** Read the rolled-up days in a range. */
async function rolledDays(db: AnalyticsDb, days: readonly string[]): Promise<Map<string, DayMetrics>> {
  const out = new Map<string, DayMetrics>();
  if (days.length === 0) return out;
  const rows = await db.find({ from: "analytics_daily", where: { day: { in: [...days] } } });
  for (const r of rows) {
    out.set(r.day, {
      day: r.day,
      pageviews: r.pageviews,
      sessions: r.sessions,
      bounces: r.bounces,
      engagedViews: r.engagedViews,
      totalDurationMs: r.totalDurationMs,
      totalScrollDepth: r.totalScrollDepth,
      byDevice: asCounts(r.byDevice),
      bySource: asCounts(r.bySource),
      byCountry: asCounts(r.byCountry),
    });
  }
  return out;
}

/** The dashboard's headline read. */
export async function metricsForRange(db: AnalyticsDb, from: string, to: string): Promise<RangeMetrics> {
  const days = daysInRange(from, to);
  const rolled = await rolledDays(db, days);
  const missing = days.filter((d) => !rolled.has(d));
  const computed = await computeDays(db, missing);

  const total = EMPTY_DAY("");
  const series: { day: string; pageviews: number }[] = [];
  for (const d of days) {
    const m = rolled.get(d) ?? computed.get(d) ?? EMPTY_DAY(d);
    total.pageviews += m.pageviews;
    total.sessions += m.sessions;
    total.bounces += m.bounces;
    total.engagedViews += m.engagedViews;
    total.totalDurationMs += m.totalDurationMs;
    total.totalScrollDepth += m.totalScrollDepth;
    for (const [k, n] of Object.entries(m.byDevice)) addInto(total.byDevice, k, n);
    for (const [k, n] of Object.entries(m.bySource)) addInto(total.bySource, k, n);
    for (const [k, n] of Object.entries(m.byCountry)) addInto(total.byCountry, k, n);
    series.push({ day: d, pageviews: m.pageviews });
  }

  return {
    from,
    to,
    pageviews: total.pageviews,
    sessions: total.sessions,
    bounces: total.bounces,
    bounceRate: total.sessions > 0 ? total.bounces / total.sessions : null,
    avgDurationMs: total.engagedViews > 0 ? Math.round(total.totalDurationMs / total.engagedViews) : null,
    avgScrollDepth: total.engagedViews > 0 ? Math.round(total.totalScrollDepth / total.engagedViews) : null,
    engagedViews: total.engagedViews,
    byDevice: total.byDevice,
    bySource: total.bySource,
    byCountry: total.byCountry,
    days: series,
  };
}

/** Top pages over a range, merged from the rollup and raw events exactly as above. */
export async function topPages(db: AnalyticsDb, from: string, to: string, limit = 10): Promise<PageMetrics[]> {
  const days = daysInRange(from, to);
  if (days.length === 0) return [];

  const totals = new Map<string, PageMetrics>();
  const add = (path: string, pageId: string | null, n: number): void => {
    const cur = totals.get(path);
    if (cur) {
      cur.pageviews += n;
      // A page id is worth keeping wherever one collector managed to record it: the beacon
      // never can, so a path seen by both would otherwise lose it on whichever row won.
      cur.pageId = cur.pageId ?? pageId;
    } else {
      totals.set(path, { path, pageId, pageviews: n });
    }
  };

  const rolledRows = await db.find({ from: "analytics_pages", where: { day: { in: days } } });
  const rolledDaysSeen = new Set(rolledRows.map((r) => r.day));
  for (const r of rolledRows) add(r.path, r.pageId ?? null, r.pageviews);

  const missing = days.filter((d) => !rolledDaysSeen.has(d));
  if (missing.length > 0) {
    const rows = await db.aggregate({
      from: "analytics_events",
      where: { day: { in: missing }, kind: "pageview" },
      groupBy: ["path", "pageId"],
      aggregations: { n: { fn: "count" } },
    });
    for (const r of rows) add(String(r.path), (r.pageId as string | null) ?? null, r.n);
  }

  return [...totals.values()].sort((a, b) => b.pageviews - a.pageviews).slice(0, limit);
}
