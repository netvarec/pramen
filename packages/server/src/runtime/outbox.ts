// Transactional outbox: the substrate-agnostic core of deferred side-effects
// ("tasks"), e.g. sending a notification email off the write path.
//
// A handler calls `ctx.tasks.enqueue({ kind, payload })`, which INSERTs a row into
// `_pramen_outbox` through the SAME Driver (and, for a mutation, the SAME transaction)
// as the data write, so the task and the data commit or roll back together (no
// dual-write window). A drainer later runs the app's task handler for that `kind`,
// with retry/backoff and a dead-letter terminal state.
//
// Everything here is written against the `Driver`/`Dialect` seam, so it runs
// identically on the DO's in-process SQLite AND on D1 (the Worker path). What differs
// is only the WAKE-UP: the DO self-drains via an alarm scheduled at the next due time;
// the D1/Worker path drains via a Cron Trigger or POST /admin/tasks/drain, using the same
// drainOutbox(), both paths.
//
// Delivery is at-least-once. The drain CLAIMS a batch atomically (status
// pending→processing) so concurrent drainers (the D1/Cron path) never process the same
// row twice; a crashed drainer's claim is reclaimed after STALE_MS. Handlers get the
// task `id` as an idempotency key so they can dedupe across the rare retry.

import type { Driver } from "./driver";
import type { CellValue } from "../sdk/infer";

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

const enc = (driver: Driver, params: CellValue[]): CellValue[] => params.map((p) => driver.dialect.encode(p));

/** Create the outbox table if absent. Idempotent, run on DO boot (and lazily on the
 * D1 path). Internal table (`_pramen_` prefix), never part of the user schema. */
export async function ensureOutbox(driver: Driver): Promise<void> {
  const t = driver.dialect.id(OUTBOX_TABLE);
  await driver.exec(
    `CREATE TABLE IF NOT EXISTS ${t} (` +
      `id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, ` +
      `status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, ` +
      `runAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, claimedAt INTEGER, lastError TEXT, dedupKey TEXT)`,
    [],
  );
  // A table created before idempotency keys has no such column, and CREATE TABLE IF NOT EXISTS
  // leaves it as it was. This runs on every drain, so ask first instead of issuing an ALTER
  // that fails every time (and whose error wording differs by engine): a read of the column
  // fails only for an old table, and only once, because the ALTER then adds it.
  let hasKeyColumn = true;
  try {
    await driver.exec(`SELECT dedupKey FROM ${t} LIMIT 0`, []);
  } catch {
    hasKeyColumn = false;
  }
  if (!hasKeyColumn) await driver.exec(`ALTER TABLE ${t} ADD COLUMN dedupKey TEXT`, []);
  // Partial, so the unkeyed rows (NULL) never collide, and the conflict target below names it.
  await driver.exec(`CREATE UNIQUE INDEX IF NOT EXISTS _pramen_outbox_dedup ON ${t} (dedupKey) WHERE dedupKey IS NOT NULL`, []);
  // Drain queries filter on (status, runAt); index keeps claim/scan cheap as it grows.
  await driver.exec(`CREATE INDEX IF NOT EXISTS _pramen_outbox_due ON ${OUTBOX_TABLE} (status, runAt)`, []);
}

export interface EnqueueOpts {
  kind: string;
  payload?: unknown;
  /** Delay before the task becomes due (ms from now). Default 0 (drain ASAP). */
  delayMs?: number;
  /** Idempotency key: a second enqueue with the same key is a no-op, atomically, on every
   * substrate. Kept in its own column (`dedupKey`), not in the row id, so the handler's
   * `meta.id` stays a fresh id per delivery lifecycle. For a task that must exist exactly once but is
   * requested from places that cannot coordinate (two isolates on D1 with no single writer).
   *
   * A key is scoped by `kind` (the pair, not a joined string, is what must be unique) and stays taken until the row is pruned,
   * `DONE_RETENTION_MS` after it COMPLETED (not after it was created, so a long-delayed task
   * is covered too); make it specific to one intended run. A dead-lettered (`failed`) row does
   * NOT hold its key: enqueuing again replaces it. Must be a non-empty string. */
  key?: string;
}

/** Insert one task row. Uses the driver directly, so inside a mutation it joins that
 * mutation's transaction (atomic with the data write). `now` is stamped by the caller. */
export async function enqueueTask(driver: Driver, now: number, opts: EnqueueOpts): Promise<boolean> {
  if (!opts || typeof opts.kind !== "string" || opts.kind.length === 0) {
    throw new Error("ctx.tasks.enqueue: `kind` is required");
  }
  // One test for both uses of the key below. `key: ""` used to become an empty primary key
  // WITHOUT the conflict clause, so the second enqueue threw instead of being a no-op.
  if (opts.key !== undefined && (typeof opts.key !== "string" || opts.key.length === 0)) {
    throw new Error("ctx.tasks.enqueue: `key` must be a non-empty string");
  }
  const d = driver.dialect;
  const ph = (i: number) => d.placeholder(i);
  // Always a fresh id, so a task replacing a dead-lettered one is a NEW delivery for the
  // handler's idempotency record (`meta.id`), not a repeat of the failed one. The key lives in
  // `dedupKey`, scoped by kind: encoded as a JSON pair so no (kind, key) choice can collide
  // with another by containing the delimiter.
  const rowId = crypto.randomUUID();
  const dedupKey = opts.key === undefined ? null : JSON.stringify([opts.kind, opts.key]);
  // RETURNING answers whether a row was actually inserted: a keyed repeat inserts nothing, and
  // the caller must not wake the drainer for a task that is not new.
  const inserted = await driver.exec(
    `INSERT INTO ${d.id(OUTBOX_TABLE)} (id, kind, payload, status, attempts, runAt, createdAt, dedupKey) ` +
      `VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)}, ${ph(8)})` +
      // A live or done row holds its key (the repeat is a no-op). A DEAD-LETTERED one does not:
      // it will never run again, so keeping the key would silently drop the very retry that
      // a fixed deployment is asking for. `RETURNING` then reports the replacement as inserted.
      (opts.key !== undefined
        ? ` ON CONFLICT (dedupKey) WHERE dedupKey IS NOT NULL DO UPDATE SET id = excluded.id, kind = excluded.kind, payload = excluded.payload, status = 'pending', ` +
          `attempts = 0, runAt = excluded.runAt, createdAt = excluded.createdAt, claimedAt = NULL, lastError = NULL ` +
          `WHERE ${d.id(OUTBOX_TABLE)}.status = 'failed'`
        : "") +
      // Only the keyed path needs to know: an unkeyed insert always inserts, and asking a driver
      // for RETURNING rows it may not surface would make every unkeyed enqueue read as "nothing
      // inserted" and never wake the drainer.
      (opts.key !== undefined && d.returning ? ` RETURNING id` : ""),
    enc(driver, [
      rowId,
      opts.kind,
      JSON.stringify(opts.payload ?? null),
      "pending",
      0,
      now + Math.max(0, Math.trunc(opts.delayMs ?? 0)),
      now,
      dedupKey,
    ]),
  );
  if (opts.key === undefined) return true;
  // A dialect that surfaces RETURNING answers exactly; the table lookup below is only for one
  // that cannot, so a normal keyed repeat costs no extra query and is never misread.
  if (d.returning) return inserted.length > 0;
  // No RETURNING: the insert says nothing about whether it inserted, and reading that as "a
  // repeat" would never wake the drainer for a newly seeded task. So ask the table: the row is
  // ours if it now carries the fresh id this call minted (a repeat leaves the old id in place).
  const row = (await driver.exec(`SELECT id FROM ${d.id(OUTBOX_TABLE)} WHERE dedupKey = ${ph(1)}`, enc(driver, [dedupKey])))[0];
  return !!row && row.id === rowId;
}

/** Idempotency metadata handed to a task handler. `id` is stable across retries, so a
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
  /** Epoch-ms of the earliest not-yet-run task (due or backed-off), or null if none.
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
    `DELETE FROM ${d.id(OUTBOX_TABLE)} WHERE status = ${ph(1)} AND COALESCE(claimedAt, createdAt) < ${ph(2)}`,
    // The wall clock, because a done row's stamp is the wall clock (see below): one clock for
    // the stamp and the cutoff, so a key's lifetime does not depend on the `now` a caller passes.
    enc(driver, ["done", Date.now() - DONE_RETENTION_MS]),
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
    // stale clock starts when its own processing starts, not when the whole batch was
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
        `UPDATE ${d.id(OUTBOX_TABLE)} SET status = ${ph(1)}, attempts = ${ph(2)}, claimedAt = ${ph(3)} WHERE id = ${ph(4)}`,
        // claimedAt is meaningful only for 'processing'; on a done row it is the COMPLETION
        // time, which is what the retention prune (and so a key's lifetime) counts from.
        enc(driver, ["done", attempts, Date.now(), id]),
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
  //   (b) MIN(claimedAt) + STALE_MS over 'processing' rows: a claim stranded by a
  //       crashed drainer becomes reclaimable at claimedAt + STALE_MS. Without folding
  //       this in, a mid-drain crash would leave a row 'processing' with no pending row
  //       to re-arm the alarm, and on a quiet tenant the task would stall forever (the
  //       alarm is the only DO-path drain trigger). Any processing rows here belong to a
  //       *different* (concurrent or crashed) drainer; our own batch is never left
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
