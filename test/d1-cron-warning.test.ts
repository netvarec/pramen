// The D1 store has no Durable Object alarm, so a DELAYED task — a scheduled publish, a
// retry backoff — runs only when a Cron trigger calls `createPramen().scheduled`. Forgetting
// that is silent: the row never goes live and nothing says why. The Worker notices the
// situation and says so once.

import { describe, expect, test } from "bun:test";
import { shouldWarnMissingCron } from "../packages/server/src/worker";

const now = 1_700_000_000_000;

describe("missing-Cron detection on the D1 store", () => {
  test("a task queued for the FUTURE with no cron seen is the case worth warning about", () => {
    expect(shouldWarnMissingCron({ cronSeen: false, warned: false, nextRunAt: now + 60_000, now })).toBe(true);
  });

  // A due-now task is drained by the request tail itself, so nothing depends on the cron.
  test("a task already due needs no cron — the request tail drains it", () => {
    expect(shouldWarnMissingCron({ cronSeen: false, warned: false, nextRunAt: now, now })).toBe(false);
    expect(shouldWarnMissingCron({ cronSeen: false, warned: false, nextRunAt: now - 1, now })).toBe(false);
  });

  test("an empty outbox says nothing", () => {
    expect(shouldWarnMissingCron({ cronSeen: false, warned: false, nextRunAt: null, now })).toBe(false);
  });

  // Once a Cron drain has actually happened, the question is settled — it exists.
  test("a cron that has fired silences it permanently", () => {
    expect(shouldWarnMissingCron({ cronSeen: true, warned: false, nextRunAt: now + 60_000, now })).toBe(false);
  });

  // A warning per request would bury the logs of exactly the deployment that needs reading.
  test("it warns at most once", () => {
    expect(shouldWarnMissingCron({ cronSeen: false, warned: true, nextRunAt: now + 60_000, now })).toBe(false);
  });
});
