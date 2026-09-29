// @pramen/analytics rollup, against a real system Db over bun:sqlite: the per-path fold, the
// late-event handling (dirty flag + recompute window), pruning's guards, and the chain's
// stopping condition. The rollup is arithmetic over stored rows, which is exactly where a
// plausible-looking wrong number is born, so it is tested on real rows rather than mocks.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema } from "../packages/server/src/sdk/schema";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";
import { analyticsSchema } from "../packages/analytics/src/schema";
import { ingestEvents, type AnalyticsDb } from "../packages/analytics/src/ingest";
import { flagUnrolledDays, pendingDays, previousDay, pruneRawEvents, rollupPending } from "../packages/analytics/src/rollup";
import { metricsForRange, topPages } from "../packages/analytics/src/queries";
import type { AnalyticsEvent } from "../packages/analytics/src/events";

const schema = defineSchema({ ...analyticsSchema });
const DAY = 86_400_000;
const dayAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const hasPendingRollup = async (db: AnalyticsDb) => (await pendingDays(db, previousDay(), 1)).length > 0;

async function harness() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const db = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema) as unknown as AnalyticsDb;
  return db;
}

let n = 0;
const ev = (day: string, path: string, over: Partial<AnalyticsEvent> = {}): AnalyticsEvent => ({
  kind: "pageview", origin: "beacon", viewId: `v${++n}`, ts: `${day}T12:00:00.000Z`, day, path, ...over,
});

describe("rollup", () => {
  // The table is unique on (day, path) but the groups are (path, pageId): the server sets a
  // page id and the beacon cannot, so one path is two groups. They must add.
  test("a path seen with and without a page id is summed, not overwritten", async () => {
    const db = await harness();
    const d = dayAgo(10);
    await ingestEvents(db, [ev(d, "/a", { pageId: "11111111-1111-4111-8111-111111111111", origin: "server" }), ev(d, "/a"), ev(d, "/a"), ev(d, "/b")]);
    await rollupPending(db);
    const rolled = await topPages(db, d, d);
    expect(rolled.find((p) => p.path === "/a")).toMatchObject({ pageviews: 3, pageId: "11111111-1111-4111-8111-111111111111" });
    expect(rolled.find((p) => p.path === "/b")?.pageviews).toBe(1);
  });

  test("an event that lands after its day was rolled up is counted", async () => {
    const db = await harness();
    const d = dayAgo(8);
    await ingestEvents(db, [ev(d, "/a"), ev(d, "/a")]);
    await rollupPending(db);
    expect((await metricsForRange(db, d, d)).pageviews).toBe(2);

    // Late: stamped d, delivered long after the day was folded, and outside the recompute window.
    await ingestEvents(db, [ev(d, "/a")]);
    // Reads are correct at once (a dirty day is computed from raw), before any rollup runs...
    expect((await metricsForRange(db, d, d)).pageviews).toBe(3);
    expect((await topPages(db, d, d)).find((p) => p.path === "/a")?.pageviews).toBe(3);
    // ...and the next rollup folds it in and clears the flag.
    expect(await hasPendingRollup(db)).toBe(true);
    await rollupPending(db);
    expect((await metricsForRange(db, d, d)).pageviews).toBe(3);
    expect(await hasPendingRollup(db)).toBe(false);
  });

  // The old scan bounded itself by the newest rolled day and so never saw D-5 here.
  test("a late day OLDER than the newest rolled day is still found", async () => {
    const db = await harness();
    await ingestEvents(db, [ev(dayAgo(9), "/x"), ev(dayAgo(5), "/x"), ev(dayAgo(4), "/x")]);
    await rollupPending(db);
    await ingestEvents(db, [ev(dayAgo(7), "/x")]); // a day that was empty when everything else rolled
    const { days } = await rollupPending(db);
    expect(days).toContain(dayAgo(7));
    expect((await metricsForRange(db, dayAgo(7), dayAgo(7))).pageviews).toBe(1);
  });

  test("pruning never deletes a dirty day's raw rows", async () => {
    const db = await harness();
    const d = dayAgo(20);
    await ingestEvents(db, [ev(d, "/a")]);
    await rollupPending(db);
    await ingestEvents(db, [ev(d, "/a")]); // dirty
    expect((await pruneRawEvents(db, { keepDays: 5 })).deletedDays).toEqual([]);
    await rollupPending(db);
    expect((await pruneRawEvents(db, { keepDays: 5 })).deletedDays).toEqual([d]);
    // After pruning, the aggregate still answers.
    expect((await metricsForRange(db, d, d)).pageviews).toBe(2);
  });

  test("pruning stays clear of the recompute window whatever keepDays says", async () => {
    const db = await harness();
    const d = dayAgo(2);
    await ingestEvents(db, [ev(d, "/a")]);
    await rollupPending(db);
    expect((await pruneRawEvents(db, { keepDays: 1 })).deletedDays).toEqual([]);
  });

  // A day is pruned: its aggregate is all that is left. One straggler must not replace it.
  test("an event for an already-pruned day is dropped, not allowed to overwrite the history", async () => {
    const db = await harness();
    const d = dayAgo(20);
    await ingestEvents(db, [ev(d, "/a"), ev(d, "/a"), ev(d, "/a")]);
    await rollupPending(db);
    await pruneRawEvents(db, { keepDays: 5 });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await ingestEvents(db, [ev(d, "/a")])).toBe(0);
    } finally {
      console.warn = warn;
    }
    expect((await metricsForRange(db, d, d)).pageviews).toBe(3);
    expect(await hasPendingRollup(db)).toBe(false);
  });

  // D1 has no single writer: an event can flag the day between the rollup's read and its write.
  test("a flag set while the rollup is writing is not wiped by its stale numbers", async () => {
    const db = await harness();
    const d = dayAgo(8);
    await ingestEvents(db, [ev(d, "/a")]);
    await rollupPending(db);
    await ingestEvents(db, [ev(d, "/a")]); // dirty, token T1

    let injected = false;
    const racing = Object.create(db) as AnalyticsDb;
    racing.exec = (async (sql: string, ...params: never[]) => {
      // Just before the rollup writes day d, another writer lands a late event (a new token).
      if (!injected && /INSERT INTO "analytics_daily"/.test(sql)) {
        injected = true;
        await ingestEvents(db, [ev(d, "/a")]);
      }
      return db.exec(sql, ...params);
    }) as AnalyticsDb["exec"];
    await rollupPending(racing);

    // The rollup's numbers were computed before the third event, so the day must STILL be
    // flagged: reads compute from raw (3), and the next rollup folds it in.
    expect(await hasPendingRollup(db)).toBe(true);
    expect((await metricsForRange(db, d, d)).pageviews).toBe(3);
    await rollupPending(db);
    expect(await hasPendingRollup(db)).toBe(false);
    expect((await metricsForRange(db, d, d)).pageviews).toBe(3);
  });

  test("a long run of rolled days prunes and reads without exceeding a bound-parameter list", async () => {
    const db = await harness();
    const events: AnalyticsEvent[] = [];
    for (let i = 60; i < 460; i++) events.push(ev(dayAgo(i), "/a"));
    await ingestEvents(db, events);
    for (let i = 0; i < 40; i++) await rollupPending(db);
    const pruned = await pruneRawEvents(db, { keepDays: 30 });
    expect(pruned.deletedDays.length).toBe(400);
    expect((await metricsForRange(db, dayAgo(459), dayAgo(60))).pageviews).toBe(400);
  });

  // A store upgraded from before flagging: an old day has raw rows and no aggregate row while a
  // newer one is rolled. It is below the tail, so nothing else would ever see it.
  test("an unrolled day left below the newest rolled one by an older version is flagged and rolled", async () => {
    const db = await harness();
    await ingestEvents(db, [ev(dayAgo(9), "/x"), ev(dayAgo(5), "/x")]);
    await rollupPending(db);
    await db.exec(`DELETE FROM "analytics_daily" WHERE "day" = ?`, dayAgo(9)); // as if it were never rolled
    expect(await hasPendingRollup(db)).toBe(false);
    expect(await flagUnrolledDays(db)).toBe(1);
    expect(await flagUnrolledDays(db)).toBe(0); // idempotent
    const { days } = await rollupPending(db);
    expect(days).toEqual([dayAgo(9)]);
    expect((await metricsForRange(db, dayAgo(9), dayAgo(9))).pageviews).toBe(1);
  });

  test("nothing pending once traffic has stopped and its window has passed", async () => {
    const db = await harness();
    expect(await hasPendingRollup(db)).toBe(false); // an empty store never wakes the chain
    await ingestEvents(db, [ev(dayAgo(30), "/a")]);
    await rollupPending(db);
    expect(await hasPendingRollup(db)).toBe(false);
  });
});
