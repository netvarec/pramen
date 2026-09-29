// @pramen/analytics: first-party traffic analytics for a pramen deployment.
//
// SCOPE, because it explains most of what is missing compared with a hosted analytics
// product: this tracks ONE site, the project it is installed in. There is no sites table,
// no API key, no allowed-origin list and no per-site settings screen, and adding them later
// is a schema change, not a configuration one. That is the trade that buys the rest: a
// pageview can carry the CMS page's ID rather than a URL string, the collector needs no
// authentication surface of its own, and `siteId` is not a column on every table and in
// every index.
//
// TWO COLLECTORS, ONE PIPELINE. See `tracker.ts` for why: a Worker records the pageview
// when it served the page, the beacon records it when nothing did, and the beacon always
// reports the engagement a server cannot observe. The Worker-side half is `recordView` /
// `analyticsMiddleware` (server.ts); the daily rollup schedules itself (schedule.ts).

import { isQueueProducer, mutation, query, type EnvBag, type HandlerContext, type JsonValue } from "@pramen/server";
import type { QueueContext, QueueMessage } from "@pramen/server";
import type { RouteContext } from "@pramen/server/worker";
import { adb } from "./db";
import { INGEST_HANDLER, INGEST_ROLE, runIngest } from "./ingest";
import { metricsForRange, topPages } from "./queries";
import { pruneRawEvents, rollupPending } from "./rollup";
import { assertKeepDays, ROLLUP_TASK, runScheduledRollup, type ScheduledRollupOpts } from "./schedule";
import { DirectSink, NoopSink, QueueSink, type AnalyticsQueueMessage, type AnalyticsSink } from "./sink";

export { analyticsSchema, ANALYTICS_PARTITION } from "./schema";
export { analyticsPolicies, type AnalyticsPolicyOpts } from "./policies";
export { collectRoute, trackerRoute, sessionId, type CollectOptions } from "./collect";
export {
  analyticsMiddleware, PAGE_ID_HEADER, recordView, shouldRecord, stripPageId,
  type AnalyticsMiddlewareOptions, type MiddlewareContext, type RecordViewOptions,
} from "./server";
export { assertKeepDays, ensureRollupScheduled, nextRollupAt, ROLLUP_TASK, runScheduledRollup, scheduleRollup, type ScheduledRollupOpts } from "./schedule";
export { trackerScript, VIEW_META, type TrackerOptions } from "./tracker";
export { analyticsDashboard, type AnalyticsDashboardOpts } from "./dashboard";
export { adb, type AnalyticsDb } from "./db";
export { ingestEvents, INGEST_HANDLER, INGEST_ROLE, type IngestInput } from "./ingest";
export { computeDays, daysInRange, metricsForRange, topPages, type DayMetrics, type PageMetrics, type RangeMetrics } from "./queries";
export { previousDay, pruneRawEvents, rollupPending, type RollupResult } from "./rollup";
export { DirectSink, MemorySink, NoopSink, QueueSink, type AnalyticsQueueMessage, type AnalyticsSink } from "./sink";
export {
  clampMetric, dayOf, deriveDevice, deriveSource, isBot, normalizePath,
  DEVICES, EVENT_KINDS, EVENT_ORIGINS,
  type AnalyticsEvent, type Device, type EventKind, type EventOrigin,
} from "./events";

/** The queue this package's consumer is registered under, and the producer binding it
 * sends to. Both are overridable: a project with its own queue naming should say so once,
 * here, rather than in three places that can disagree. */
export const ANALYTICS_QUEUE = "pramen-analytics";
export const ANALYTICS_QUEUE_BINDING = "ANALYTICS";

/** Roles that may read the dashboard and the metric handlers. Matches `@pramen/cms`'s
 * default so a CMS deployment needs no extra configuration. */
const DEFAULT_VIEWER_ROLES = ["editor", "admin"] as const;

export interface AnalyticsOptions {
  /** Who may read the metrics handlers. Defaults to editor + admin. */
  viewerRoles?: readonly string[];
  /** Who may trigger a rollup or a prune. Defaults to admin only, since these write. */
  adminRoles?: readonly string[];
  /** Producer binding for the queue sink. Set to `null` to force the direct sink. */
  queueBinding?: string | null;
  /** Queue name the consumer is registered under. */
  queueName?: string;
}

/** The queue producer bound under `name`, or null. Looked up by name and checked with the
 * core's own definition of a producer, so the two cannot disagree, and a per-request caller
 * (the edge middleware) does not scan the whole environment each time. */
function queueProducer(env: EnvBag, name: string): { send(body: unknown): Promise<void> } | null {
  const binding = (env as Record<string, unknown>)[name];
  return isQueueProducer(binding) ? binding : null;
}

/** The one place a producer becomes a `QueueSink`, so the two sink factories cannot drift. */
function queueSinkFor(producer: { send(body: unknown): Promise<void> }, binding: string, tenant: string): AnalyticsSink {
  return new QueueSink({ send: (_q, body) => producer.send(body) }, binding, tenant);
}

/** The sink for a Worker that is NOT the pramen one, such as an Astro site rendering on its
 * own Worker. It has no store and no `callPrivileged`, so the only way to reach the
 * analytics tables is the queue: bind the same `ANALYTICS` producer here and the pramen
 * Worker's consumer (`createAnalyticsQueues`) writes the batch. Without the binding it drops
 * events and says so once, since a silent no-op would look like a site with no visitors. */
export function createEdgeSink(env: EnvBag, opts: { tenant?: string; queueBinding?: string } = {}): AnalyticsSink {
  const name = opts.queueBinding ?? ANALYTICS_QUEUE_BINDING;
  const producer = queueProducer(env, name);
  if (producer) return queueSinkFor(producer, name, opts.tenant ?? "main");
  // One Noop per binding NAME, not per env object: a middleware builds its sink per REQUEST and
  // each instance warns once, and an `env` that is a fresh object every request (a proxy, a
  // spread) would defeat a cache keyed on identity.
  let noop = missingProducer.get(name);
  if (!noop) {
    noop = new NoopSink(`no "${name}" queue producer is bound to this Worker, so server-side pageviews cannot reach the analytics store.`);
    missingProducer.set(name, noop);
  }
  return noop;
}

const missingProducer = new Map<string, AnalyticsSink>();

/**
 * Build the sink for a request.
 *
 * The order is the point. A bound queue wins because it takes the database write off the
 * visitor's request entirely; without one, the direct sink writes in-request, which on the
 * DO store is a single in-process SQLite insert and genuinely fine at small scale. Only
 * when neither is possible does it degrade to dropping events, loudly, once.
 */
export function createAnalyticsSink(
  env: EnvBag,
  routeCtx: RouteContext,
  opts: { tenant?: string; queueBinding?: string | null } = {},
): AnalyticsSink {
  const tenant = opts.tenant ?? "main";
  const bindingName = opts.queueBinding === undefined ? ANALYTICS_QUEUE_BINDING : opts.queueBinding;

  const producer = bindingName ? queueProducer(env, bindingName) : null;
  if (producer) return queueSinkFor(producer, bindingName as string, tenant);

  return new DirectSink(async (events) => {
    const res = await routeCtx.callPrivileged({
      name: INGEST_HANDLER,
      input: { events } as unknown as JsonValue,
      tenant,
      roles: [INGEST_ROLE],
    });
    // `callPrivileged` answers with a Response; a non-2xx here means the events did not
    // land. Surfaced as a throw so `collectRoute`'s catch logs it rather than the batch
    // disappearing with a 204 on the wire.
    if (!res.ok) throw new Error(`analytics ingest failed: ${res.status}`);
  });
}

/** A sink that reports why it is doing nothing. For a host with neither a queue nor a
 * privileged call available. */
export function noopSink(reason: string): AnalyticsSink {
  return new NoopSink(reason);
}

/** The two fields the admin mutation may set, checked. Everything else in the request is
 * dropped: `rollupPending` also takes `days`, which skips the pending-day guards, so an
 * unfiltered pass-through let a caller recompute a pruned day from zero raw rows and overwrite
 * its aggregate with zeros (or roll a future day). Today is allowed, and safe: ingest flags today's aggregate dirty as soon as another event arrives (see `markLateDays`). */
function rollupInput(input: { through?: unknown; maxDays?: unknown } | undefined): { through?: string; maxDays?: number } {
  const out: { through?: string; maxDays?: number } = {};
  if (input?.through !== undefined) {
    if (typeof input.through !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.through) || input.through > new Date().toISOString().slice(0, 10)) {
      throw new Error("runAnalyticsRollup: `through` must be a YYYY-MM-DD day no later than today (UTC)");
    }
    out.through = input.through;
  }
  if (input?.maxDays !== undefined) {
    if (typeof input.maxDays !== "number" || !Number.isInteger(input.maxDays) || input.maxDays < 1 || input.maxDays > 60) {
      throw new Error("runAnalyticsRollup: `maxDays` must be an integer from 1 to 60");
    }
    out.maxDays = input.maxDays;
  }
  return out;
}

/** Handlers to spread into `app.handlers`. */
export function createAnalyticsHandlers(opts: AnalyticsOptions = {}) {
  const viewerRoles = [...(opts.viewerRoles ?? DEFAULT_VIEWER_ROLES)];
  const adminRoles = [...(opts.adminRoles ?? ["admin"])];

  return {
    /** The single write path. Gated on `INGEST_ROLE`, which only the collector supplies.
     * see the note there for why the obvious `auth: []` does not work. */
    [INGEST_HANDLER]: mutation(
      (ctx: HandlerContext, input: { events: [] }) => runIngest(ctx, input as never),
      { auth: [INGEST_ROLE], requiresTasks: [ROLLUP_TASK] },
    ),

    /** Headline metrics for a range. Role-gated: this reads `ctx.kv`-free but ALSO reads
     * through `ctx.db`, so the ACL bounds it too. The gate is what keeps an anonymous
     * caller from learning the shape of the traffic at all. */
    analyticsOverview: query(
      (ctx: HandlerContext, input: { from: string; to: string }) => metricsForRange(adb(ctx), input.from, input.to),
      { auth: viewerRoles },
    ),

    analyticsTopPages: query(
      (ctx: HandlerContext, input: { from: string; to: string; limit?: number }) =>
        topPages(adb(ctx), input.from, input.to, input.limit ?? 10),
      { auth: viewerRoles },
    ),

    /** Run the rollup by hand. The cron is the normal trigger; this exists so a deployment
     * without one can catch up, and so the job can be exercised in a test without waiting
     * for a schedule. */
    runAnalyticsRollup: mutation(
      (ctx: HandlerContext, input: { through?: string; maxDays?: number }) => rollupPending(adb(ctx), rollupInput(input)),
      { auth: adminRoles },
    ),

    /** Delete raw events for days that have been rolled up. Separate from the rollup and
     * separately gated, because it is the only destructive operation here. */
    pruneAnalytics: mutation(
      (ctx: HandlerContext, input: { keepDays?: number }) => {
        // Refuse rather than clamp: a caller who typed 0 or NaN is not asking for the default.
        if (input?.keepDays !== undefined) assertKeepDays(input.keepDays);
        return pruneRawEvents(adb(ctx), { keepDays: input?.keepDays });
      },
      { auth: adminRoles },
    ),
  };
}

/** Tasks to spread into `app.tasks`. REQUIRED for the daily rollup: ingest queues it, and a
 * task with no handler here is a task that never runs. */
export function createAnalyticsTasks(opts: ScheduledRollupOpts = {}) {
  assertKeepDays(opts.keepDays);
  return {
    // Rolls up, optionally prunes (`keepDays`; never by default), and queues tomorrow's run,
    // so it keeps itself going. The first ingest on a store starts the chain
    // (`ensureRollupScheduled`); nothing needs a cron of its own.
    [ROLLUP_TASK]: async (ctx: HandlerContext, payload?: unknown) => runScheduledRollup(ctx, payload, opts),
  };
}

/** The queue consumer to spread into `app.queues`, keyed by queue NAME.
 *
 * A consumer runs once per MESSAGE (not per batch) and is Worker-level, with no `ctx.db`,
 * so it reaches the store the only way it can, `callPrivileged` into the tenant the message
 * names. One message already carries a whole batch of events, because that is what the
 * producer sends: the batching happens at `QueueSink.write`, so this stays one privileged
 * call per message rather than one per pageview. */
export function createAnalyticsQueues(opts: { queueName?: string } = {}) {
  const name = opts.queueName ?? ANALYTICS_QUEUE;
  return {
    [name]: async (ctx: QueueContext, message: QueueMessage) => {
      const body = message.body as AnalyticsQueueMessage | undefined;
      // A message this consumer does not recognise is ACKED, not retried. Retrying it would
      // redeliver forever and eventually dead-letter something that was never ours; the
      // queue name is shared configuration and a foreign message is a wiring mistake, which
      // a log names better than a retry loop does.
      if (body?.kind !== "analytics.ingest" || !Array.isArray(body.events)) {
        console.warn("@pramen/analytics: ignoring a message that is not an analytics.ingest batch");
        return;
      }
      const res = await ctx.callPrivileged({
        name: INGEST_HANDLER,
        input: { events: body.events } as unknown as JsonValue,
        tenant: body.tenant,
        roles: [INGEST_ROLE],
      });
      // Throwing retries the message, which is what at-least-once delivery is for. Events
      // duplicated by a retry are the accepted cost: a row is cheap and a lost pageview is
      // not recoverable.
      if (!res.ok) throw new Error(`analytics ingest failed: ${res.status}`);
    },
  };
}

/** Everything a deployment spreads, from one call, so the halves that must agree cannot be
 * configured apart: the ingest handler queues the rollup task, and the task handler is
 * what runs it. Forgetting `tasks` while taking `handlers` was a silent dead-letter loop.
 *
 *   const analytics = createAnalytics({ keepDays: 90 });
 *   // handlers: { ...analytics.handlers }, tasks: { ...analytics.tasks },
 *   // queues: { ...analytics.queues }
 *
 * The individual factories stay exported for a deployment that composes them itself. */
export function createAnalytics(opts: AnalyticsOptions & ScheduledRollupOpts = {}) {
  return {
    handlers: createAnalyticsHandlers(opts),
    tasks: createAnalyticsTasks(opts),
    queues: createAnalyticsQueues({ queueName: opts.queueName }),
  };
}
