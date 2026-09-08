// @pramen/analytics — the pure half of the collector: path normalization, device and
// source classification, bot filtering, and the beacon-value clamps.
//
// These are unit tests and not part of the e2e suite because each of them is a
// CLASSIFICATION decision, and a classification is exactly the kind of thing that is easy
// to get subtly wrong and impossible to notice through a dashboard. A wrong bucket does not
// throw; it produces a plausible number.

import { describe, expect, test } from "bun:test";
import {
  clampMetric,
  dayOf,
  deriveDevice,
  deriveSource,
  isBot,
  normalizePath,
} from "../packages/analytics/src/events";
import { daysInRange } from "../packages/analytics/src/queries";
import { sessionId } from "../packages/analytics/src/collect";
import { INGEST_ROLE } from "../packages/analytics/src/ingest";
import { isSystemRole } from "../packages/server/src/auth";

describe("normalizePath", () => {
  // A path is a GROUPING KEY. Every variant that is not folded here becomes its own row in
  // Top Pages, so one page arrives as three.
  test("query strings and fragments are dropped", () => {
    expect(normalizePath("/about?utm_source=x&y=1")).toBe("/about");
    expect(normalizePath("/about#team")).toBe("/about");
    expect(normalizePath("/about?a=1#team")).toBe("/about");
  });

  test("a trailing slash is folded, but the root is preserved", () => {
    expect(normalizePath("/about/")).toBe("/about");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });

  // Deliberately NOT lowercased: a server may genuinely serve /About and /about as
  // different pages, and folding them would merge two pages' numbers into one.
  test("case is preserved", () => {
    expect(normalizePath("/About")).toBe("/About");
  });

  test("length is capped", () => {
    expect(normalizePath(`/${"a".repeat(2000)}`).length).toBe(512);
  });
});

describe("deriveDevice", () => {
  // Order matters: every tablet UA also says Android or Mobile, so a naive mobile-first
  // test classifies every tablet as a phone.
  test("a tablet is not a phone", () => {
    expect(deriveDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/605.1")).toBe("tablet");
    expect(deriveDevice("Mozilla/5.0 (Linux; Android 13; SM-X200) Chrome/120 Safari/537")).toBe("tablet");
  });

  test("a phone is a phone", () => {
    expect(deriveDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1")).toBe("mobile");
    expect(deriveDevice("Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile Safari/537")).toBe("mobile");
  });

  test("anything unrecognized is desktop, not a third bucket", () => {
    expect(deriveDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605")).toBe("desktop");
    expect(deriveDevice("")).toBe("desktop");
    expect(deriveDevice(null)).toBe("desktop");
  });
});

describe("isBot", () => {
  test("common crawlers are filtered", () => {
    expect(isBot("Googlebot/2.1 (+http://www.google.com/bot.html)")).toBe(true);
    expect(isBot("curl/8.4.0")).toBe(true);
    expect(isBot("Mozilla/5.0 HeadlessChrome/120")).toBe(true);
  });

  // A request with no User-Agent at all is a script. This matters more than it looks: the
  // server-side collector sees crawler traffic that the beacon never can, so without one
  // filter shared by both, the two sources disagree by however well-indexed the site is.
  test("no User-Agent is treated as automated", () => {
    expect(isBot(null)).toBe(true);
    expect(isBot("")).toBe(true);
  });

  test("a real browser is not", () => {
    expect(isBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36")).toBe(false);
  });
});

describe("deriveSource", () => {
  test("no referrer is direct, and so is an unparseable one", () => {
    expect(deriveSource(null)).toBe("direct");
    expect(deriveSource("")).toBe("direct");
    expect(deriveSource("not a url")).toBe("direct");
  });

  // Without `selfHost` every internal click counts as a referral from the site itself,
  // which on any content site is the largest "source" in the report.
  test("internal navigation is not a referral", () => {
    expect(deriveSource("https://example.com/other", "example.com")).toBe("internal");
    expect(deriveSource("https://www.example.com/other", "example.com")).toBe("internal");
    expect(deriveSource("https://blog.example.com/x", "example.com")).toBe("internal");
  });

  test("search and social are bucketed, everything else keeps its host", () => {
    expect(deriveSource("https://www.google.com/search?q=x", "example.com")).toBe("search");
    expect(deriveSource("https://search.seznam.cz/?q=x", "example.com")).toBe("search");
    expect(deriveSource("https://www.facebook.com/", "example.com")).toBe("social");
    expect(deriveSource("https://news.ycombinator.com/item?id=1", "example.com")).toBe("news.ycombinator.com");
  });

  // A referrer host that merely CONTAINS a search engine's name is not that engine —
  // `notgoogle.com` must not be bucketed as search.
  test("a lookalike host is not a search engine", () => {
    expect(deriveSource("https://notgoogle.com/x", "example.com")).toBe("notgoogle.com");
  });
});

describe("clampMetric", () => {
  // The beacon posts to a public endpoint. These values are not merely untrusted, they are
  // untrusted numbers that feed an AVERAGE — a single absurd one moves a headline metric
  // without erroring anywhere.
  test("out-of-range and non-numeric values are dropped or clamped", () => {
    expect(clampMetric(50, 100)).toBe(50);
    expect(clampMetric(1e9, 100)).toBe(100);
    expect(clampMetric(-1, 100)).toBe(null);
    expect(clampMetric("50", 100)).toBe(null);
    expect(clampMetric(Number.NaN, 100)).toBe(null);
    expect(clampMetric(Number.POSITIVE_INFINITY, 100)).toBe(null);
    expect(clampMetric(undefined, 100)).toBe(null);
  });

  test("fractions are rounded, not truncated toward zero", () => {
    expect(clampMetric(49.6, 100)).toBe(50);
  });
});

describe("sessionId", () => {
  // The whole privacy position rests on this: no salt, no session. An unsalted digest of
  // (IP, User-Agent) is reversible by enumeration — it would look anonymous and not be.
  test("without a salt there is no session id at all", async () => {
    expect(await sessionId(null, "1.2.3.4", "UA", "2026-09-08")).toBe(null);
    expect(await sessionId("", "1.2.3.4", "UA", "2026-09-08")).toBe(null);
  });

  test("the same visitor on the same day is one session", async () => {
    const a = await sessionId("s", "1.2.3.4", "UA", "2026-09-08");
    const b = await sessionId("s", "1.2.3.4", "UA", "2026-09-08");
    expect(a).toBe(b as string);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  // Rotating on the day is what stops the value being a durable visitor identifier.
  test("the same visitor tomorrow is a different session", async () => {
    const a = await sessionId("s", "1.2.3.4", "UA", "2026-09-08");
    const b = await sessionId("s", "1.2.3.4", "UA", "2026-09-09");
    expect(a).not.toBe(b as string);
  });

  test("a different salt yields a different id for the same visitor", async () => {
    const a = await sessionId("s1", "1.2.3.4", "UA", "2026-09-08");
    const b = await sessionId("s2", "1.2.3.4", "UA", "2026-09-08");
    expect(a).not.toBe(b as string);
  });
});

describe("day helpers", () => {
  test("dayOf takes the UTC date off an ISO instant", () => {
    expect(dayOf("2026-09-08T23:59:59.999Z")).toBe("2026-09-08");
  });

  test("daysInRange is inclusive at both ends and ordered", () => {
    expect(daysInRange("2026-09-06", "2026-09-08")).toEqual(["2026-09-06", "2026-09-07", "2026-09-08"]);
    expect(daysInRange("2026-09-08", "2026-09-08")).toEqual(["2026-09-08"]);
  });

  test("an inverted range is empty rather than infinite", () => {
    expect(daysInRange("2026-09-08", "2026-09-06")).toEqual([]);
  });

  // The cap is what stops a mistyped range from asking for a million days of reads.
  test("the range is capped", () => {
    expect(daysInRange("2000-01-01", "2026-01-01").length).toBe(400);
  });

  test("it crosses a month and a leap day correctly", () => {
    expect(daysInRange("2028-02-28", "2028-03-01")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  });
});

describe("the ingest gate", () => {
  // The collector's role is only a gate because `toIdentity` strips `__`-prefixed roles from
  // every verified token — otherwise an IdP group of the same name would satisfy it, and the
  // handler behind it writes rows with the ACL bypassed. Pinned here so a future rename
  // cannot quietly drop the prefix and take the guarantee with it.
  test("INGEST_ROLE is a SYSTEM role, so no verified token can present it", () => {
    expect(isSystemRole(INGEST_ROLE)).toBe(true);
  });
});
