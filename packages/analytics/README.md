# @pramen/analytics

First-party traffic analytics for a pramen deployment: a public beacon endpoint, one event
table, a daily rollup, and a dashboard inside the CMS editor's own chrome.

**Status: first slice.** The browser beacon and the pipeline behind it work end to end. The
server-side collector — the half that records a pageview when a Worker served the page — is
not in this slice; see *What is missing* below.

## Scope

This tracks **one site**: the project it is installed in. There is no sites table, no API
key, no allowed-origin list and no per-site settings screen.

That is the trade that buys everything else. A pageview can carry the CMS page's **id**
rather than a URL string, so renaming a slug does not split a page's history in two; the
collector needs no authentication surface of its own; and `siteId` is not a column on every
table and in every index. Adding multi-site later is a schema change, not a config one.

## Wiring

```ts
import {
  analyticsSchema, analyticsPolicies, analyticsDashboard,
  createAnalyticsHandlers, createAnalyticsQueues, createAnalyticsSink,
  collectRoute, trackerRoute, ANALYTICS_QUEUE,
} from "@pramen/analytics";

const schema = defineSchema({ ...cmsSchema, ...analyticsSchema });

const handlers = {
  ...createAnalyticsHandlers(),
  ...createAdminPageHandlers([analyticsDashboard()]),
};

const routes = [
  ...collectRoute({ sink: (request, env, ctx) => createAnalyticsSink(env, ctx) }),
  trackerRoute(),
];

const acl = [
  role("admin", [...analyticsPolicies().admin]),
  role("editor", [...analyticsPolicies({ prefix: "an-ed" }).viewer]),
];

const queues = { ...createAnalyticsQueues({ queueName: ANALYTICS_QUEUE }) };
```

Then put the beacon on the site:

```html
<script src="https://your-worker.example.com/analytics.js" defer></script>
```

See `example/app.ts` for the wired version.

### Sessions need a salt

Set `ANALYTICS_SALT` (it falls back to `AUTH_SECRET`). Without one, **`sessionId` is null
and sessions, bounce rate and visit counts are unavailable** — which is deliberate. The
input is one IP address by one of a few thousand common User-Agent strings, so an *unsalted*
digest of it is enumerable: a reversible encoding of the visitor's IP that merely looks
anonymous. Failing closed is the only honest option.

Nothing is stored on the visitor's device — no cookie, no `localStorage` — and the day is
part of the hash, so the value cannot link a visitor across days even server-side.

## How a pageview gets counted

Two collectors, one pipeline. Which one records a given view is decided by **the HTML the
visitor actually received**, not by configuration:

- The page carries `<meta name="pramen-view" content="…">` — a Worker served it and already
  recorded the pageview. The beacon sends only **engagement** against that id.
- No meta tag — the page came off a CDN and nothing recorded it. The beacon mints an id and
  records the **pageview** itself.

A site with some prerendered and some on-demand routes therefore gets the right answer per
page, and a route that later moves to on-demand starts being counted by the server with no
analytics change at all.

| From the server | From the beacon |
| --- | --- |
| pageview, path + `cms_pages` id, referrer, country/city, device, identity | duration, scroll depth, clicks |

Several columns are consequently nullable **by construction**. `origin` records which
collector produced a row, so a null `country` can be read as "no Worker saw this" rather
than "unknown country".

## The sink

`createAnalyticsSink` picks a transport from the environment, the same way `ctx.mail` does:

1. **`QueueSink`** — an `ANALYTICS` Cloudflare Queue producer binding is present. The batch
   is handed off and the visitor's request never waits for a database write. Recommended in
   production; declare the queue in `oblaka.ts` and spread `createAnalyticsQueues()` into
   `app.queues`.
2. **`DirectSink`** — no queue. Writes in-request through `callPrivileged`. On the DO store
   that is one in-process SQLite insert, which is genuinely fine at small scale.
3. **`NoopSink`** — neither is available. Drops events and says so once.

The privileged ingest handler is gated on `INGEST_ROLE` (`__analytics_ingest`). The `__`
prefix is load-bearing, not decorative: `@pramen/server` strips such roles from every
verified token, so the only way to present one is to be the Worker. `auth: []` does **not**
express "system-only" — it is satisfied by nobody, `callPrivileged` included.

A collector failure never propagates: `collectRoute` logs and answers `204`. `sendBeacon`
discards the response anyway, and the same route shape is what the server-side hook will
call — where a throw would take the *page* down.

## Rollup and retention

`analytics_events` holds raw rows. `rollupPending` folds a finished day into
`analytics_daily` + `analytics_pages`; `pruneRawEvents` then deletes the raw rows for days
that have an aggregate — guarded on the aggregate **existing**, never on the date alone.

Neither is required for the dashboard to be correct: `metricsForRange` computes any
un-rolled day from raw events and adds it to the rolled ones. A deployment with no cron
loses speed and unbounded storage, not accuracy.

There is **no lease**, unlike `app.migrations`. A rollup is a pure function of one finished
day, so running it twice writes the same numbers; the unique index on `analytics_daily.day`
plus an upsert is the whole concurrency story.

Rates are never stored, only counts — a stored bounce *rate* cannot be summed across days
without weighting a quiet day the same as a busy one.

## Known trade-offs

**The tables are in the DEFAULT partition,** not their own. A separate partition is what
partitions are *for* here — a high-rate append that should not queue behind editorial
writes — but `Db.assertInPartition` rejects any table outside the DO's own partition, and a
Block Kit page renders inside `@pramen/cms`'s `adminPageInteract`, a default-partition
handler shared by every admin page. A partitioned analytics table would be readable by
everything except the screen built to read it. The queue sink keeps the write rate to
batches per second rather than pageviews, which is what makes this survivable.

**The dashboard has no chart.** Block Kit's vocabulary has no chart block, so the traffic
series is a table. The alternatives — a server-rendered SVG through `image`, or making this
the project's first `adminPanel` — are both larger decisions than a first slice should make.

## What is missing

- **The server-side collector.** Nothing yet injects `pramen-view` or records a pageview in
  the Worker, so today every number comes from the beacon.
- **A cron for the rollup.** `runAnalyticsRollup` and `pruneAnalytics` are admin mutations;
  wire them to a Cron Trigger or a task.
- **A `chart` block** in Block Kit.
