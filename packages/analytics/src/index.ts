// @pramen/analytics — first-party traffic analytics for a pramen deployment.
//
// SCOPE, because it explains most of what is missing compared with a hosted analytics
// product: this tracks ONE site — the project it is installed in. There is no sites table,
// no API key, no allowed-origin list and no per-site settings screen, and adding them later
// is a schema change, not a configuration one. That is the trade that buys the rest: a
// pageview can carry the CMS page's ID rather than a URL string, the collector needs no
// authentication surface of its own, and `siteId` is not a column on every table and in
// every index.
//
// TWO COLLECTORS, ONE PIPELINE. See `tracker.ts` for why: a Worker records the pageview
// when it served the page, the beacon records it when nothing did, and the beacon always
// reports the engagement a server cannot observe. The slice shipped here is the beacon and
// the pipeline behind it; the Worker-side hook is a separate change.

import { mutation, query, type EnvBag, type HandlerContext, type JsonValue } from "@pramen/server";
import type { QueueContext, QueueMessage } from "@pramen/server";
import type { RouteContext } from "@pramen/server/worker";
import { adb, INGEST_HANDLER, INGEST_ROLE, runIngest } from "./ingest";
import { metricsForRange, topPages } from "./queries";
import { pruneRawEvents, rollupPending } from "./rollup";
import { DirectSink, NoopSink, QueueSink, type AnalyticsQueueMessage, type AnalyticsSink } from "./sink";

export { analyticsSchema, ANALYTICS_PARTITION } from "./schema";
export { analyticsPolicies, type AnalyticsPolicyOpts } from "./policies";
export { collectRoute, trackerRoute, sessionId, type CollectOptions } from "./collect";
export { trackerScript, VIEW_META, type TrackerOptions } from "./tracker";
export { analyticsDashboard, type AnalyticsDashboardOpts } from "./dashboard";
export { adb, ingestEvents, INGEST_HANDLER, INGEST_ROLE, type AnalyticsDb, type IngestInput } from "./ingest";
export { computeDays, daysInRange, metricsForRange, topPages, type DayMetrics, type PageMetrics, type RangeMetrics } from "./queries";
export { previousDay, pruneRawEvents, rollupPending, type RollupResult } from "./rollup";
export { DirectSink, MemorySink, NoopSink, QueueSink, type AnalyticsQueueMessage, type AnalyticsSink } from "./sink";
export {
  clampMetric, dayOf, deriveDevice, deriveSource, isBot, normalizePath,
  DEVICES, EVENT_KINDS, EVENT_ORIGINS,
  type AnalyticsEvent, type Device, type EventKind, type EventOrigin,
} from "./events";

/** The queue this package's consumer is registered under, and the producer binding it
 * sends to. Both are overridable — a project with its own queue naming should say so once,
 * here, rather than in three places that can disagree. */
export const ANALYTICS_QUEUE = "pramen-analytics";
export const ANALYTICS_QUEUE_BINDING = "ANALYTICS";

/** Roles that may read the dashboard and the metric handlers. Matches `@pramen/cms`'s
 * default so a CMS deployment needs no extra configuration. */
const DEFAULT_VIEWER_ROLES = ["editor", "admin"] as const;

export interface AnalyticsOptions {
  /** Who may read the metrics handlers. Defaults to editor + admin. */
  viewerRoles?: readonly string[];
  /** Who may trigger a rollup or a prune. Defaults to admin only — these write. */
  adminRoles?: readonly string[];
  /** Producer binding for the queue sink. Set to `null` to force the direct sink. */
  queueBinding?: string | null;
  /** Queue name the consumer is registered under. */
  queueName?: string;
}

/**
 * Build the sink for a request.
 *
 * The order is the point. A bound queue wins because it takes the database write off the
 * visitor's request entirely; without one, the direct sink writes in-request, which on the
 * DO store is a single in-process SQLite insert and genuinely fine at small scale. Only
 * when neither is possible does it degrade to dropping events — loudly, once.
 */
export function createAnalyticsSink(
  env: EnvBag,
  routeCtx: RouteContext,
  opts: { tenant?: string; queueBinding?: string | null } = {},
): AnalyticsSink {
  const tenant = opts.tenant ?? "main";
  const bindingName = opts.queueBinding === undefined ? ANALYTICS_QUEUE_BINDING : opts.queueBinding;

  if (bindingName) {
    const binding = (env as Record<string, unknown>)[bindingName];
    // The same duck-test `createQueue` uses: a producer has BOTH `send` and `sendBatch`,
    // which is what distinguishes it from the send-only email binding.
    const isProducer =
      typeof binding === "object" && binding !== null &&
      typeof (binding as { send?: unknown }).send === "function" &&
      typeof (binding as { sendBatch?: unknown }).sendBatch === "function";
    if (isProducer) {
      const producer = binding as { send(body: unknown): Promise<void> };
      return new QueueSink({ send: (_q, body) => producer.send(body) }, bindingName, tenant);
    }
  }

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

/** Handlers to spread into `app.handlers`. */
export function createAnalyticsHandlers(opts: AnalyticsOptions = {}) {
  const viewerRoles = [...(opts.viewerRoles ?? DEFAULT_VIEWER_ROLES)];
  const adminRoles = [...(opts.adminRoles ?? ["admin"])];

  return {
    /** The single write path. Gated on `INGEST_ROLE`, which only the collector supplies —
     * see the note there for why the obvious `auth: []` does not work. */
    [INGEST_HANDLER]: mutation(
      (ctx: HandlerContext, input: { events: [] }) => runIngest(ctx, input as never),
      { auth: [INGEST_ROLE] },
    ),

    /** Headline metrics for a range. Role-gated: this reads `ctx.kv`-free but ALSO reads
     * through `ctx.db`, so the ACL bounds it too — the gate is what keeps an anonymous
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
      (ctx: HandlerContext, input: { through?: string; maxDays?: number }) => rollupPending(adb(ctx), input ?? {}),
      { auth: adminRoles },
    ),

    /** Delete raw events for days that have been rolled up. Separate from the rollup and
     * separately gated, because it is the only destructive operation here. */
    pruneAnalytics: mutation(
      (ctx: HandlerContext, input: { keepDays?: number }) => pruneRawEvents(adb(ctx), input ?? {}),
      { auth: adminRoles },
    ),
  };
}

/** Tasks to spread into `app.tasks` — the rollup as a deferred job, for a deployment that
 * drives it from `ctx.tasks.enqueue` rather than a cron. */
export function createAnalyticsTasks() {
  return {
    "analytics.rollup": async (ctx: HandlerContext) => {
      await rollupPending(adb(ctx));
    },
  };
}

/** The queue consumer to spread into `app.queues`, keyed by queue NAME.
 *
 * A consumer runs once per MESSAGE (not per batch) and is Worker-level, with no `ctx.db` —
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
