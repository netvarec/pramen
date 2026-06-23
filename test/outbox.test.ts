// Unit test for the transactional outbox (deferred tasks) against real SQLite via the
// Driver seam — the SAME engine the DO and D1 both run, so this pins the substrate-
// agnostic core: enqueue → drain → retry/backoff → dead-letter, independent of where
// the wake-up comes from (DO alarm vs Worker Cron).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureOutbox, enqueueTask, drainOutbox } from "../packages/server/src/runtime/outbox";
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
});
