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
import { splitsByType, visibleTabs, INSPECTOR_TABS } from "../packages/cms-editor/src/components";
import { DEFAULT_CAPABILITIES } from "../packages/cms-editor/src/types";
import type { ContentType } from "../packages/cms-editor/src/types";
import type { HandlerContext } from "@pramen/server";

const TWO_TYPES: ContentType[] = [
  { id: "t-page", name: "Pages", slug: "page" },
  { id: "t-article", name: "Articles", slug: "article" },
];

interface Caps {
  locales: string[];
  defaultLocale: string;
  multilingual: boolean;
  pagesByType: boolean;
  siteFurniture: boolean;
  canEdit: boolean;
}

const rawCaps = (opts?: { locales?: readonly string[]; editorRoles?: readonly string[] }, ctx: HandlerContext = {} as HandlerContext): Caps => {
  const h = createCmsHandlers(opts) as unknown as { listCmsCapabilities: { run: (c: HandlerContext) => Caps } };
  return h.listCmsCapabilities.run(ctx);
};

/** The DECLARED half — everything except `canEdit`, which is per-caller and asserted
 * separately below. */
const caps = (opts?: { locales?: readonly string[] }): Omit<Caps, "canEdit"> => {
  const { canEdit: _canEdit, ...declared } = rawCaps(opts);
  return declared;
};

const asRole = (...roles: string[]): HandlerContext => ({ identity: { roles } }) as unknown as HandlerContext;

describe("declared locales", () => {
  test("a deployment that declares nothing is monolingual `en` — the previous default", () => {
    expect(caps()).toEqual({ locales: ["en"], defaultLocale: "en", multilingual: false, pagesByType: true, siteFurniture: true });
  });

  test("one declared locale is still monolingual — no i18n surface for a single-locale site", () => {
    expect(caps({ locales: ["cs"] })).toEqual({ locales: ["cs"], defaultLocale: "cs", multilingual: false, pagesByType: true, siteFurniture: true });
  });

  test("two or more is multilingual, and the FIRST is the default a page is stamped with", () => {
    expect(caps({ locales: ["cs", "en"] })).toEqual({ locales: ["cs", "en"], defaultLocale: "cs", multilingual: true, pagesByType: true, siteFurniture: true });
  });

  // The bug the old flag's doc comment papered over: a Czech-only site that hid the i18n
  // surface still had every page stamped "en", because `defaultLocale` was a separate
  // option the documented wiring never passed. One declaration, so they cannot disagree.
  test("the default locale is DERIVED, so it can never contradict the declared list", () => {
    expect(caps({ locales: ["cs"] }).defaultLocale).toBe("cs");
    expect(caps({ locales: ["de", "en", "fr"] }).defaultLocale).toBe("de");
  });

  test("an empty declaration falls back rather than leaving a page with no locale", () => {
    expect(caps({ locales: [] })).toEqual({ locales: ["en"], defaultLocale: "en", multilingual: false, pagesByType: true, siteFurniture: true });
  });
});

// `canEdit` is the one per-CALLER answer in the capability probe. `viewer` is
// `editorRoles ∪ reviewerRoles`, so a reviewer-only session reaches this handler and every
// read handler while every WRITE stays editor-gated — and the editor cannot work that out
// for itself, because it knows the caller's roles but not which roles this deployment
// configured as `editorRoles`. Without it the authoring surfaces render for a reviewer and
// each one 403s on its first save.
describe("canEdit", () => {
  test("an editor may author", () => {
    expect(rawCaps(undefined, asRole("editor")).canEdit).toBe(true);
    expect(rawCaps(undefined, asRole("admin")).canEdit).toBe(true);
  });

  test("a reviewer-only session may read but not author", () => {
    expect(rawCaps(undefined, asRole("reviewer")).canEdit).toBe(false);
  });

  test("it follows the deployment's OWN editorRoles, not a hardcoded name", () => {
    expect(rawCaps({ editorRoles: ["redaktor"] }, asRole("redaktor")).canEdit).toBe(true);
    expect(rawCaps({ editorRoles: ["redaktor"] }, asRole("editor")).canEdit).toBe(false);
  });
});

describe("the editor's visible inspector tabs", () => {
  // ONE definition of the rule, used by the tab bar, the panel switch and the route's
  // deep-link fallback — which previously each re-derived it and could disagree.
  test("i18n is shown only on a multilingual deployment", () => {
    expect(visibleTabs(true, true)).toEqual(INSPECTOR_TABS);
    expect(visibleTabs(false)).not.toContain("i18n");
  });

  test("hiding i18n removes exactly that tab, in order", () => {
    expect(visibleTabs(false, true)).toEqual(["settings", "seo", "workflow", "terms", "audit"]);
  });

  // Same rule, the other optional panel: `terms` assigns taxonomy terms to the page, and on
  // a server without the taxonomy handlers it could only ever render an error.
  test("terms is shown only where the server has the site-furniture handlers", () => {
    expect(visibleTabs(true, false)).not.toContain("terms");
    expect(visibleTabs(false, true)).toContain("terms");
    expect(visibleTabs(false, false)).toEqual(["settings", "seo", "workflow", "audit"]);
  });

  // Until the server answers — and on a server too old to have the handler — the editor
  // assumes monolingual: a hidden surface recovers on reload, a half-rendered one is what
  // this replaced.
  test("the pre-answer default is monolingual", () => {
    expect(DEFAULT_CAPABILITIES.multilingual).toBe(false);
    expect(visibleTabs(DEFAULT_CAPABILITIES.multilingual)).not.toContain("i18n");
  });

  // Same argument, the other capability: an older server ACCEPTS `listPages({ contentType })`
  // and ignores it, answering with the pooled list. An editor that assumed the feature would
  // render one tab per type, each showing every type's pages under a heading naming one — and
  // "New page" from any of them stamping that tab's type. So the default is off.
  test("per-type lists are off until the server declares them", () => {
    expect(DEFAULT_CAPABILITIES.pagesByType).toBe(false);
    expect(splitsByType(TWO_TYPES, DEFAULT_CAPABILITIES, false)).toBe(false);
  });
});

describe("the nav shape", () => {
  const cms = { ...DEFAULT_CAPABILITIES, pagesByType: true };

  test("two or more declared types get a tab (and a list) each", () => {
    expect(splitsByType(TWO_TYPES, cms, false)).toBe(true);
  });

  test("one type keeps the pooled `Pages` list — there is nothing there to separate", () => {
    expect(splitsByType([TWO_TYPES[0]], cms, false)).toBe(false);
  });

  // `null` is NOT ANSWERED YET, and answering `true` for it would paint (and fetch) the very
  // pooled list the split exists to retire, then redirect away from it a round trip later.
  test("an unanswered list commits to nothing", () => {
    expect(splitsByType(null, cms, false)).toBe(false);
  });

  test("a deployment with no page builder at all never splits", () => {
    expect(splitsByType(TWO_TYPES, cms, true)).toBe(false);
  });
});
