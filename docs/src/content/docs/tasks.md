---
title: Deferred Tasks
order: 8
summary: A transactional outbox for side effects after a write — send a notification email (ctx.mail), fire a webhook — off the single-writer path, with retry and at-least-once delivery, plus declarative per-entity triggers and native Cloudflare Queues (ctx.queue).
---

To run a side effect after a write — send a notification email, call a webhook —
**don't** do it inline in the mutation: that runs inside the single-writer
transaction (it blocks other writes for the round-trip, and an external call can't be
rolled back). Instead enqueue a **task**. `ctx.tasks.enqueue` writes a row to an
outbox table **in the same transaction** as your data, so the task and the data commit
(or roll back) together — no dual-write window — and a drainer runs it afterwards, off
the write path, with retry.

## Enqueue + handle

```ts
// In a handler: write data AND enqueue a task, atomically.
const sendInvite = mutation(async (ctx, input: { email: string }) => {
  const invite = await ctx.db.insert("invites", { email: input.email, /* … */ });
  await ctx.tasks.enqueue({ kind: "invite-email", payload: { to: input.email } });
  return invite; // if this throws, BOTH the invite and the task roll back
});

// app.tasks maps `kind` → handler. It runs after commit with a privileged context.
const app = {
  schema,
  handlers: { sendInvite },
  tasks: {
    "invite-email": async (ctx, payload, meta) => {
      const { to } = payload as { to: string };
      await ctx.mail.send({ to, subject: "You're invited", text: "…" }); // ctx.mail — see below
    },
  },
};
```

- **`ctx.tasks.enqueue({ kind, payload?, delayMs? })`** — `delayMs` defers when the
  task becomes due. Atomic with the surrounding mutation.
- **A task handler** gets a privileged (system-scoped) `ctx` — `ctx.mail`/`ctx.env`/
  `ctx.db`/`ctx.kv` — and `meta` (see idempotency below).

## Sending email (`ctx.mail`)

`ctx.mail` is the email facade — handlers send without touching the binding directly:

```ts
await ctx.mail.send({ to: "u@x.com", from?, subject: "Welcome", text?, html?, replyTo? });
```

The transport is chosen from the environment:

- **`EMAIL` binding + `MAIL_FROM`** → **Cloudflare Email Sending** (no API keys; `from`
  defaults to `MAIL_FROM`, override per message). Declare the `send_email` binding in
  `oblaka.ts` (`EmailService`) and onboard the domain
  (`wrangler email sending enable yourdomain.com`).
- **`MAIL_CAPTURE=true`** (dev opt-in) → mail is **captured** to KV (`mail:<recipient>`)
  instead of sent, so a dashboard / e2e can read the "inbox".
- **neither** → `send` **fails closed** (throws), so a misconfigured production never
  silently stashes a security email instead of delivering it.

Prefer enqueuing the send as a **task** (above) so it runs off the single-writer write
path with retry — `ctx.tasks` + `ctx.mail` together are the "send a notification email
on a write" pattern.

## Native queues (`ctx.queue`)

`ctx.tasks` is a **transactional outbox** — atomic with your write, drained in-process.
For **decoupled, high-throughput fan-out** there's `ctx.queue`, a facade over native
**Cloudflare Queues**: platform-level batching, retry, and dead-letter, with a consumer
that can even run in a *different* Worker.

```ts
// Produce: address the queue by its BINDING name (declared in oblaka.ts).
await ctx.queue.send("JOBS", { kind: "resize", id });
await ctx.queue.sendBatch("JOBS", [{ body: a }, { body: b, delaySeconds: 30 }]);
```

Declare the queue in `oblaka.ts` and make this Worker both producer and consumer:

```ts
import { Queue } from "oblaka-iac";
// bindings: { … }
JOBS: new Queue({ name: "pramen-jobs", binding: "both",
  consumer: { maxBatchSize: 10, maxRetries: 3, deadLetterQueue: "pramen-dlq" } }),
```

Consume with **`app.queues`** (keyed by the queue **name**), dispatched by
`createPramen(app).queue` — wire it into your Worker entry next to `fetch`:

```ts
const app = { schema, handlers, /* … */, queues: {
  "pramen-jobs": async (ctx, message) => {
    const { tenant, id } = message.body as { tenant: string; id: string };
    // A consumer is Worker-level — no ctx.db. Reach a tenant's DO via callPrivileged
    // (the message carries the tenant), and/or ctx.mail / ctx.queue / ctx.kv.
    await ctx.callPrivileged({ name: "markDone", input: { id }, tenant });
  },
}};

const pramen = createPramen(app);
export default { fetch: pramen.fetch, scheduled: pramen.scheduled, queue: pramen.queue };
```

A handler **resolves → the message is ACKed**; it **throws → the message is RETRIED**
(per message, up to the queue's `maxRetries`, then dead-lettered). Queue names are
env-prefixed remotely (`production-pramen-jobs`) but bare locally — `app.queues` is
matched leniently (exact, then suffix, then the single-queue fallback).

**`ctx.queue` vs `ctx.tasks`:** use `ctx.tasks` when the side-effect must commit *with*
the data (it's in the transaction, and a rollback un-enqueues it). Use `ctx.queue` for
volume / decoupling / a cross-Worker consumer — a send is **not** transactional (the
message goes out regardless of whether the mutation later rolls back). Sending to a
queue that isn't declared **fails closed** (throws) rather than dropping the message.

## Delivery: at-least-once + retry

A task is delivered **at least once**. On failure it retries with exponential
backoff; past 5 attempts it's **dead-lettered** (`status = 'failed'`). Because
delivery can repeat (a crash between "email sent" and "marked done"), handlers get an
idempotency key:

```ts
"charge": async (ctx, payload, meta) => {
  // meta.id is stable across retries — dedupe a non-idempotent effect on it.
  if (await alreadyProcessed(ctx, meta.id)) return;
  await doTheCharge(payload);
  await markProcessed(ctx, meta.id); // meta.attempts is the 1-based try number
}
```

## Declarative triggers

Instead of calling `ctx.tasks.enqueue` by hand in every handler, declare a **trigger**
on an entity — the `Db` write path then enqueues the task automatically (still in the
same transaction as the write):

```ts
notes: Entity(
  (t) => ({ id: t.id(), title: t.text(), publishedAt: t.int() /* … */ }),
  (r) => ({ /* relations */ }),
  {
    triggers: [
      trigger({ task: "note-changed", on: { create: true, update: ["title"] } }),
      trigger({ task: "on-publish", on: { update: ["publishedAt"] } }),
    ],
  },
);
```

The matching `app.tasks` handler receives the framework payload `{ entity, op, id, row }`:

```ts
tasks: {
  "note-changed": async (ctx, payload, meta) => {
    const { op, id, row } = payload as { op: "create" | "update" | "delete"; id: number; row: { title: string } };
    // … send the email / webhook
  },
}
```

- **`on`** — `create` / `delete` are booleans; `update` is `true` (any update) or a
  **field list**. A field-filtered update fires only when one of those columns'
  values actually **changes** (not on a same-value write).
- **Only ORM writes fire triggers** — `ctx.db` insert/update/delete. The raw
  `ctx.db.exec` escape hatch does not, and neither do a task handler's own writes (so a
  trigger can't cascade into a loop).
- **`hidden()` columns are stripped** from the payload `row` — a secret never reaches
  the task handler.
- A trigger whose `task` has no `app.tasks` handler is rejected at deploy by
  `createPramen` (fail-fast, not a silent dead-letter).

## Draining — and the two store paths

The outbox is **substrate-agnostic** (it rides the same `Driver` as your data), but
the wake-up differs by store:

- **Durable Object store (default)** — the DO **self-drains via an alarm** scheduled
  for the next due task. Nothing to wire; a backed-off retry re-arms its own alarm.
- **D1 store** (`x-pramen-store: d1`, no DO/alarm) — drain via a **Cron Trigger**.
  `createPramen(app)` returns a `scheduled` handler for exactly this:

  ```ts
  const pramen = createPramen(app);
  export default { fetch: pramen.fetch, scheduled: pramen.scheduled };
  ```
  Add a `[triggers] crons` entry (in `oblaka.ts` / wrangler) to call it. Concurrent
  drains are safe — each claims a disjoint batch.

You can also drain **on demand** (admin-gated): `POST /admin/tasks/drain`
(`{ tenant, partition? }`, or `x-pramen-store: d1`).

## Admin visibility

`GET /admin/tasks/list?status=&limit=` (admin-gated; `?tenant=&partition=` or
`x-pramen-store: d1`) lists outbox rows — pass `status=failed` to inspect
dead-letters. Delivered (`done`) rows are pruned automatically after a retention
window, so the table stays bounded.
