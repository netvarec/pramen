// The daily rollup, and the pruning it makes safe.
//
// Two jobs. `rollupPending` turns finished days of raw events into one `analytics_daily`
// row (and one `analytics_pages` row per path); `pruneRawEvents` then deletes the raw rows
// for days that have been rolled up. Neither is required for the dashboard to be correct —
// `queries.ts` computes an un-rolled day on the fly — so a deployment with no cron loses
// speed and unbounded storage, not accuracy.
//
// NO LEASE, and that is a deliberate difference from `app.migrations`. A data migration may
// be non-idempotent (`n = n * 2`), so it must be claimed before it runs. A rollup is a pure
// function of one finished day's events: running it twice writes the same numbers. The
// unique index on `analytics_daily.day` plus an upsert is therefore the whole concurrency
// story — two isolates racing produce one row with the correct contents, where a lease
// would only have made one of them wait to compute the same thing.

import type { AnalyticsDb } from "./ingest";
import { computeDays } from "./queries";

/** Yesterday, UTC. A day is rolled up only once it can no longer change. */
export function previousDay(today = new Date()): string {
  return new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/** Days with raw events at or before `through` that have no `analytics_daily` row yet. */
async function pendingDays(db: AnalyticsDb, through: string, maxDays: number): Promise<string[]> {
  const seen = await db.aggregate({
    from: "analytics_events",
    where: { day: { lte: through } },
    groupBy: "day",
    aggregations: { n: { fn: "count" } },
  });
  const candidates = seen.map((r) => String(r.day)).sort();
  if (candidates.length === 0) return [];
  const rolled = await db.find({ from: "analytics_daily", where: { day: { in: candidates } } });
  const done = new Set(rolled.map((r) => r.day));
  return candidates.filter((d) => !done.has(d)).slice(0, maxDays);
}

export interface RollupResult {
  days: string[];
  pages: number;
}

/** Roll up every finished day that has not been rolled up yet.
 *
 * `maxDays` bounds the work: this runs inside a request (a cron invocation, or the admin
 * button), and a store that has gone months without a cron must not try to catch up in one
 * invocation and hit the wall-clock limit. Falling behind is recoverable — each run makes
 * progress and the next one continues. */
export async function rollupPending(db: AnalyticsDb, opts: { through?: string; maxDays?: number } = {}): Promise<RollupResult> {
  const through = opts.through ?? previousDay();
  const days = await pendingDays(db, through, opts.maxDays ?? 14);
  if (days.length === 0) return { days: [], pages: 0 };

  const metrics = await computeDays(db, days);
  let pages = 0;

  for (const day of days) {
    const m = metrics.get(day);
    if (!m) continue;

    // Upsert rather than insert: see the header. `excluded` is the row that would have been
    // inserted, so a re-run overwrites with freshly computed numbers instead of adding to
    // stale ones — which is what makes "run it twice" a no-op rather than a doubling.
    await db.exec(
      `INSERT INTO "analytics_daily"
         ("id","day","pageviews","sessions","bounces","engagedViews","totalDurationMs","totalScrollDepth","byDevice","bySource","byCountry")
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT("day") DO UPDATE SET
         "pageviews"=excluded."pageviews", "sessions"=excluded."sessions", "bounces"=excluded."bounces",
         "engagedViews"=excluded."engagedViews", "totalDurationMs"=excluded."totalDurationMs",
         "totalScrollDepth"=excluded."totalScrollDepth", "byDevice"=excluded."byDevice",
         "bySource"=excluded."bySource", "byCountry"=excluded."byCountry"`,
      crypto.randomUUID(), day, m.pageviews, m.sessions, m.bounces, m.engagedViews, m.totalDurationMs, m.totalScrollDepth,
      JSON.stringify(m.byDevice), JSON.stringify(m.bySource), JSON.stringify(m.byCountry),
    );

    // Per-path totals for the same day. Read straight from raw — this is the last chance,
    // since pruning removes these rows.
    const perPath = await db.aggregate({
      from: "analytics_events",
      where: { day, kind: "pageview" },
      groupBy: ["path", "pageId"],
      aggregations: { n: { fn: "count" } },
    });
    for (const r of perPath) {
      await db.exec(
        `INSERT INTO "analytics_pages" ("id","day","path","pageId","pageviews","engagedViews","totalDurationMs","totalScrollDepth")
         VALUES (?,?,?,?,?,0,0,0)
         ON CONFLICT("day","path") DO UPDATE SET "pageviews"=excluded."pageviews", "pageId"=excluded."pageId"`,
        crypto.randomUUID(), day, String(r.path), (r.pageId as string | null) ?? null, r.n,
      );
      pages += 1;
    }
  }

  return { days, pages };
}

/** Delete raw events for days that have been rolled up and are older than `keepDays`.
 *
 * Guarded on the rollup EXISTING, not merely on the date: deleting a day whose aggregate was
 * never written destroys it outright, and the failure would be invisible — a silently empty
 * week in a chart nobody cross-checks. So the delete names only days present in
 * `analytics_daily`. */
export async function pruneRawEvents(db: AnalyticsDb, opts: { keepDays?: number } = {}): Promise<{ deletedDays: string[] }> {
  const keep = opts.keepDays ?? 90;
  const cutoff = new Date(Date.now() - keep * 86_400_000).toISOString().slice(0, 10);

  const stale = await db.aggregate({
    from: "analytics_events",
    where: { day: { lt: cutoff } },
    groupBy: "day",
    aggregations: { n: { fn: "count" } },
  });
  const candidates = stale.map((r) => String(r.day));
  if (candidates.length === 0) return { deletedDays: [] };

  const rolled = await db.find({ from: "analytics_daily", where: { day: { in: candidates } } });
  const deletable = rolled.map((r) => r.day);
  if (deletable.length === 0) return { deletedDays: [] };

  const placeholders = deletable.map(() => "?").join(", ");
  await db.exec(`DELETE FROM "analytics_events" WHERE "day" IN (${placeholders})`, ...deletable);
  return { deletedDays: deletable };
}
