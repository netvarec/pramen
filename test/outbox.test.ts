// Unit test for the transactional outbox (deferred tasks) against real SQLite via the
// Driver seam — the SAME engine the DO and D1 both run, so this pins the substrate-
// agnostic core: enqueue → drain → retry/backoff → dead-letter, independent of where
// the wake-up comes from (DO alarm vs Worker Cron).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureOutbox, enqueueTask, drainOutbox, listTasks } from "../packages/server/src/runtime/outbox";
import { bunSqliteDriver } from "./sqlite-driver";

async function freshDriver() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await ensureOutbox(driver);
  return driver;
}

describe("outbox (substrate-agnostic deferred tasks)", () => {
  test("enqueue → drain runs the handler once and marks it done", async () => {
    const driver = await freshDriver();
    await enqueueTask(driver, 1000, { kind: "email", payload: { to: "a@x.com" } });

    const delivered: unknown[] = [];
    const r = await drainOutbox(driver, { email: (p) => void delivered.push(p) }, 1000);
    expect(r).toMatchObject({ processed: 1, succeeded: 1, failed: 0, remaining: 0 });
    expect(delivered).toEqual([{ to: "a@x.com" }]);

    // idempotent: a second drain finds nothing pending (the row is 'done')
    expect((await drainOutbox(driver, { email: () => {} }, 2000)).processed).toBe(0);
  });

  test("a delayed task isn't due until runAt", async () => {
    const driver = await freshDriver();
    await enqueueTask(driver, 1000, { kind: "k", delayMs: 5000 }); // due at 6000
    expect((await drainOutbox(driver, { k: () => {} }, 1000)).processed).toBe(0);
    expect((await drainOutbox(driver, { k: () => {} }, 6000)).processed).toBe(1);
  });

  test("a throwing handler retries with backoff, then dead-letters after MAX_ATTEMPTS", async () => {
    const driver = await freshDriver();
    await enqueueTask(driver, 0, { kind: "boom" });
    const tasks = {
      boom: () => {
        throw new Error("nope");
      },
    };

    let now = 0;
    let failures = 0;
    for (let i = 0; i < 8; i++) {
      const r = await drainOutbox(driver, tasks, now);
      if (r.processed === 0) break; // dead-lettered -> no longer pending
      failures += r.failed;
      now += 10 * 60_000; // jump past the (capped 5min) backoff so it's due again
    }
    expect(failures).toBe(5); // MAX_ATTEMPTS

    const row = (await driver.exec("SELECT status, attempts, lastError FROM _pramen_outbox", []))[0] as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(Number(row.attempts)).toBe(5);
    expect(String(row.lastError)).toContain("nope");
  });

  test("an unknown kind fails the task (no handler registered)", async () => {
    const driver = await freshDriver();
    await enqueueTask(driver, 0, { kind: "mystery" });
    const r = await drainOutbox(driver, {}, 0);
    expect(r).toMatchObject({ processed: 1, succeeded: 0, failed: 1 });
  });

  // #1 — the drain reports when the next task is due so the DO can reschedule its alarm
  // (a backed-off retry would otherwise stall, never re-armed).
  test("drain reports nextRunAt (incl. a backed-off retry's future due time)", async () => {
    const driver = await freshDriver();
    await enqueueTask(driver, 0, { kind: "boom" });
    const r = await drainOutbox(driver, { boom: () => { throw new Error("x"); } }, 1000);
    expect(r.failed).toBe(1);
    expect(r.remaining).toBe(0); // backed off → not due now
    expect(r.nextRunAt).not.toBeNull();
    expect(r.nextRunAt!).toBeGreaterThan(1000); // a future retry time
    const empty = await freshDriver();
    expect((await drainOutbox(empty, {}, 0)).nextRunAt).toBeNull();
  });

  // #4 — the handler gets a stable id (idempotency key) + 1-based attempt number.
  test("the handler receives a stable task id + attempt number across retries", async () => {
    const driver = await freshDriver();
    await enqueueTask(driver, 0, { kind: "k" });
    const seen: Array<{ id: string; attempts: number }> = [];
    let calls = 0;
    const tasks = {
      k: (_p: unknown, meta: { id: string; attempts: number }) => {
        seen.push(meta);
        if (calls++ === 0) throw new Error("retry me");
      },
    };
    await drainOutbox(driver, tasks, 0); // attempt 1 → fails, backs off
    await drainOutbox(driver, tasks, 10 * 60_000); // attempt 2 → succeeds
    expect(seen.map((m) => m.attempts)).toEqual([1, 2]);
    expect(seen[0].id).toBe(seen[1].id); // same row, stable id
  });

  // #3 — concurrency: a fresh claim ('processing') is not re-claimed; a stale one is.
  test("a fresh claim is skipped; a stale claim is reclaimed (crash recovery)", async () => {
    const driver = await freshDriver();
    await enqueueTask(driver, 0, { kind: "k" });
    // Simulate another drainer's in-flight claim: processing, claimedAt = 1000.
    await driver.exec("UPDATE _pramen_outbox SET status = 'processing', claimedAt = ?", [1000]);
    let ran = 0;
    const tasks = { k: () => void ran++ };
    // 30s after the claim → not stale (STALE_MS=60s) → left alone.
    expect((await drainOutbox(driver, tasks, 1000 + 30_000)).processed).toBe(0);
    expect(ran).toBe(0);
    // 61s after → the claim is stale → reclaimed and processed.
    expect((await drainOutbox(driver, tasks, 1000 + 61_000)).processed).toBe(1);
    expect(ran).toBe(1);
  });

  // #6 — visibility + pruning.
  test("listTasks surfaces dead-letters (no payload); done rows are pruned after retention", async () => {
    const driver = await freshDriver();
    // a task that dead-letters
    await enqueueTask(driver, 0, { kind: "boom", payload: { secret: 1 } });
    let now = 0;
    for (let i = 0; i < 8; i++) {
      const r = await drainOutbox(driver, { boom: () => { throw new Error("nope"); } }, now);
      if (r.processed === 0) break;
      now += 10 * 60_000;
    }
    const failed = await listTasks(driver, { status: "failed" });
    expect(failed.length).toBe(1);
    expect(failed[0]).toMatchObject({ kind: "boom", status: "failed", attempts: 5 });
    expect("payload" in failed[0]).toBe(false); // payload is never listed
    expect(String(failed[0].lastError)).toContain("nope");

    // a delivered row is pruned once it's older than the retention window
    const d2 = await freshDriver();
    await enqueueTask(d2, 0, { kind: "k" });
    await drainOutbox(d2, { k: () => {} }, 1000); // done (createdAt 0)
    expect((await listTasks(d2, {})).length).toBe(1); // still within retention
    await drainOutbox(d2, { k: () => {} }, 1000 + 3_600_001); // a drain past retention prunes it
    expect((await listTasks(d2, {})).length).toBe(0);
  });
});
