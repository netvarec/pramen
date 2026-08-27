// @pramen/cms-editor — the deployment wordmark (`window.PRAMEN_CMS_EDITOR.brand`).
//
// The editor ships as a package an agency installs for its CLIENT, so the wordmark in the
// topbar / Setup screen / browser tab has to be theirs, not the framework's. These pin the
// resolution rules — most importantly that configuring nothing looks exactly as it did
// before the seam existed, and that a malformed config can never take the editor down.

import { describe, expect, test } from "bun:test";
import { DEFAULT_BRAND_NAME, DEFAULT_BRAND_SUFFIX, readBrandConfig, resolveBrand, type BrandHost } from "../packages/cms-editor/src/brand";

describe("cms-editor brand", () => {
  test("unconfigured reproduces the previously hardcoded wordmark", () => {
    expect(resolveBrand()).toEqual({ name: "pramen", suffix: "cms", title: "pramen · cms", spoken: "pramen cms" });
    expect(resolveBrand({}).title).toBe(`${DEFAULT_BRAND_NAME} · ${DEFAULT_BRAND_SUFFIX}`);
  });

  test("a host name replaces the wordmark and flows into every derived string", () => {
    expect(resolveBrand({ name: "Acme" })).toEqual({ name: "Acme", suffix: "cms", title: "Acme · cms", spoken: "Acme cms" });
  });

  // ABSENT vs. null is the distinction that matters: renaming the product keeps the "· cms"
  // half, `null` is the explicit "just our name".
  test("`suffix: null` drops the second half; absent keeps the default", () => {
    expect(resolveBrand({ name: "Acme", suffix: null })).toEqual({ name: "Acme", suffix: null, title: "Acme", spoken: "Acme" });
    expect(resolveBrand({ name: "Acme", suffix: "" }).suffix).toBeNull();
    // An explicit `undefined` is ABSENT, not "drop it" — the shape `{...defaults, suffix: cfg.suffix}` produces.
    expect(resolveBrand({ name: "Acme", suffix: undefined }).suffix).toBe(DEFAULT_BRAND_SUFFIX);
  });

  // THE one that matters for uptime. /config.js is hand-edited and untyped, `BRAND` resolves
  // at module load in the entry bundle's import graph, and there is no error boundary above
  // it — so a throw here is a blank white page, not a degraded wordmark.
  test("a malformed value can never throw — every other config field fails safe too", () => {
    const junk: unknown[] = [false, 0, 123, [], ["Acme"], {}, null, () => "x"];
    for (const v of junk) {
      expect(() => resolveBrand({ suffix: v as never })).not.toThrow();
      expect(() => resolveBrand({ name: v as never })).not.toThrow();
      expect(() => resolveBrand(v as never)).not.toThrow();
    }
    // `suffix: false` — the plausible slip beside `hidePages: true` — reads as "drop it".
    expect(resolveBrand({ name: "Acme", suffix: false as never }).title).toBe("Acme");
    // A non-object `brand` (the `brand: "Acme"` shorthand) falls back rather than crashing.
    expect(resolveBrand("Acme" as never).name).toBe(DEFAULT_BRAND_NAME);
  });

  test("a blank name falls back instead of rendering nothing", () => {
    for (const name of ["", "   "]) expect(resolveBrand({ name }).name).toBe(DEFAULT_BRAND_NAME);
  });

  test("surrounding whitespace is trimmed, not rendered", () => {
    expect(resolveBrand({ name: "  Acme  ", suffix: "  cms  " }).title).toBe("Acme · cms");
  });

  // The accessible name is built from `spoken`, not `title`: a screen reader announces "·"
  // as "middle dot" at higher verbosity, and the home button's label was deliberately
  // punctuation-free before this seam existed.
  test("`spoken` carries the words without the decorative middot", () => {
    expect(resolveBrand({ name: "Acme", suffix: "redakce" }).spoken).toBe("Acme redakce");
    expect(resolveBrand({ name: "Acme", suffix: null }).spoken).toBe("Acme");
  });

  // The READ, not just the resolution. Rename the config key or mistype the optional-chain
  // path and every deployment silently renders "pramen" while the rules above stay green.
  describe("readBrandConfig", () => {
    test("pulls `brand` off the host global the way /config.js writes it", () => {
      expect(readBrandConfig({ PRAMEN_CMS_EDITOR: { brand: { name: "Acme" } } })).toEqual({ name: "Acme" });
    });

    test("tolerates every shape a missing or partial /config.js produces", () => {
      expect(readBrandConfig(undefined)).toBeUndefined(); // SSR / no global
      expect(readBrandConfig({})).toBeUndefined(); // script 404'd
      expect(readBrandConfig({ PRAMEN_CMS_EDITOR: {} })).toBeUndefined(); // the shipped default
      expect(readBrandConfig({ PRAMEN_CMS_EDITOR: undefined })).toBeUndefined();
    });

    test("round-trips through resolveBrand — the path the app actually takes", () => {
      const host: BrandHost = { PRAMEN_CMS_EDITOR: { brand: { name: "Acme", suffix: null } } };
      expect(resolveBrand(readBrandConfig(host)).title).toBe("Acme");
    });
  });
});
