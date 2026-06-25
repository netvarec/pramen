// Unit test for ctx.queue: the producer facade + adapter seam (Cloudflare / memory),
// binding discovery, and the consumer dispatch (routing + per-message ack/retry).

import { describe, expect, test } from "bun:test";
import {
  Queue,
  MemoryQueueAdapter,
  CloudflareQueueAdapter,
  createQueue,
  discoverQueueBindings,
  type QueueProducerBinding,
} from "../packages/server/src/runtime/queue";
import {
  routeQueue,
  dispatchQueueBatch,
  type AppQueueMap,
  type QueueContext,
  type QueueBatch,
  type QueueMessage,
} from "../packages/server/src/runtime/queue-consumer";

describe("ctx.queue producer facade", () => {
  test("send delegates to the adapter for a named queue", async () => {
    const adapter = new MemoryQueueAdapter();
    const queue = new Queue(adapter);
    await queue.send("jobs", { kind: "resize", id: 1 }, { delaySeconds: 5 });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toMatchObject({ queue: "jobs", body: { kind: "resize", id: 1 }, options: { delaySeconds: 5 } });
  });

  test("sendBatch fans every message out to the adapter", async () => {
    const adapter = new MemoryQueueAdapter();
    const queue = new Queue(adapter);
    await queue.sendBatch("jobs", [{ body: "a" }, { body: "b", delaySeconds: 30 }]);
    expect(adapter.sent.map((s) => s.body)).toEqual(["a", "b"]);
  });

  test("validates the queue name, body, and non-empty batch", async () => {
    const queue = new Queue(new MemoryQueueAdapter());
    await expect(queue.send("", { x: 1 })).rejects.toThrow(/queue name/);
    await expect(queue.send("jobs", undefined)).rejects.toThrow(/body/);
    await expect(queue.sendBatch("jobs", [])).rejects.toThrow(/non-empty/);
    await expect(queue.sendBatch("jobs", [{ body: undefined }])).rejects.toThrow(/body/);
  });

  test("CloudflareQueueAdapter fails closed on an unknown queue, sends to a bound one", async () => {
    const sent: unknown[] = [];
    const binding: QueueProducerBinding = {
      send: async (b) => void sent.push(b),
      sendBatch: async () => {},
    };
    const queue = new Queue(new CloudflareQueueAdapter({ JOBS: binding }));
    await expect(queue.send("NOPE", { x: 1 })).rejects.toThrow(/no queue binding 'NOPE'/);
    await queue.send("JOBS", { x: 1 });
    expect(sent).toEqual([{ x: 1 }]);
  });

  test("discoverQueueBindings finds only send+sendBatch bindings (not email/KV)", () => {
    const env = {
      JOBS: { send: () => {}, sendBatch: () => {} }, // a queue
      EVENTS: { send: () => {}, sendBatch: () => {} }, // another queue
      EMAIL: { send: () => {} }, // email binding — send only, NOT a queue
      KV: { get: () => {}, put: () => {} }, // not a queue
      AUTH_SECRET: "x", // a var
    };
    expect(Object.keys(discoverQueueBindings(env)).sort()).toEqual(["EVENTS", "JOBS"]);
  });

  test("createQueue resolves discovered bindings by name", async () => {
    const sent: unknown[] = [];
    const env = { JOBS: { send: async (b: unknown) => void sent.push(b), sendBatch: async () => {} } };
    await createQueue(env).send("JOBS", { ok: true });
    expect(sent).toEqual([{ ok: true }]);
  });
});

describe("queue consumer dispatch", () => {
  const handler = () => {};
  test("routeQueue matches exact, then suffix (env-prefixed), then single-handler", () => {
    const one: AppQueueMap = { "pramen-jobs": handler };
    expect(routeQueue(one, "pramen-jobs")).toBe(handler); // exact (local)
    expect(routeQueue(one, "production-pramen-jobs")).toBe(handler); // suffix (remote env prefix)
    expect(routeQueue(one, "anything-at-all")).toBe(handler); // single-handler fallback

    const many: AppQueueMap = { a: handler, b: () => {} };
    expect(routeQueue(many, "no-match")).toBeNull(); // ambiguous → no route
  });

  const ctx = {} as QueueContext; // handlers under test don't touch ctx

  function makeBatch(queue: string, bodies: unknown[]): { batch: QueueBatch; acked: string[]; retried: string[] } {
    const acked: string[] = [];
    const retried: string[] = [];
    const messages: QueueMessage[] = bodies.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack: () => void acked.push(`m${i}`),
      retry: () => void retried.push(`m${i}`),
    }));
    return { batch: { queue, messages, ackAll: () => {}, retryAll: () => void retried.push("ALL") }, acked, retried };
  }

  test("ACKs each message a handler resolves; RETRIES one that throws", async () => {
    const queues: AppQueueMap = {
      jobs: async (_c, m) => {
        if ((m.body as { bad?: boolean }).bad) throw new Error("boom");
      },
    };
    const { batch, acked, retried } = makeBatch("jobs", [{ ok: 1 }, { bad: true }, { ok: 2 }]);
    await dispatchQueueBatch(queues, ctx, batch);
    expect(acked.sort()).toEqual(["m0", "m2"]); // the two that resolved
    expect(retried).toEqual(["m1"]); // the one that threw
  });

  test("an unrouted batch is retried whole, never silently acked", async () => {
    const { batch, acked, retried } = makeBatch("unknown", [{ x: 1 }]);
    await dispatchQueueBatch({ a: handler, b: handler }, ctx, batch);
    expect(acked).toEqual([]);
    expect(retried).toEqual(["ALL"]);
  });
});
