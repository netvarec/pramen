// The write seam. `/collect` and the Worker-side hook both hand events to a sink; what the
// sink does with them is an environment decision, not a caller decision.
//
// This mirrors `ctx.mail` / `ctx.files` / `ctx.queue`: an adapter chosen from the
// environment behind a one-method facade, with a memory implementation so handlers work
// off-platform. It matters more here than for mail, because the choice is a genuine
// throughput/latency trade and it should be changeable without touching the collector.

import type { AnalyticsEvent } from "./events";

/** Where a batch of events goes. `write` is called on the request path, so an
 * implementation must be cheap — the queue sink hands off, the direct sink does not. */
export interface AnalyticsSink {
  write(events: readonly AnalyticsEvent[]): Promise<void>;
}

/** The queue message the consumer expects. `tenant` rides ON THE MESSAGE because a queue
 * consumer is Worker-level and has no request to read it from. */
export interface AnalyticsQueueMessage {
  kind: "analytics.ingest";
  tenant: string;
  events: AnalyticsEvent[];
}

/** The producer half of the recommended production path: hand the batch to a Cloudflare
 * Queue and return. The visitor's request never waits for a database write, and the
 * consumer inserts a whole batch as one statement.
 *
 * `send` is awaited rather than fired-and-forgotten: an unawaited promise in a Worker
 * belongs to an invocation that may end before it settles, and its I/O is then canceled —
 * the same rule that wedged the D1 boot in #51. Awaiting a queue send is sub-millisecond. */
export class QueueSink implements AnalyticsSink {
  constructor(
    private readonly queue: { send(queue: string, body: unknown): Promise<void> },
    private readonly binding: string,
    private readonly tenant: string,
  ) {}

  async write(events: readonly AnalyticsEvent[]): Promise<void> {
    if (events.length === 0) return;
    const message: AnalyticsQueueMessage = { kind: "analytics.ingest", tenant: this.tenant, events: [...events] };
    await this.queue.send(this.binding, message);
  }
}

/** Write straight through, in the request. For local development and for deployments with
 * no queue bound.
 *
 * Not merely a fallback: with the DO store this is one in-process SQLite insert, which is
 * genuinely cheaper than a queue round trip. It becomes the wrong choice when the write
 * begins to contend — which is what the seam is for. */
export class DirectSink implements AnalyticsSink {
  constructor(private readonly ingest: (events: readonly AnalyticsEvent[]) => Promise<void>) {}

  async write(events: readonly AnalyticsEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ingest(events);
  }
}

/** Collects in memory. Tests, and any host with neither a queue nor a store. */
export class MemorySink implements AnalyticsSink {
  readonly events: AnalyticsEvent[] = [];

  async write(events: readonly AnalyticsEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

/** A sink that swallows everything, loudly once.
 *
 * Analytics must never be able to fail a page request — a broken collector that returns
 * 500 to `sendBeacon` is invisible, but a broken collector wired into the SERVER path
 * would take the page down with it. So the failure mode is deliberately "lose the data,
 * serve the page", and the one-shot log is what stops that from being silent. */
export class NoopSink implements AnalyticsSink {
  private warned = false;

  constructor(private readonly reason: string) {}

  async write(): Promise<void> {
    if (this.warned) return;
    this.warned = true;
    console.warn(`@pramen/analytics: events are being dropped — ${this.reason}`);
  }
}
