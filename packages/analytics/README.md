# @pramen/analytics

First-party traffic analytics for a pramen deployment: a public beacon endpoint, one event
table, a daily rollup, and a dashboard inside the CMS editor's own chrome.

**Status:** both collectors, the self-scheduling rollup and a charted dashboard work end to
end. The gaps that remain are listed at the bottom.

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
  createAnalyticsHandlers, createAnalyticsQueues, createAnalyticsSink, createAnalyticsTasks,
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

// Required: the daily rollup is a task, and ingest queues it.
const tasks = { ...createAnalyticsTasks() };
```

Then put the beacon on the site:

```html
<script src="https://your-worker.example.com/analytics.js" defer></script>
```

See `example/app.ts` for the wired version.

`createAnalytics({ keepDays? })` returns `{ handlers, tasks, queues }` for the same wiring in one
call, so the ingest handler and the rollup task it queues cannot be configured apart.

### Sessions need a salt

Set `ANALYTICS_SALT` (it falls back to `AUTH_SECRET`). Without one, **`sessionId` is null
and sessions, bounce rate and visit counts are unavailable**, which is deliberate. The
input is one IP address by one of a few thousand common User-Agent strings, so an *unsalted*
digest of it is enumerable: a reversible encoding of the visitor's IP that merely looks
anonymous. Failing closed is the only honest option.

Nothing is stored on the visitor's device (no cookie, no `localStorage`) and the day is
part of the hash, so the value cannot link a visitor across days even server-side.

## How a pageview gets counted

Two collectors, one pipeline. Which one records a given view is decided by **the HTML the
visitor actually received**, not by configuration:

- The page carries `<meta name="pramen-view" content="…">`: a Worker served it and already
  recorded the pageview. The beacon sends only **engagement** against that id.
- No meta tag: the page came off a CDN and nothing recorded it. The beacon mints an id and
  records the **pageview** itself.

A site with some prerendered and some on-demand routes therefore gets the right answer per
page, and a route that later moves to on-demand starts being counted by the server with no
analytics change at all.

| From the server | From the beacon |
| --- | --- |
| pageview, path + `cms_pages` id, referrer, country/city, device, identity | duration, scroll depth, clicks |

### The server-side collector

`recordView({ request, response, sink })` records the pageview for a response a Worker is
about to send and returns that response with the `pramen-view` tag in its `<head>`. It never
throws and stamps the page only after the sink accepted the event, so a lost view cannot leave
a page whose engagement is reported against nothing. `analyticsMiddleware` is the same thing
shaped as an Astro `onRequest`:

```ts
// src/middleware.ts, on the site's own Worker
import { env } from "cloudflare:workers";
import { analyticsMiddleware, createEdgeSink } from "@pramen/analytics";

export const onRequest = analyticsMiddleware({
  sink: () => createEdgeSink(env),
  env: () => env,
});
```

A site on its own Worker has no store, so `createEdgeSink` needs the `ANALYTICS` queue
producer bound to that Worker too; the pramen Worker's consumer writes the batch. Without the
binding it drops events and says so once. A page can set `x-pramen-page-id` on its response to
name the CMS page it drew (stripped before it leaves), which is what keeps a page's history
whole across a slug rename.

It records only a GET for a 200 HTML page from something that looks like a person. Bots,
prefetches, Do Not Track and Global Privacy Control are skipped, the same as in the beacon.
**A response that may be served from any cache is skipped too** (any positive `max-age` or
`s-maxage`, unless `no-store`, so `private, max-age=60` counts): the Worker would see one
request in many, and a shared cache or the visitor's own browser would replay the same stamped
id, after which the beacon (finding it) sends no pageview and the visit is counted nowhere.
Those pages fall through to the beacon, which counts each load. Send `no-store` or
`max-age=0` on HTML if you want server-side records for it. A sink that drops an event
(`NoopSink`, no queue bound) leaves the page unstamped for the same reason.
So does anything that is not a document navigation (a fragment fetch has no `<head>` to stamp; detected from `Sec-Fetch-Dest`/`HX-Request`, since a
streaming rewrite cannot look ahead for a `<head>`).
The write is awaited, so bind the `ANALYTICS` queue for a site with real traffic: `DirectSink`
puts a Durable Object write on every page's critical path.

Several columns are consequently nullable **by construction**. `origin` records which
collector produced a row, so a null `country` can be read as "no Worker saw this" rather
than "unknown country".

## The sink

`createAnalyticsSink` picks a transport from the environment, the same way `ctx.mail` does:

1. **`QueueSink`**: an `ANALYTICS` Cloudflare Queue producer binding is present. The batch
   is handed off and the visitor's request never waits for a database write. Recommended in
   production; declare the queue in `oblaka.ts` and spread `createAnalyticsQueues()` into
   `app.queues`.
2. **`DirectSink`**: no queue. Writes in-request through `callPrivileged`. On the DO store
   that is one in-process SQLite insert, which is genuinely fine at small scale.
3. **`NoopSink`**: neither is available. Drops events and says so once.

The privileged ingest handler is gated on `INGEST_ROLE` (`__analytics_ingest`). The `__`
prefix is load-bearing, not decorative: `@pramen/server` strips such roles from every
verified token, so the only way to present one is to be the Worker. `auth: []` does **not**
express "system-only": it is satisfied by nobody, `callPrivileged` included.

A collector failure never propagates: `collectRoute` logs and answers `204`. `sendBeacon`
discards the response anyway, and the same route shape is what the server-side hook will
call, where a throw would take the *page* down.

## Rollup and retention

`analytics_events` holds raw rows. `rollupPending` folds a finished day into
`analytics_daily` + `analytics_pages`; `pruneRawEvents` then deletes the raw rows for days
that have an aggregate, guarded on the aggregate **existing**, never on the date alone.

**The rollup runs itself.** It is a task (`analytics.rollup`, from `createAnalyticsTasks`) that
re-queues itself for the next 00:10 UTC each time it runs, and the first ingested batch on a
store starts the chain. It rides the outbox every deployment already has: the DO drains it from
an alarm, and the D1 store from the Cron Trigger the core already needs to drain delayed
tasks. So there is no analytics cron to wire. The one requirement is that
`createAnalyticsTasks()` is spread into `app.tasks`; without it the queued task has no handler.
Each run rolls up the finished days it finds, up to three passes of 14 days (a store that missed
months continues in follow-up tasks) and queues tomorrow's run *first*, so a failing rollup cannot end the chain. It does
**not** delete raw events unless asked: `createAnalyticsTasks({ keepDays: 90 })` opts in, because
pruning is irreversible and closes off new breakdowns. A missing `createAnalyticsTasks()` is
warned about at boot.

**Late events are reconciled.** A queue outage or retry can deliver an event stamped for a day
that was already rolled up. Ingest flags any already-past day it receives an event for
(`analytics_daily.dirty`, with a random `dirtyToken`): reads then compute that day from raw
events, the next rollup recomputes it, and pruning refuses to delete its raw rows. The rollup
clears the flag only if the token is unchanged when it writes, so an event that lands between
its read and its write (D1 has no single writer) keeps the day flagged. Finding what to roll
never groups the whole raw table: it looks at the unrolled tail and the flagged days.

**An event for a day whose raw rows were already pruned is dropped** (with a warning), because
that day can no longer be recomputed and admitting one straggler would replace its real history
with a single event. `keepDays` must be greater than 3, which is the grace that keeps this to a
queue outage longer than three days.

**An upgraded store is healed once.** Days an older version left unrolled below the newest rolled
one are flagged on the first scheduled run (`flagUnrolledDays`, marked in KV per store) so they are
rolled and can be pruned.

**The chain ends when traffic does.** A run re-queues itself only if something is pending, so an
idle tenant stops waking at 00:10; the next ingested batch starts it again. A long catch-up is
split across follow-up tasks (three 14-day passes per run) rather than one long run that a
second drainer could reclaim after 60 s.

The dashboard never depends on any of this for correctness: `metricsForRange` computes any
un-rolled day from raw events and adds it to the rolled ones. A deployment whose rollup does
not run loses speed and unbounded storage, not accuracy. `runAnalyticsRollup` and
`pruneAnalytics` remain as admin mutations for a manual catch-up.

There is **no lease**, unlike `app.migrations`. A rollup is a pure function of one finished
day, so running it twice writes the same numbers; the unique index on `analytics_daily.day`
plus an upsert is the whole concurrency story.

Rates are never stored, only counts: a stored bounce *rate* cannot be summed across days
without weighting a quiet day the same as a busy one.

## Known trade-offs

**The tables are in the DEFAULT partition,** not their own. A separate partition is what
partitions are *for* here: a high-rate append that should not queue behind editorial
writes, but `Db.assertInPartition` rejects any table outside the DO's own partition, and a
Block Kit page renders inside `@pramen/cms`'s `adminPageInteract`, a default-partition
handler shared by every admin page. A partitioned analytics table would be readable by
everything except the screen built to read it. The queue sink keeps the write rate to
batches per second rather than pageviews, which is what makes this survivable.

**The dashboard's chart is a Block Kit `chart` block,** a new block type in `@pramen/cms` and
`@pramen/cms-editor`: one series of labelled numbers (`bar` or `line`), drawn as inline SVG
with no charting dependency, coloured from the theme tokens. The server refuses a non-finite
value or more than 400 points on the way out, since a `NaN` coordinate draws nothing and reads
as "no traffic". The exact figures sit in a folded table under it.

## What is missing

- **The D1 store still needs the core's Cron Trigger.** It has no alarm, so a delayed task
  (this rollup included) runs only when the Cron Trigger drains it. The example's `oblaka.ts`
  already has one. Without it the dashboard stays correct, just slower.
- **The server-side collector needs the site to opt in** (`recordView` or the middleware);
  nothing injects it into a Worker automatically.
