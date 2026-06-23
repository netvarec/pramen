---
title: Deferred Tasks
order: 8
summary: A transactional outbox for side effects after a write — send a notification email, fire a webhook — off the single-writer path, with retry and at-least-once delivery.
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
      // Send via Cloudflare Email Sending (the `send_email` binding) — no API keys.
      await (ctx.env.EMAIL as SendEmail).send({ to, from: { email: "hi@acme.com" }, subject: "…", text: "…" });
    },
  },
};
```

- **`ctx.tasks.enqueue({ kind, payload?, delayMs? })`** — `delayMs` defers when the
  task becomes due. Atomic with the surrounding mutation.
- **A task handler** gets a privileged (system-scoped) `ctx` — `ctx.env` for bindings
  like `EMAIL`, plus `ctx.db`/`ctx.kv` — and `meta` (see idempotency below).

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
