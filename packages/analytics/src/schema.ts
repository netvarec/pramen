// The analytics tables. Spread `analyticsSchema` into your `defineSchema` next to the
// app's own entities.

import { DEFAULT_PARTITION, Entity, defaultTo, expr, generated, indexed, notNull, primaryKey, unique } from "@pramen/server";

/** Which partition the analytics tables live in. The DEFAULT one — and this was not the
 * first answer.
 *
 * A separate partition is what the feature is for: a pageview is a high-rate append, a DO
 * serializes, and sharing a DO with the CMS puts every visitor's write in line with the
 * editorial ones. So the tables started in `"analytics"`.
 *
 * That does not work, for a reason that only shows up once there is a dashboard.
 * `Db.assertInPartition` rejects any table outside the DO's own partition, and a Block Kit
 * page renders inside `adminPageInteract` — a handler in the DEFAULT partition, in
 * `@pramen/cms`, shared by every admin page. There is no per-page partition to set, and a
 * DO cannot reach into another DO's SQLite. A partitioned analytics table is therefore
 * readable by everything except the screen built to read it.
 *
 * The default partition it is, knowingly, with the contention it implies. Two things make
 * that survivable: the queue sink means the write rate is BATCHES per second, not
 * pageviews, and it is reversible — moving to `"analytics"` later costs a data migration
 * plus a dashboard that reads over `callPrivileged({ partition })` from the Worker instead
 * of through `ctx.db`, which is an `adminPanel`, not a Block Kit page.
 *
 * Note what is NOT the reason: `pageId` is a bare `uuid` rather than a `belongsTo` because
 * relations may not cross partitions, and keeping that shape means this decision can be
 * revisited without also rewriting the relation. */
export const ANALYTICS_PARTITION = DEFAULT_PARTITION;

export const analyticsSchema = {
  /** One row per recorded pageview, plus one per engagement report.
   *
   * Raw rows are kept because the rollup can only answer questions it was written to
   * answer; keeping the events means a new breakdown is a query, not a migration plus a
   * wait for data to accumulate. `pruneRawEvents` (rollup.ts) is the other half of that
   * bargain — rolled-up days can be dropped once the aggregate exists. */
  analytics_events: Entity(
    (t) => ({
      id: primaryKey(generated(t.uuid())),
      /** Correlates an engagement row with its pageview. Indexed because that lookup is
       * the beacon's whole write path. */
      viewId: indexed(notNull(t.text())),
      kind: notNull(t.text()),
      origin: notNull(t.text()),
      ts: notNull(t.text()),
      /** `YYYY-MM-DD`. Indexed: every range read and the rollup filter on it. */
      day: indexed(notNull(t.text())),
      path: notNull(t.text()),
      /** The CMS page this view was of, when the collector could tell — which the SERVER
       * can and the beacon cannot.
       *
       * A plain `uuid` rather than `belongsTo("cms_pages", …)`, and not because a relation
       * would be inconvenient: `cms_pages` is in the default partition and this table is
       * not, so a relation across them is rejected by `validateSchema` at boot. The
       * dashboard resolves titles with a second, explicit read.
       *
       * Worth having anyway — it is the reason "same project only" is a better position
       * than a generic tracker. A path is a string that changes when an editor renames a
       * slug, silently splitting one page's history in two; a page id does not. */
      pageId: t.uuid(),
      referrer: t.text(),
      source: t.text(),
      country: t.text(),
      city: t.text(),
      device: t.text(),
      /** A per-day, per-visitor pseudonym — a salted hash, never an identifier that leaves
       * the server or persists past the day. See `sessionId` in collect.ts. */
      sessionId: indexed(t.text()),
      userId: t.text(),
      durationMs: t.int(),
      scrollDepth: t.int(),
      clicks: t.int(),
      createdAt: defaultTo(t.text(), expr.now()),
    }),
    undefined,
    { partition: ANALYTICS_PARTITION },
  ),

  /** One row per day: the aggregate the dashboard reads for days that have been rolled up.
   *
   * `day` is `unique()` rather than a composite — this deployment tracks one site, which is
   * the whole premise of the package. Adding a `siteId` later means a composite unique and
   * a rewrite of every read here; that is the price of the simplification, taken knowingly. */
  analytics_daily: Entity(
    (t) => ({
      id: primaryKey(generated(t.uuid())),
      day: unique(notNull(t.text())),
      pageviews: notNull(defaultTo(t.int(), 0)),
      sessions: notNull(defaultTo(t.int(), 0)),
      /** Sessions whose whole visit was a single pageview. Stored as a COUNT, not a rate,
       * so that a multi-day range can be summed — averaging stored percentages weights a
       * quiet day the same as a busy one. Every derived rate in `queries.ts` is computed
       * from counts for this reason. */
      bounces: notNull(defaultTo(t.int(), 0)),
      /** Sums, again so ranges compose. `engagedViews` is the divisor: only views the
       * beacon reported on can contribute to a duration or scroll average, and dividing by
       * `pageviews` instead would silently deflate both on a site where most pages are
       * static (no beacon-less server view can carry a duration). */
      engagedViews: notNull(defaultTo(t.int(), 0)),
      totalDurationMs: notNull(defaultTo(t.int(), 0)),
      totalScrollDepth: notNull(defaultTo(t.int(), 0)),
      byDevice: t.json(),
      bySource: t.json(),
      byCountry: t.json(),
      rolledAt: notNull(defaultTo(t.text(), expr.now())),
    }),
    undefined,
    { partition: ANALYTICS_PARTITION },
  ),

  /** One row per (day, path): Top Pages, after the raw events for that day are gone. */
  analytics_pages: Entity(
    (t) => ({
      id: primaryKey(generated(t.uuid())),
      day: indexed(notNull(t.text())),
      path: notNull(t.text()),
      pageId: t.uuid(),
      pageviews: notNull(defaultTo(t.int(), 0)),
      engagedViews: notNull(defaultTo(t.int(), 0)),
      totalDurationMs: notNull(defaultTo(t.int(), 0)),
      totalScrollDepth: notNull(defaultTo(t.int(), 0)),
    }),
    undefined,
    { partition: ANALYTICS_PARTITION, unique: [["day", "path"]] },
  ),
};
