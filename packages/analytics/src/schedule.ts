// Keeping the rollup running without anyone wiring a cron.
//
// The rollup is a task that re-enqueues ITSELF for the next 00:10 UTC. That reuses the
// machinery every pramen deployment already has: the DO drains its outbox from an alarm, and
// the D1 store from the Cron Trigger the core already asks for to drain delayed tasks. So
// there is nothing analytics-specific to configure, where a dedicated Cron Trigger would be
// one more thing to forget.
//
// The chain has to START somewhere. It is seeded lazily, by the first ingest on a store that
// has no pending rollup (`ensureRollupScheduled`): an installation with no traffic has
// nothing to roll up, and one with traffic starts the chain by receiving it.

import type { HandlerContext } from "@pramen/server";
import { adb } from "./db";
import { flagUnrolledDays, LATE_EVENT_DAYS, pendingDays, previousDay, pruneRawEvents, rollupPending } from "./rollup";

/** Days folded per pass, and passes per run. */
const ROLLUP_BATCH_DAYS = 14;
const MAX_PASSES_PER_RUN = 3;

export const ROLLUP_TASK = "analytics.rollup";

/** UTC minute-of-day the rollup is due: shortly after midnight, so the day it folds is over
 * and a late queue message for it has had time to land. */
const ROLLUP_AT_MINUTE = 10;

/** The next 00:10 UTC strictly after `now`. */
export function nextRollupAt(now = new Date()): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, ROLLUP_AT_MINUTE));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Enqueue the next rollup unless it is already queued.
 *
 * The idempotency lives in the OUTBOX, not in a read-then-write here: the key names the
 * target instant, and `enqueue` with a key is an atomic no-op on a repeat. A check followed by
 * an insert was not atomic on D1 (no single writer), and two isolates passing it together
 * queued the same run twice, which is not just wasted work but a second self-perpetuating
 * chain. */
export async function scheduleRollup(ctx: HandlerContext, opts: { after?: Date; now?: Date } = {}): Promise<void> {
  // `after`: the run is the first due instant later than this. `now`: what the delay is
  // measured from. Separate because a run that fires early passes its own due instant as
  // `after`, and the delay must still count from the real clock.
  const after = opts.after ?? new Date();
  const now = opts.now ?? new Date();
  const at = nextRollupAt(after);
  const iso = at.toISOString();
  await ctx.tasks.enqueue({ kind: ROLLUP_TASK, payload: { at: iso }, delayMs: Math.max(0, at.getTime() - now.getTime()), key: iso });
}

/** Per-isolate memo so the steady state costs nothing: once this isolate has confirmed a
 * rollup is queued for a store, ingest stops asking about it.
 *
 * One entry per tenant and store, replaced (never added to) when the target day moves on, so
 * it is bounded by the number of tenants. It also EXPIRES, and quickly, because the confirmation
 * is recorded inside the ingest mutation before it commits: if that mutation rolls back, the
 * task was never stored, and the entry would suppress the retry. Thirty seconds bounds the
 * miss while still sparing the steady state a call per ingest. */
const MEMO_TTL_MS = 30_000;
const confirmed = new Map<string, { target: string; until: number }>();

/** For tests: the memo is module state and would otherwise leak between them. */
export function resetRollupMemo(): void {
  confirmed.clear();
}

/** Called by ingest. Cheap after the first call per store per few minutes. */
export async function ensureRollupScheduled(ctx: HandlerContext): Promise<void> {
  const key = `${ctx.store}|${ctx.tenant}`;
  const target = nextRollupAt().toISOString();
  const seen = confirmed.get(key);
  if (seen && seen.target === target && seen.until > Date.now()) return;
  try {
    await scheduleRollup(ctx);
    confirmed.set(key, { target, until: Date.now() + MEMO_TTL_MS });
  } catch (e) {
    // Never fail an ingest over housekeeping. Not memoized, so the next batch retries.
    console.warn("@pramen/analytics: could not schedule the daily rollup", e);
  }
}

export interface ScheduledRollupOpts {
  /** Delete raw events older than this many days once their day is rolled up. Omitted or
   * null: never prune. Deleting raw rows is irreversible and closes off new breakdowns, so
   * it is something a deployment chooses, not something an upgrade starts doing. */
  keepDays?: number | null;
}

/** Refuse a `keepDays` that would do the wrong thing rather than fail later: `NaN` throws in
 * the prune every night, and a negative number puts the cutoff in the FUTURE, deleting raw
 * events for every rolled-up day including yesterday's. Called when the tasks are built, so
 * a bad config from `Number(env.KEEP_DAYS)` fails at boot, not at 00:10. */
export function assertKeepDays(keepDays: number | null | undefined): void {
  if (keepDays === undefined || keepDays === null) return;
  if (typeof keepDays !== "number" || !Number.isFinite(keepDays) || keepDays <= LATE_EVENT_DAYS) {
    throw new Error(`@pramen/analytics: keepDays must be a finite number of days > ${LATE_EVENT_DAYS} (got ${String(keepDays)}): the most recent ${LATE_EVENT_DAYS} days are recomputed from raw events to absorb late ones, so they cannot be pruned. Omit it to keep raw events forever.`);
  }
}

/** The task itself: fold finished days, optionally drop the raw rows they made redundant,
 * and queue the next run.
 *
 * The next run is queued FIRST: if the rollup throws, the outbox retries this task, and if
 * it exhausts its attempts the chain would end here. It is computed from the LATER of now
 * and this run's own due instant, because a drain that fires a few ms early would otherwise
 * compute the same target as the row it is running, whose key is already taken, and
 * never queue tomorrow. */
export async function runScheduledRollup(ctx: HandlerContext, payload?: unknown, opts: ScheduledRollupOpts = {}): Promise<void> {
  const dueAt = Date.parse((payload as { at?: string } | null | undefined)?.at ?? "");
  const base = new Date(Math.max(Date.now(), Number.isFinite(dueAt) ? dueAt : 0));
  const db = adb(ctx);
  // The chain stops itself once traffic has: with nothing to roll up there is no reason for
  // every idle tenant to wake at 00:10 forever. The first ingest after that seeds it again.
  // Once per store, ever: days an OLDER version left unrolled below the newest rolled one.
  // Idempotent, so the marker being lost (or two isolates racing) only repeats a scan.
  const marker = `analytics:unrolled-backfill:${ctx.store}:${ctx.tenant}`;
  if (!(await ctx.kv.get(marker))) {
    await flagUnrolledDays(db);
    await ctx.kv.put(marker, "1");
  }
  // Asked once: the same set feeds the first pass, so the scan is not paid for twice.
  const first = await pendingDays(db, previousDay(), ROLLUP_BATCH_DAYS);
  if (first.length > 0) await scheduleRollup(ctx, { after: base });

  // A few passes per run, not as many as it takes. The outbox reclaims a claim after 60 s and
  // stamps it once, before the handler starts, so a long catch-up would be run a second time
  // by another drainer. What is left is handed to a follow-up task, which is a fresh claim.
  const done = new Set<string>();
  let more = false;
  for (let i = 0; i < MAX_PASSES_PER_RUN; i++) {
    const { days } = await rollupPending(db, i === 0 ? { days: first, maxDays: ROLLUP_BATCH_DAYS } : { maxDays: ROLLUP_BATCH_DAYS });
    const fresh = days.filter((d) => !done.has(d));
    for (const d of days) done.add(d);
    more = days.length === ROLLUP_BATCH_DAYS && fresh.length > 0;
    if (!more) break;
  }
  if (more) {
    const at = new Date().toISOString();
    await ctx.tasks.enqueue({ kind: ROLLUP_TASK, payload: { at }, key: `catchup:${at}` });
  }
  if (typeof opts.keepDays === "number") await pruneRawEvents(db, { keepDays: opts.keepDays });
}
