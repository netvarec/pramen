// @pramen/cms — DECLARED locales, and the editor surface that renders off them.
//
// The i18n surface used to be gated by a client-side `hideI18n` flag in the editor's
// /config.js. That duplicated on the client a truth the server owns: it hid the control
// without changing what the client sent, made a wrong locale uncorrectable (the only field
// that could fix one was the field being hidden), and could drift from the data the moment
// someone added a locale. The server declares `locales` instead, exactly as a collection
// declares `supports: [...]`, and the editor asks.

import { describe, expect, test } from "bun:test";
import { createCmsHandlers } from "../packages/cms/src/index";
import { visibleTabs, INSPECTOR_TABS } from "../packages/cms-editor/src/components";
import { DEFAULT_CAPABILITIES } from "../packages/cms-editor/src/types";
import type { HandlerContext } from "@pramen/server";

const caps = (opts?: { locales?: readonly string[] }) => {
  const h = createCmsHandlers(opts) as unknown as { listCmsCapabilities: { run: (c: HandlerContext) => { locales: string[]; defaultLocale: string; multilingual: boolean } } };
  return h.listCmsCapabilities.run({} as HandlerContext);
};

describe("declared locales", () => {
  test("a deployment that declares nothing is monolingual `en` — the previous default", () => {
    expect(caps()).toEqual({ locales: ["en"], defaultLocale: "en", multilingual: false });
  });

  test("one declared locale is still monolingual — no i18n surface for a single-locale site", () => {
    expect(caps({ locales: ["cs"] })).toEqual({ locales: ["cs"], defaultLocale: "cs", multilingual: false });
  });

  test("two or more is multilingual, and the FIRST is the default a page is stamped with", () => {
    expect(caps({ locales: ["cs", "en"] })).toEqual({ locales: ["cs", "en"], defaultLocale: "cs", multilingual: true });
  });

  // The bug the old flag's doc comment papered over: a Czech-only site that hid the i18n
  // surface still had every page stamped "en", because `defaultLocale` was a separate
  // option the documented wiring never passed. One declaration, so they cannot disagree.
  test("the default locale is DERIVED, so it can never contradict the declared list", () => {
    expect(caps({ locales: ["cs"] }).defaultLocale).toBe("cs");
    expect(caps({ locales: ["de", "en", "fr"] }).defaultLocale).toBe("de");
  });

  test("an empty declaration falls back rather than leaving a page with no locale", () => {
    expect(caps({ locales: [] })).toEqual({ locales: ["en"], defaultLocale: "en", multilingual: false });
  });
});

describe("the editor's visible inspector tabs", () => {
  // ONE definition of the rule, used by the tab bar, the panel switch and the route's
  // deep-link fallback — which previously each re-derived it and could disagree.
  test("i18n is shown only on a multilingual deployment", () => {
    expect(visibleTabs(true)).toEqual(INSPECTOR_TABS);
    expect(visibleTabs(false)).not.toContain("i18n");
  });

  test("hiding i18n removes exactly that tab, in order", () => {
    expect(visibleTabs(false)).toEqual(["settings", "seo", "workflow", "audit"]);
  });

  // Until the server answers — and on a server too old to have the handler — the editor
  // assumes monolingual: a hidden surface recovers on reload, a half-rendered one is what
  // this replaced.
  test("the pre-answer default is monolingual", () => {
    expect(DEFAULT_CAPABILITIES.multilingual).toBe(false);
    expect(visibleTabs(DEFAULT_CAPABILITIES.multilingual)).not.toContain("i18n");
  });
});
