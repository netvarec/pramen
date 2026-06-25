// ctx.queue end-to-end on a native Cloudflare Queue: a mutation PRODUCES a job onto the
// queue (env.JOBS), and the Worker's queue CONSUMER (app.queues["pramen-jobs"], dispatched
// by createPramen().queue) processes it — here recording it in KV. Proves the full
// produce → consume round-trip under miniflare, plus that the producer is call-gated.

import { assert, http, token, sleep } from "../lib";

export async function runQueue(base: string): Promise<void> {
  const call = http(base, "main");
  const admin = await token("admin", ["admin"]);

  // enqueueJob is admin-gated (it touches ctx.queue directly, bypassing the row-ACL).
  const id = `job-${Date.now()}`;
  const produced = await call("enqueueJob", { id }, admin);
  assert(produced.body.ok && produced.body.result?.queued === id, "queue: enqueueJob produced a message onto the queue");

  // the consumer runs asynchronously (batched, maxBatchTimeout: 1s) — poll the KV the
  // consumer writes until it lands.
  let consumed: string | null = null;
  for (let i = 0; i < 80; i++) {
    const r = await call("__jobInbox", { id }, admin);
    if (r.body.result?.body) {
      consumed = r.body.result.body as string;
      break;
    }
    await sleep(100);
  }
  assert(consumed === `done:${id}`, "queue: the consumer (app.queues) processed the produced message");

  // the producer is call-gated: anonymous cannot enqueue.
  const anon = await call("enqueueJob", { id: "nope" });
  assert(anon.status === 403, "queue: enqueueJob is admin-only (403 without a token)");
}
