// Transactional outbox — the substrate-agnostic core of deferred side-effects
// ("tasks"), e.g. sending a notification email off the write path.
//
// A handler calls `ctx.tasks.enqueue({ kind, payload })`, which INSERTs a row into
// `_pramen_outbox` through the SAME Driver (and, for a mutation, the SAME transaction)
// as the data write — so the task and the data commit or roll back together (no
// dual-write window). A drainer later runs the app's task handler for that `kind`,
// with retry/backoff and a dead-letter terminal state.
//
// Everything here is written against the `Driver`/`Dialect` seam, so it runs
// identically on the DO's in-process SQLite AND on D1 (the Worker path). What differs
// is only the WAKE-UP: the DO self-drains via an alarm scheduled at the next due time;
// the D1/Worker path drains via a Cron Trigger or POST /admin/tasks/drain — same
// drainOutbox(), both paths.
//
// Delivery is at-least-once. The drain CLAIMS a batch atomically (status
// pending→processing) so concurrent drainers (the D1/Cron path) never process the same
// row twice; a crashed drainer's claim is reclaimed after STALE_MS. Handlers get the
// task `id` as an idempotency key so they can dedupe across the rare retry.

import type { Driver } from "./driver";

export const OUTBOX_TABLE = "_pramen_outbox";

const MAX_ATTEMPTS = 5;
/** A claimed ('processing') row whose claim is older than this is presumed abandoned
 * (the drainer crashed) and is reclaimed. Must exceed the slowest task. */
const STALE_MS = 60_000;
/** Keep 'done' rows this long (a dedup window + debugging), then prune. */
const DONE_RETENTION_MS = 3_600_000;

/** Exponential backoff (ms) before the next attempt of a failed task. */
function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 5 * 60_000); // 2s, 4s, 8s, … capped at 5min
}

const enc = (driver: Driver, params: unknown[]): unknown[] => params.map((p) => driver.dialect.encode(p));

/** Create the outbox table if absent. Idempotent — run on DO boot (and lazily on the
 * D1 path). Internal table (`_pramen_` prefix), never part of the user schema. */
export async function ensureOutbox(driver: Driver): Promise<void> {
  const t = driver.dialect.id(OUTBOX_TABLE);
  await driver.exec(
    `CREATE TABLE IF NOT EXISTS ${t} (` +
      `id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, ` +
      `status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, ` +
      `runAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, claimedAt INTEGER, lastError TEXT)`,
    [],
  );
  // Drain queries filter on (status, runAt); index keeps claim/scan cheap as it grows.
  await driver.exec(`CREATE INDEX IF NOT EXISTS _pramen_outbox_due ON ${OUTBOX_TABLE} (status, runAt)`, []);
}

export interface EnqueueOpts {
  kind: string;
  payload?: unknown;
  /** Delay before the task becomes due (ms from now). Default 0 (drain ASAP). */
  delayMs?: number;
}

/** Insert one task row. Uses the driver directly, so inside a mutation it joins that
 * mutation's transaction (atomic with the data write). `now` is stamped by the caller. */
export async function enqueueTask(driver: Driver, now: number, opts: EnqueueOpts): Promise<void> {
  if (!opts || typeof opts.kind !== "string" || opts.kind.length === 0) {
    throw new Error("ctx.tasks.enqueue: `kind` is required");
  }
  const d = driver.dialect;
  const ph = (i: number) => d.placeholder(i);
  await driver.exec(
    `INSERT INTO ${d.id(OUTBOX_TABLE)} (id, kind, payload, status, attempts, runAt, createdAt) ` +
      `VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)})`,
    enc(driver, [
      crypto.randomUUID(),
      opts.kind,
      JSON.stringify(opts.payload ?? null),
      "pending",
      0,
      now + Math.max(0, Math.trunc(opts.delayMs ?? 0)),
      now,
    ]),
  );
}

/** Idempotency metadata handed to a task handler. `id` is stable across retries — a
 * handler can record it and skip a duplicate delivery (at-least-once). */
export interface TaskMeta {
  id: string;
  /** 1-based attempt number for this delivery. */
  attempts: number;
}

/** A task handler: runs the side effect for one `kind`. Throwing schedules a retry. */
export type TaskHandler = (payload: unknown, meta: TaskMeta) => void | Promise<void>;
export type TaskMap = Record<string, TaskHandler>;

export interface DrainResult {
  processed: number;
  succeeded: number;
  failed: number;
  /** Tasks still pending+due after this pass (a caller may loop to clear a backlog). */
  remaining: number;
  /** Epoch-ms of the earliest not-yet-run task (due or backed-off), or null if none —
   * the DO schedules its next alarm here so a backed-off retry can't stall. */
  nextRunAt: number | null;
}

/** Run every due task once (claimed batch, up to `limit`). On success mark it done; on
 * throw, bump attempts and back off, or dead-letter ('failed') past MAX_ATTEMPTS.
 *
 * Substrate-agnostic and concurrency-safe: the claim UPDATE (pending→processing) is
 * atomic, so two drainers (the D1/Cron path) get disjoint batches; a crashed drainer's
 * claim is reclaimed after STALE_MS. The DO path is single-writer so claims never
 * contend, but the same code runs there too. */
export async function drainOutbox(driver: Driver, tasks: TaskMap, now: number, limit = 50): Promise<DrainResult> {
  const d = driver.dialect;
  const ph = (i: number) => d.placeholder(i);

  // Prune long-since-delivered rows so the table stays bounded.
  await driver.exec(
    `DELETE FROM ${d.id(OUTBOX_TABLE)} WHERE status = ${ph(1)} AND createdAt < ${ph(2)}`,
    enc(driver, ["done", now - DONE_RETENTION_MS]),
  );

  // Atomically claim a due batch: fresh 'pending', plus 'processing' rows whose claim
  // is stale (the drainer crashed). RETURNING gives us exactly our claimed rows, so a
  // concurrent drainer (writes serialize) claims a disjoint set.
  const staleBefore = now - STALE_MS;
  const claimed = await driver.exec(
    `UPDATE ${d.id(OUTBOX_TABLE)} SET status = ${ph(1)}, claimedAt = ${ph(2)} WHERE id IN (` +
      `SELECT id FROM ${d.id(OUTBOX_TABLE)} ` +
      `WHERE (status = ${ph(3)} OR (status = ${ph(4)} AND claimedAt <= ${ph(5)})) AND runAt <= ${ph(6)} ` +
      `ORDER BY createdAt LIMIT ${Math.max(1, Math.trunc(limit))}) ` +
      `RETURNING id, kind, payload, attempts`,
    enc(driver, ["processing", now, "pending", "processing", staleBefore, now]),
  );

  let succeeded = 0;
  let failed = 0;
  for (const row of claimed) {
    const id = String(row.id);
    const kind = String(row.kind);
    const attempts = Number(row.attempts) + 1;
    const handler = tasks[kind];
    // Re-stamp claimedAt to WALL-CLOCK time immediately before running this row, so its
    // stale clock starts when its own processing starts — not when the whole batch was
    // claimed. Otherwise a batch (up to `limit` rows) processed SEQUENTIALLY whose total
    // time exceeds STALE_MS would leave the not-yet-run tail reclaimable by a concurrent
    // drainer under the batch-shared claimedAt, running it twice. We use Date.now() (not
    // the caller's fixed `now`) because that is the only clock that advances across the
    // loop; the atomic claim above still gives disjoint batches for concurrent drainers.
    await driver.exec(
      `UPDATE ${d.id(OUTBOX_TABLE)} SET claimedAt = ${ph(1)} WHERE id = ${ph(2)}`,
      enc(driver, [Date.now(), id]),
    );
    try {
      if (!handler) throw new Error(`no task handler registered for kind ${JSON.stringify(kind)}`);
      await handler(JSON.parse(String(row.payload)), { id, attempts });
      await driver.exec(
        `UPDATE ${d.id(OUTBOX_TABLE)} SET status = ${ph(1)}, attempts = ${ph(2)}, claimedAt = NULL WHERE id = ${ph(3)}`,
        enc(driver, ["done", attempts, id]),
      );
      succeeded++;
    } catch (e) {
      const dead = attempts >= MAX_ATTEMPTS;
      const msg = e instanceof Error ? e.message : String(e);
      await driver.exec(
        `UPDATE ${d.id(OUTBOX_TABLE)} SET status = ${ph(1)}, attempts = ${ph(2)}, runAt = ${ph(3)}, claimedAt = NULL, lastError = ${ph(4)} WHERE id = ${ph(5)}`,
        enc(driver, [dead ? "failed" : "pending", attempts, now + backoffMs(attempts), msg.slice(0, 500), id]),
      );
      failed++;
    }
  }

  // remaining = pending AND due now. nextRunAt = the earliest moment the DO must wake to
  // make progress, so it can re-arm its alarm exactly there. That is the min of:
  //   (a) MIN(runAt) over pending rows (a due-now or backed-off retry), and
  //   (b) MIN(claimedAt) + STALE_MS over 'processing' rows — a claim stranded by a
  //       crashed drainer becomes reclaimable at claimedAt + STALE_MS. Without folding
  //       this in, a mid-drain crash would leave a row 'processing' with no pending row
  //       to re-arm the alarm, and on a quiet tenant the task would stall forever (the
  //       alarm is the only DO-path drain trigger). Any processing rows here belong to a
  //       *different* (concurrent or crashed) drainer — our own batch is never left
  //       processing after this loop.
  const stats = await driver.exec(
    `SELECT ` +
      `(SELECT COUNT(*) FROM ${d.id(OUTBOX_TABLE)} WHERE status = ${ph(1)} AND runAt <= ${ph(2)}) AS due, ` +
      `(SELECT MIN(runAt) FROM ${d.id(OUTBOX_TABLE)} WHERE status = ${ph(3)}) AS nextPending, ` +
      `(SELECT MIN(claimedAt) FROM ${d.id(OUTBOX_TABLE)} WHERE status = ${ph(4)}) AS nextStale`,
    enc(driver, ["pending", now, "pending", "processing"]),
  );
  const pendingRaw = stats[0]?.nextPending;
  const staleRaw = stats[0]?.nextStale;
  const candidates: number[] = [];
  if (pendingRaw != null) candidates.push(Number(pendingRaw));
  if (staleRaw != null) candidates.push(Number(staleRaw) + STALE_MS);
  return {
    processed: claimed.length,
    succeeded,
    failed,
    remaining: Number(stats[0]?.due ?? 0),
    nextRunAt: candidates.length ? Math.min(...candidates) : null,
  };
}

export interface TaskRow {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  runAt: number;
  createdAt: number;
  lastError: string | null;
}

/** List outbox rows for admin visibility (e.g. inspect dead-lettered tasks). Newest
 * first; optionally filter by `status` (e.g. "failed"). Excludes the payload. */
export async function listTasks(driver: Driver, opts: { status?: string; limit?: number } = {}): Promise<TaskRow[]> {
  const d = driver.dialect;
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100) || 100, 1), 500);
  const where = opts.status ? `WHERE status = ${d.placeholder(1)} ` : "";
  const rows = await driver.exec(
    `SELECT id, kind, status, attempts, runAt, createdAt, lastError FROM ${d.id(OUTBOX_TABLE)} ` +
      `${where}ORDER BY createdAt DESC LIMIT ${limit}`,
    opts.status ? enc(driver, [opts.status]) : [],
  );
  return rows as unknown as TaskRow[];
}
