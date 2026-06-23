// Transactional outbox — the substrate-agnostic core of deferred side-effects
// ("tasks"), e.g. sending a notification email off the write path.
//
// A handler calls `ctx.tasks.enqueue({ kind, payload })`, which INSERTs a row into
// `_pramen_outbox` through the SAME Driver (and, for a mutation, the SAME transaction)
// as the data write — so the task and the data commit or roll back together (no
// dual-write window). A drainer later reads due rows and runs the app's task handler
// for that `kind`, with retry/backoff.
//
// Everything here is written against the `Driver`/`Dialect` seam, so it runs
// identically on the DO's in-process SQLite AND on D1 (the Worker path). What differs
// is only the WAKE-UP: the DO self-drains via an alarm; the D1/Worker path drains via
// a Cron Trigger or ctx.waitUntil calling drainOutbox() — same function, both paths.

import type { Driver } from "./driver";

export const OUTBOX_TABLE = "_pramen_outbox";

const MAX_ATTEMPTS = 5;
/** Exponential backoff (ms) before the next attempt of a failed task. */
function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 5 * 60_000); // 2s, 4s, 8s, … capped at 5min
}

/** Create the outbox table if absent. Idempotent — run on DO boot (and lazily on the
 * D1 path). Internal table (`_pramen_` prefix), never part of the user schema. */
export async function ensureOutbox(driver: Driver): Promise<void> {
  const t = driver.dialect.id(OUTBOX_TABLE);
  await driver.exec(
    `CREATE TABLE IF NOT EXISTS ${t} (` +
      `id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, ` +
      `status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, ` +
      `runAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, lastError TEXT)`,
    [],
  );
  // Drain queries filter on (status, runAt); index keeps it cheap as the table grows.
  await driver.exec(
    `CREATE INDEX IF NOT EXISTS _pramen_outbox_due ON ${OUTBOX_TABLE} (status, runAt)`,
    [],
  );
}

export interface EnqueueOpts {
  kind: string;
  payload?: unknown;
  /** Delay before the task becomes due (ms from now). Default 0 (drain ASAP). */
  delayMs?: number;
}

/** Insert one task row. Uses the driver directly, so inside a mutation it joins that
 * mutation's transaction (atomic with the data write). `now` is passed in (handlers
 * have no wall clock in some runtimes; the caller stamps it). */
export async function enqueueTask(driver: Driver, now: number, opts: EnqueueOpts): Promise<void> {
  if (!opts || typeof opts.kind !== "string" || opts.kind.length === 0) {
    throw new Error("ctx.tasks.enqueue: `kind` is required");
  }
  const d = driver.dialect;
  const ph = (i: number) => d.placeholder(i);
  const params = [
    crypto.randomUUID(),
    opts.kind,
    JSON.stringify(opts.payload ?? null),
    "pending",
    0,
    now + Math.max(0, Math.trunc(opts.delayMs ?? 0)),
    now,
  ].map((p) => d.encode(p));
  await driver.exec(
    `INSERT INTO ${d.id(OUTBOX_TABLE)} (id, kind, payload, status, attempts, runAt, createdAt) ` +
      `VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)})`,
    params,
  );
}

/** A task handler: runs the side effect for one `kind`. Throwing schedules a retry. */
export type TaskHandler = (payload: unknown) => void | Promise<void>;
export type TaskMap = Record<string, TaskHandler>;

export interface DrainResult {
  processed: number;
  succeeded: number;
  failed: number;
  /** Tasks still pending+due after this pass (a non-DO caller may loop or reschedule). */
  remaining: number;
}

/** Run every due task once (status='pending', runAt<=now), up to `limit`. On success
 * mark it done; on throw, bump attempts and back off, or mark failed past MAX_ATTEMPTS.
 *
 * Substrate-agnostic: the DO calls this from its alarm; the Worker/D1 path calls it
 * from a Cron Trigger / waitUntil. The DO is single-writer so a plain read-then-process
 * is race-free; on D1 a future claim step (UPDATE … SET status='processing' RETURNING)
 * would guard against concurrent Worker invocations. */
export async function drainOutbox(
  driver: Driver,
  tasks: TaskMap,
  now: number,
  limit = 50,
): Promise<DrainResult> {
  const d = driver.dialect;
  const due = await driver.exec(
    `SELECT id, kind, payload, attempts FROM ${d.id(OUTBOX_TABLE)} ` +
      `WHERE status = ${d.placeholder(1)} AND runAt <= ${d.placeholder(2)} ` +
      `ORDER BY createdAt LIMIT ${Math.max(1, Math.trunc(limit))}`,
    ["pending", now].map((p) => d.encode(p)),
  );

  let succeeded = 0;
  let failed = 0;
  for (const row of due) {
    const id = String(row.id);
    const kind = String(row.kind);
    const attempts = Number(row.attempts) + 1;
    const handler = tasks[kind];
    try {
      if (!handler) throw new Error(`no task handler registered for kind ${JSON.stringify(kind)}`);
      await handler(JSON.parse(String(row.payload)));
      await driver.exec(
        `UPDATE ${d.id(OUTBOX_TABLE)} SET status = ${d.placeholder(1)}, attempts = ${d.placeholder(2)} WHERE id = ${d.placeholder(3)}`,
        ["done", attempts, id].map((p) => d.encode(p)),
      );
      succeeded++;
    } catch (e) {
      const dead = attempts >= MAX_ATTEMPTS;
      const msg = e instanceof Error ? e.message : String(e);
      await driver.exec(
        `UPDATE ${d.id(OUTBOX_TABLE)} SET status = ${d.placeholder(1)}, attempts = ${d.placeholder(2)}, runAt = ${d.placeholder(3)}, lastError = ${d.placeholder(4)} WHERE id = ${d.placeholder(5)}`,
        [dead ? "failed" : "pending", attempts, now + backoffMs(attempts), msg.slice(0, 500), id].map((p) => d.encode(p)),
      );
      failed++;
    }
  }

  const rest = await driver.exec(
    `SELECT COUNT(*) AS n FROM ${d.id(OUTBOX_TABLE)} WHERE status = ${d.placeholder(1)} AND runAt <= ${d.placeholder(2)}`,
    ["pending", now].map((p) => d.encode(p)),
  );
  return { processed: due.length, succeeded, failed, remaining: Number(rest[0]?.n ?? 0) };
}
