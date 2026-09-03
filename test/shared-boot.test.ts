// SharedBoot — the D1 store's once-per-isolate boot, shared across invocations (GitHub #51).
//
// The failure it exists for: the request that STARTS the boot is canceled by its caller
// (a proxy ceiling on the legitimately slow first request after a deploy), the Workers
// runtime cancels that invocation's pending I/O, and a promise chained on canceled I/O
// never settles — so a bare memoized promise wedges every later request in the isolate,
// forever. These tests model that as a boot that never settles and never reports progress,
// and assert the memo heals itself instead of trusting the orphan for its lifetime.

import { describe, expect, test } from "bun:test";
import { SharedBoot, observeDriver } from "../packages/server/src/runtime/boot";
import type { Driver } from "../packages/server/src/runtime/driver";
import { sqliteDialect } from "../packages/server/src/runtime/driver";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STALE = 60;

describe("SharedBoot", () => {
  test("one boot serves every concurrent awaiter, and a finished boot is not re-run", async () => {
    const boot = new SharedBoot({ staleMs: STALE });
    let runs = 0;
    const run = async () => {
      runs++;
      await sleep(10);
    };
    await Promise.all([boot.ensure(run), boot.ensure(run), boot.ensure(run)]);
    await boot.ensure(run);
    expect(runs).toBe(1);
    expect(boot.isDone()).toBe(true);
  });

  test("a rejected boot rejects its awaiters, clears the memo, and the next call retries", async () => {
    const boot = new SharedBoot({ staleMs: STALE });
    let runs = 0;
    const failing = async () => {
      runs++;
      throw new Error("migration failed");
    };
    await expect(boot.ensure(failing)).rejects.toThrow("migration failed");
    expect(boot.isDone()).toBe(false);
    await boot.ensure(async () => {
      runs++;
    });
    expect(runs).toBe(2);
    expect(boot.isDone()).toBe(true);
  });

  test("a synchronous throw in the boot body is a rejection, not an escape", async () => {
    const boot = new SharedBoot({ staleMs: STALE });
    await expect(
      boot.ensure(() => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
  });

  test("the starter's keepAlive receives the boot promise; later awaiters' does not", async () => {
    const boot = new SharedBoot({ staleMs: STALE });
    const kept: Promise<unknown>[] = [];
    const first = boot.ensure(() => sleep(10), (p) => kept.push(p));
    const second = boot.ensure(() => sleep(10), (p) => kept.push(p));
    await Promise.all([first, second]);
    expect(kept.length).toBe(1);
    // It never rejects — waitUntil must not see a boot failure as its own error.
    await kept[0];
  });

  // The #51 shape, for an awaiter arriving AFTER the orphan has gone quiet.
  test("an orphaned boot (never settles, no progress) is replaced for a later arrival", async () => {
    const orphaned: number[] = [];
    const boot = new SharedBoot({ staleMs: STALE, onOrphaned: (idle) => orphaned.push(idle) });
    const wedged = new Promise<void>(() => {}); // canceled I/O: never settles
    // The starter's own await hangs (its caller will time out) — that is the isolate's
    // first request. Don't await it.
    void boot.ensure(() => wedged).catch(() => {});
    await sleep(STALE + 10);

    let ranFresh = false;
    await boot.ensure(async () => {
      ranFresh = true;
    });
    expect(ranFresh).toBe(true);
    expect(boot.isDone()).toBe(true);
    expect(orphaned.length).toBe(1);
    expect(orphaned[0]).toBeGreaterThanOrEqual(STALE);
  });

  // The #51 shape, for an awaiter that was ALREADY waiting when the boot went quiet.
  test("an awaiter already waiting on an orphaned boot heals in flight", async () => {
    const boot = new SharedBoot({ staleMs: STALE });
    const wedged = new Promise<void>(() => {});
    void boot.ensure(() => wedged).catch(() => {});
    await sleep(5);

    let ranFresh = false;
    const started = Date.now();
    await boot.ensure(async () => {
      ranFresh = true;
    });
    expect(ranFresh).toBe(true);
    // It waited out the staleness window rather than forever — and not much longer.
    expect(Date.now() - started).toBeGreaterThanOrEqual(STALE - 10);
    expect(Date.now() - started).toBeLessThan(STALE * 4);
  });

  test("a slow boot that keeps reporting progress is NOT replaced", async () => {
    const orphaned: number[] = [];
    const boot = new SharedBoot({ staleMs: STALE, onOrphaned: (idle) => orphaned.push(idle) });
    let runs = 0;
    const slowButAlive = async (progress: () => void) => {
      runs++;
      // Three times the staleness window, progressing well inside it.
      for (let i = 0; i < 6; i++) {
        await sleep(STALE / 2);
        progress();
      }
    };
    await Promise.all([boot.ensure(slowButAlive), sleep(STALE + 10).then(() => boot.ensure(slowButAlive))]);
    expect(runs).toBe(1);
    expect(orphaned.length).toBe(0);
  });

  test("a predecessor that finally fails does not discard its replacement", async () => {
    const boot = new SharedBoot({ staleMs: STALE });
    let failOld!: (e: Error) => void;
    const old = new Promise<void>((_, reject) => {
      failOld = reject;
    });
    void boot.ensure(() => old).catch(() => {});
    await sleep(STALE + 10);
    await boot.ensure(async () => {}); // replacement, done
    failOld(new Error("late failure"));
    await sleep(1);
    expect(boot.isDone()).toBe(true);
  });
});

describe("observeDriver", () => {
  const fake = (withBatch: boolean): Driver => {
    const d: Driver = {
      dialect: sqliteDialect,
      exec: async () => [],
      transaction: (fn) => fn(),
    };
    if (withBatch) d.batch = async () => {};
    return d;
  };

  test("every statement reports progress, before and after", async () => {
    let ticks = 0;
    const d = observeDriver(fake(true), () => ticks++);
    await d.exec("SELECT 1", []);
    await d.batch!([{ sql: "SELECT 1", params: [] }]);
    expect(ticks).toBe(4);
  });

  test("batch is forwarded only when the wrapped driver has it", () => {
    expect(observeDriver(fake(true), () => {}).batch).toBeDefined();
    expect(observeDriver(fake(false), () => {}).batch).toBeUndefined();
  });
});
