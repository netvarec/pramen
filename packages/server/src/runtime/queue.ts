// ctx.queue — Cloudflare Queues producer facade, the same shape as ctx.mail / ctx.files:
// an adapter seam (CloudflareQueueAdapter / MemoryQueueAdapter) behind a thin `Queue`
// facade, built from the environment. Handlers enqueue onto a native Cloudflare Queue
// without touching the producer binding directly:
//
//   await ctx.queue.send("jobs", { kind: "resize", id });
//   await ctx.queue.sendBatch("jobs", [{ body: a }, { body: b, delaySeconds: 30 }]);
//
// This is distinct from `ctx.tasks` (the transactional outbox). `ctx.tasks.enqueue`
// is atomic with the mutation's DB write (commit-or-rollback together) and drained
// in-process. `ctx.queue` is a native Cloudflare Queue: NOT transactional with the
// write (the message is sent regardless of whether the mutation later rolls back),
// but higher-throughput, with platform-native batching/retry/DLQ and a consumer that
// can run in a *different* Worker. Reach for ctx.tasks when the side-effect must commit
// with the data; reach for ctx.queue for decoupled, high-volume fan-out.
//
// On Cloudflare the transport is the Queues producer binding (declared in oblaka.ts as
// `new Queue({ binding: "both", ... })`). Off-platform / unconfigured, sending to a queue
// that isn't bound FAILS CLOSED (throws) rather than silently dropping the message —
// mirroring how ctx.mail fails closed without a transport.

/** Cloudflare Queues content type for a sent message. Omitted ⇒ the platform default
 * (v8 structured clone). Use "json" for cross-runtime / external consumers. */
export type QueueContentType = "text" | "bytes" | "json" | "v8";

/** Per-message send options (mirrors the Cloudflare Queues producer API). */
export interface QueueSendOptions {
  /** Defer delivery by N seconds (the consumer won't see the message until then). */
  delaySeconds?: number;
  /** How the body is serialized on the wire. Omitted ⇒ platform default (v8). */
  contentType?: QueueContentType;
}

/** One message in a `sendBatch` — a body plus its own per-message options. */
export interface QueueSendRequest {
  body: unknown;
  delaySeconds?: number;
  contentType?: QueueContentType;
}

/** Batch-level send options. */
export interface QueueBatchOptions {
  /** Default delay applied to every message in the batch (per-message overrides win). */
  delaySeconds?: number;
}

/** The Cloudflare Queues producer binding shape (what `env.<QUEUE>` exposes). A binding
 * is recognized as a queue producer iff it has BOTH `send` and `sendBatch` (which
 * distinguishes it from the email `send`-only binding, KV, R2, D1, …). */
export interface QueueProducerBinding {
  send(body: unknown, options?: QueueSendOptions): Promise<void>;
  sendBatch(messages: Iterable<QueueSendRequest>, options?: QueueBatchOptions): Promise<void>;
}

/** The transport seam — one per backend (Cloudflare Queues, an in-memory capture, …). */
export interface QueueAdapter {
  send(queue: string, body: unknown, options?: QueueSendOptions): Promise<void>;
  sendBatch(queue: string, messages: readonly QueueSendRequest[], options?: QueueBatchOptions): Promise<void>;
}

/** The `ctx.queue` facade: validates, then delegates to the adapter for a named queue. */
export class Queue {
  constructor(private readonly adapter: QueueAdapter) {}

  /** Enqueue a single message onto `queue`. `body` is serialized by the platform. */
  async send(queue: string, body: unknown, options?: QueueSendOptions): Promise<void> {
    assertQueueName(queue);
    if (body === undefined) throw new Error("ctx.queue.send: `body` is required");
    await this.adapter.send(queue, body, options);
  }

  /** Enqueue many messages onto `queue` in one call (cheaper than N sends). */
  async sendBatch(queue: string, messages: readonly QueueSendRequest[], options?: QueueBatchOptions): Promise<void> {
    assertQueueName(queue);
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("ctx.queue.sendBatch: `messages` must be a non-empty array");
    }
    for (const m of messages) {
      if (!m || m.body === undefined) throw new Error("ctx.queue.sendBatch: every message needs a `body`");
    }
    await this.adapter.sendBatch(queue, messages, options);
  }
}

function assertQueueName(queue: string): void {
  if (typeof queue !== "string" || queue.length === 0) {
    throw new Error("ctx.queue: a queue name is required (the oblaka `Queue` name)");
  }
}

/** Cloudflare Queues transport. Constructed with the producer bindings discovered from
 * the environment, keyed by binding name. Sending to a name with no bound queue throws
 * a clear error (fail-closed) — a missing binding is a config error, not a silent drop. */
export class CloudflareQueueAdapter implements QueueAdapter {
  constructor(private readonly bindings: Readonly<Record<string, QueueProducerBinding>>) {}

  private bindingFor(queue: string): QueueProducerBinding {
    const b = this.bindings[queue];
    if (!b) {
      const known = Object.keys(this.bindings);
      const avail = known.length ? known.join(", ") : "none";
      throw new Error(
        `ctx.queue: no queue binding '${queue}' — declare it in oblaka.ts ` +
          `(new Queue({ name: '${queue}', binding: 'both' })). Bound queues: ${avail}.`,
      );
    }
    return b;
  }

  async send(queue: string, body: unknown, options?: QueueSendOptions): Promise<void> {
    await this.bindingFor(queue).send(body, options);
  }

  async sendBatch(queue: string, messages: readonly QueueSendRequest[], options?: QueueBatchOptions): Promise<void> {
    await this.bindingFor(queue).sendBatch(messages, options);
  }
}

/** In-memory transport: captures sent messages instead of delivering them. For unit
 * tests (assert on `.sent`) and pure off-platform use. */
export class MemoryQueueAdapter implements QueueAdapter {
  readonly sent: Array<{ queue: string; body: unknown; options?: QueueSendOptions | QueueBatchOptions }> = [];
  async send(queue: string, body: unknown, options?: QueueSendOptions): Promise<void> {
    this.sent.push({ queue, body, options });
  }
  async sendBatch(queue: string, messages: readonly QueueSendRequest[], options?: QueueBatchOptions): Promise<void> {
    for (const m of messages) this.sent.push({ queue, body: m.body, options: { ...options, ...m } });
  }
}

/** Discover the Cloudflare Queues producer bindings in an environment: any value that
 * exposes BOTH `send` and `sendBatch` functions (which excludes the email `send`-only
 * binding, KV, R2, D1, the DO namespace, …). Returns name → binding. */
export function discoverQueueBindings(env: Readonly<Record<string, unknown>>): Record<string, QueueProducerBinding> {
  const out: Record<string, QueueProducerBinding> = {};
  for (const [name, value] of Object.entries(env)) {
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { send?: unknown }).send === "function" &&
      typeof (value as { sendBatch?: unknown }).sendBatch === "function"
    ) {
      out[name] = value as QueueProducerBinding;
    }
  }
  return out;
}

/** Build `ctx.queue` from the environment: a Cloudflare adapter over the discovered
 * producer bindings. Sending to an undeclared queue fails closed (the adapter throws).
 * There is no silent capture fallback — declare the `Queue` binding and it exists in
 * dev (lopata) and miniflare too. */
export function createQueue(env: Readonly<Record<string, unknown>>): Queue {
  return new Queue(new CloudflareQueueAdapter(discoverQueueBindings(env)));
}
