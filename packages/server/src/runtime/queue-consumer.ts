// Queue consumer dispatch — the receiving half of ctx.queue. A pramen Worker is the
// consumer for its declared queues (oblaka `new Queue({ binding: "both", ... })`), so
// `createPramen(app).queue` is the Cloudflare `queue(batch, env, ctx)` entry. It routes
// each batch to the matching `app.queues[name]` handler and ACKs/RETRIES per message.
//
// A consumer runs in the WORKER, not a Durable Object — a queue message isn't bound to a
// tenant, so there's no direct `ctx.db`. To touch tenant data, carry the tenant in the
// message body and `ctx.callPrivileged({ name, input, tenant })` into its DO (exactly
// like a public route). The consumer still gets `ctx.mail` / `ctx.queue` / `ctx.kv` /
// `ctx.env`, so the canonical "consume a job → send a notification" path is one call.

import type { Mail } from "./mail";
import type { Queue } from "./queue";
import type { Kv } from "./kv";

/** One received message (the Cloudflare Queues `Message` shape). */
export interface QueueMessage<Body = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  /** 1-based delivery attempt — grows on each retry (use it to give up / dead-letter). */
  readonly attempts: number;
  /** Mark this message handled (won't be redelivered). The framework calls this for you
   * when the handler resolves; call it yourself only for fine-grained control. */
  ack(): void;
  /** Schedule this message for redelivery (the framework calls it when the handler throws). */
  retry(options?: { delaySeconds?: number }): void;
}

/** A batch delivered to the consumer (the Cloudflare Queues `MessageBatch` shape). */
export interface QueueBatch<Body = unknown> {
  /** The queue this batch came from (the oblaka `Queue` name; env-prefixed remotely). */
  readonly queue: string;
  readonly messages: readonly QueueMessage<Body>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

/** The context handed to a queue consumer handler. Worker-level (no `ctx.db`): reach
 * tenant data via `ctx.callPrivileged`. */
export interface QueueContext {
  /** The Worker environment (bindings + vars + secrets). */
  readonly env: Readonly<Record<string, unknown>>;
  /** Project KV (cross-tenant). */
  readonly kv: Kv;
  /** Send email (the notification path). */
  readonly mail: Mail;
  /** Enqueue onto a (possibly different) queue — fan-out / chaining. */
  readonly queue: Queue;
  /** Apply a privileged mutation into a tenant's DO (the consumer has no direct db).
   * The message body should carry the `tenant`. */
  callPrivileged(opts: { name: string; input?: unknown; tenant?: string; roles?: string[]; partition?: string }): Promise<Response>;
}

/** A queue consumer handler — runs once per message. Resolving ACKs the message;
 * throwing RETRIES it (subject to the queue's max_retries → dead-letter queue). */
export type QueueHandler<Body = unknown> = (ctx: QueueContext, message: QueueMessage<Body>) => void | Promise<void>;

/** Map of queue name → consumer handler. Set as `app.queues`; dispatched by
 * `createPramen(app).queue`. */
export type AppQueueMap = Record<string, QueueHandler>;

/** Resolve the handler for a batch's queue. Queue names are env-prefixed in remote
 * environments (`production-pramen-jobs`) but bare locally (`pramen-jobs`), so match
 * leniently: exact, then suffix (`…-<key>`), then — if there's exactly one handler —
 * fall through to it (the common single-queue app). Returns null if nothing matches. */
export function routeQueue(queues: AppQueueMap, queueName: string): QueueHandler | null {
  const keys = Object.keys(queues);
  if (queues[queueName]) return queues[queueName];
  const suffix = keys.find((k) => queueName.endsWith(`-${k}`) || k.endsWith(`-${queueName}`));
  if (suffix) return queues[suffix];
  if (keys.length === 1) return queues[keys[0]];
  return null;
}

/** Dispatch one batch: route to the handler, then run it per message, ACKing on success
 * and RETRYing on throw (per message, so one poison message doesn't re-deliver the rest).
 * An unrouted batch is retried whole (never silently acked) and logged. */
export async function dispatchQueueBatch(queues: AppQueueMap, ctx: QueueContext, batch: QueueBatch): Promise<void> {
  const handler = routeQueue(queues, batch.queue);
  if (!handler) {
    console.error(`pramen: no app.queues handler for queue '${batch.queue}' — retrying batch (declare it in app.queues)`);
    batch.retryAll();
    return;
  }
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        await handler(ctx, message);
        message.ack();
      } catch (err) {
        console.error(`pramen: queue '${batch.queue}' message ${message.id} failed (attempt ${message.attempts}) — retrying`, err);
        message.retry();
      }
    }),
  );
}
