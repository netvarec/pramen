// Deferred tasks end-to-end on the DO store: a mutation enqueues a notification in the
// SAME transaction as a note write; the task runs off the write path (here it stashes
// to KV instead of emailing) and is drained via /admin/tasks/drain. Proves delivery
// and the outbox's atomicity (a rolled-back mutation enqueues nothing).

import { assert, http, token } from "../lib";

async function drain(base: string, admin: string): Promise<{ processed: number; succeeded: number; remaining: number }> {
  const r = await fetch(`${base}/admin/tasks/drain`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ tenant: "main" }),
  });
  return (((await r.json()) as { result?: any }).result ?? {}) as { processed: number; succeeded: number; remaining: number };
}

export async function runTasks(base: string): Promise<void> {
  const call = http(base, "main");
  const admin = await token("admin", ["admin"]); // admin can create notes (+ drain)

  // write a note AND enqueue a notify task, atomically
  const ok = await call("createNoteAndNotify", { title: "hello", to: "ann@example.com" }, admin);
  assert(ok.body.ok, "tasks: createNoteAndNotify (write + enqueue) succeeds");

  // drive a drain (the DO also self-drains via an alarm; this makes the test
  // deterministic regardless of alarm timing — both paths mark the row done).
  await drain(base, admin);
  const inbox = await call("__notifyInbox", { to: "ann@example.com" }, admin);
  assert(inbox.body.result?.body === "New note: hello", "tasks: the notify task delivered off the write path");

  // atomicity: a mutation that throws AFTER enqueuing rolls BOTH back — the outbox row
  // is part of the same transaction, so no task is left behind.
  const failed = await call("createNoteAndNotify", { title: "ghost", to: "ghost@example.com", fail: true }, admin);
  assert(failed.status >= 400, "tasks: the forced-failure mutation is rejected");
  await drain(base, admin);
  const ghost = await call("__notifyInbox", { to: "ghost@example.com" }, admin);
  assert(ghost.body.result?.body == null, "tasks: a rolled-back mutation enqueues NO task (atomic outbox)");

  // drain is admin-gated
  const anon = await fetch(`${base}/admin/tasks/drain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant: "main" }),
  });
  assert(anon.status === 403, "tasks: /admin/tasks/drain is admin-only (403 without a token)");
}
