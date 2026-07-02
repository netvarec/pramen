// Unit test for routeQueue — pure function, no wrangler/server boot. Pins the queue-name
// → handler matching (env-prefixed remote names, longest-suffix precedence, single-handler
// fallback) that dispatchQueueBatch relies on.

import { describe, expect, test } from "bun:test";
import { routeQueue, type AppQueueMap, type QueueHandler } from "../packages/server/src/runtime/queue-consumer";

const h = (tag: string): QueueHandler => Object.assign(() => {}, { tag });
const tagOf = (fn: QueueHandler | null) => (fn as unknown as { tag: string } | null)?.tag ?? null;

describe("routeQueue", () => {
  test("exact match wins", () => {
    const q: AppQueueMap = { jobs: h("jobs"), "email-jobs": h("email-jobs") };
    expect(tagOf(routeQueue(q, "jobs"))).toBe("jobs");
    expect(tagOf(routeQueue(q, "email-jobs"))).toBe("email-jobs");
  });

  // M2 — the longest '-<key>' suffix must win regardless of insertion order, so an
  // env-prefixed 'prod-email-jobs' routes to 'email-jobs', not 'jobs'.
  test("M2: longest suffix wins for an env-prefixed name (order-independent)", () => {
    const q: AppQueueMap = { jobs: h("jobs"), "email-jobs": h("email-jobs") };
    expect(tagOf(routeQueue(q, "prod-email-jobs"))).toBe("email-jobs");
    expect(tagOf(routeQueue(q, "prod-jobs"))).toBe("jobs");
    // insertion order reversed → same result
    const q2: AppQueueMap = { "email-jobs": h("email-jobs"), jobs: h("jobs") };
    expect(tagOf(routeQueue(q2, "prod-email-jobs"))).toBe("email-jobs");
  });

  test("M2: no reverse match — a handler key ending in '-<queueName>' does NOT match", () => {
    // key 'email-jobs', queue 'jobs' — the old reverse arm (k.endsWith('-jobs')) would
    // have (mis)matched; now it must NOT (and with two handlers there's no fallback).
    const q: AppQueueMap = { "email-jobs": h("email-jobs"), other: h("other") };
    expect(routeQueue(q, "jobs")).toBeNull();
  });

  test("single-handler fallback still routes an unmatched name", () => {
    const q: AppQueueMap = { jobs: h("jobs") };
    expect(tagOf(routeQueue(q, "production-pramen-jobs"))).toBe("jobs"); // suffix match
    expect(tagOf(routeQueue(q, "totally-unrelated"))).toBe("jobs"); // lone-handler fallback
  });

  test("no match with multiple handlers → null", () => {
    const q: AppQueueMap = { jobs: h("jobs"), "email-jobs": h("email-jobs") };
    expect(routeQueue(q, "dead-letter")).toBeNull();
  });
});
