// Deferred tasks end-to-end on the DO store: a mutation enqueues a notification in the
// SAME transaction as a note write; the task runs off the write path (here it stashes
// to KV instead of emailing) and is drained via /admin/tasks/drain. Proves delivery
// and the outbox's atomicity (a rolled-back mutation enqueues nothing).

import { assert, http, token, sleep } from "../lib";

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

  // the DO ALARM auto-drains (no manual drain): enqueue, then poll the inbox until the
  // alarm fires and delivers. Proves the primary DO-path wake-up actually works.
  await call("createNoteAndNotify", { title: "auto", to: "auto@example.com" }, admin);
  let autoBody: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await call("__notifyInbox", { to: "auto@example.com" }, admin);
    if (r.body.result?.body) {
      autoBody = r.body.result.body as string;
      break;
    }
    await sleep(100);
  }
  assert(autoBody === "New note: auto", "tasks: the DO alarm auto-drains (no manual drain needed)");

  // admin can list outbox tasks (dead-letter visibility); anon is denied.
  const list = (await fetch(`${base}/admin/tasks/list?tenant=main`, {
    headers: { authorization: `Bearer ${admin}` },
  }).then((r) => r.json())) as { ok?: boolean; result?: unknown[] };
  assert(list.ok === true && Array.isArray(list.result), "tasks: /admin/tasks/list returns rows for admin");
  const anonList = await fetch(`${base}/admin/tasks/list?tenant=main`);
  assert(anonList.status === 403, "tasks: /admin/tasks/list is admin-only (403)");

  // declarative $triggers: createNote / updateNote(title) auto-enqueue a `note-changed`
  // task via the Db write path — no ctx.tasks.enqueue in the handler.
  const created = await call("createNote", { title: "trig", body: "b" }, admin);
  const noteId = created.body.result.id as number;
  await drain(base, admin);
  const onCreate = await call("__noteChangedInbox", { id: noteId }, admin);
  assert(onCreate.body.result?.body === "create:trig", "tasks: a declarative trigger fired on create (no explicit enqueue)");

  await call("updateNote", { id: noteId, title: "trig2" }, admin); // watched column → fires
  await drain(base, admin);
  const onUpdate = await call("__noteChangedInbox", { id: noteId }, admin);
  assert(onUpdate.body.result?.body === "update:trig2", "tasks: the trigger fired on a watched-column (title) update");
}
