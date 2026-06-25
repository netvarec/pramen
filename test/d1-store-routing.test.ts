// Store-routing decision for the Worker. Regression guard for: PRAMEN_STORE=d1 must NOT
// route /live to the D1 path (live queries are DO-only) — before the fix, enabling the
// D1 default made every live subscription 400 instead of falling through to the DO.

import { describe, expect, test } from "bun:test";
import { useD1Store } from "../packages/server/src/worker";

describe("useD1Store — D1 vs DO routing", () => {
  test("live queries ALWAYS route to the DO, even under PRAMEN_STORE=d1 (regression)", () => {
    expect(useD1Store({ storeHeader: null, isLive: true, defaultStore: "d1" })).toBe(false);
    expect(useD1Store({ storeHeader: "d1", isLive: true, defaultStore: undefined })).toBe(false);
  });

  test("an explicit x-pramen-store header wins over the default", () => {
    expect(useD1Store({ storeHeader: "d1", isLive: false, defaultStore: undefined })).toBe(true);
    expect(useD1Store({ storeHeader: "do", isLive: false, defaultStore: "d1" })).toBe(false); // header forces DO
  });

  test("PRAMEN_STORE=d1 is the default only when no header is sent", () => {
    expect(useD1Store({ storeHeader: null, isLive: false, defaultStore: "d1" })).toBe(true);
    expect(useD1Store({ storeHeader: null, isLive: false, defaultStore: undefined })).toBe(false); // default DO
  });
});
