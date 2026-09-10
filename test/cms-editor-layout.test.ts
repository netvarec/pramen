// @pramen/cms-editor — which chrome a deployment wears (`window.PRAMEN_CMS_EDITOR.layout`).
//
// The editor ships two shapes of the same nav: the default sidebar rail, and the Graphic
// Standard topbar for a deployment whose own product wears that bar. These pin the two
// halves that are pure functions and so testable without a DOM — the resolution of the
// config value, and the rule that decides which nav entries a horizontal bar can show flat.
//
// The load-bearing case is the FIRST one: configuring nothing has to render exactly as it
// did before this seam existed, on every deployment already out there.

import { describe, expect, test } from "bun:test";
import {
  CHROME_METRICS,
  CHROME_LAYOUTS,
  DEFAULT_LAYOUT,
  chromeVars,
  readLayoutConfig,
  resolveLayout,
  type LayoutHost,
} from "../packages/cms-editor/src/chrome";
import { buildNav, navSections, topbarNav, type NavInput } from "../packages/cms-editor/src/nav";
import { DEFAULT_CAPABILITIES, type CollectionMeta } from "../packages/cms-editor/src/types";

describe("cms-editor chrome layout", () => {
  test("unconfigured is the sidebar — the shape every existing deployment already has", () => {
    expect(resolveLayout(undefined)).toBe("sidebar");
    expect(resolveLayout(null)).toBe("sidebar");
    expect(DEFAULT_LAYOUT).toBe("sidebar");
    expect(readLayoutConfig(undefined)).toBeUndefined();
    expect(readLayoutConfig({})).toBeUndefined();
    expect(readLayoutConfig({ PRAMEN_CMS_EDITOR: {} })).toBeUndefined();
  });

  test("a declared layout is honoured, trimmed", () => {
    for (const layout of CHROME_LAYOUTS) expect(resolveLayout(layout)).toBe(layout);
    expect(resolveLayout("  topbar  ")).toBe("topbar");
    const host: LayoutHost = { PRAMEN_CMS_EDITOR: { layout: "topbar" } };
    expect(resolveLayout(readLayoutConfig(host))).toBe("topbar");
  });

  // Same rule as `resolveBrand`: this config is templated from env vars and hand-edited, it
  // is read at MODULE LOAD in the entry bundle's import graph, and there is no error
  // boundary above it — a throw here is a blank page, not a chrome that looks wrong.
  test("a malformed value falls back instead of throwing", () => {
    const junk: unknown[] = [true, 0, 123, "", "   ", "top", "Topbar", [], ["topbar"], {}, () => "topbar"];
    for (const v of junk) {
      expect(() => resolveLayout(v)).not.toThrow();
      expect(resolveLayout(v)).toBe(DEFAULT_LAYOUT);
    }
  });

  // The sticky offsets in `page-header.tsx` and the page editor are measured against these
  // two custom properties, so a chrome that reported the wrong height would leave a gap or
  // an overlap on every screen. The sidebar's numbers are the ones that were hardcoded
  // before the variables existed (`top-11` / no gap).
  test("each chrome declares its own height and the air under it", () => {
    expect(chromeVars("sidebar")).toEqual({ "--pramen-chrome-h": "2.75rem", "--pramen-chrome-pad": "0px" });
    expect(chromeVars("topbar")).toEqual({ "--pramen-chrome-h": "77px", "--pramen-chrome-pad": "1.5rem" });
    for (const layout of CHROME_LAYOUTS) expect(CHROME_METRICS[layout]).toBeDefined();
  });
});

const col = (slug: string): CollectionMeta => ({
  slug,
  label: slug,
  pluralLabel: slug,
  fields: [],
  list: [],
  titleField: "title",
  idField: "id",
});

const sections = (over: Partial<NavInput> = {}) =>
  navSections(
    buildNav({
      collections: [],
      adminPages: [],
      contentTypes: null,
      cms: DEFAULT_CAPABILITIES,
      hidePages: false,
      splitByType: false,
      isAdmin: false,
      extraNav: [],
      ...over,
    }),
  );

describe("topbarNav", () => {
  // The reason this rule exists at all: a dozen destinations in one row is the dense
  // unlabelled ribbon over a horizontal scroller that the sidebar was built to replace.
  test("the first section is flat and every later one folds into a dropdown", () => {
    const s = sections({ cms: { ...DEFAULT_CAPABILITIES, siteFurniture: true, canEdit: true }, isAdmin: true, collections: [col("lectures")] });
    expect(s.map((x) => x.id)).toEqual(["content", "site", "system"]);
    const { tabs, menus } = topbarNav(s);
    expect(tabs.map((e) => e.key)).toEqual(["pages", "col:lectures", "media"]);
    expect(menus.map((m) => m.id)).toEqual(["site", "system"]);
    // Nothing is dropped on the way: every entry is reachable from the bar.
    expect(tabs.length + menus.reduce((n, m) => n + m.entries.length, 0)).toBe(s.reduce((n, x) => n + x.entries.length, 0));
  });

  // A collections-only deployment is the small end of the range this chrome is FOR: two
  // groups, three tabs and one dropdown, which is the gs bar's own size.
  test("a small deployment is a row of tabs and one menu", () => {
    const s = sections({ hidePages: true, collections: [col("lectures")] });
    const { tabs, menus } = topbarNav(s);
    expect(tabs.map((e) => e.key)).toEqual(["col:lectures", "media"]);
    expect(menus.map((m) => m.id)).toEqual(["system"]);
  });

  // A lone "Content" dropdown would hide the entire nav behind a click — and there is
  // nothing to fold away FROM, which is the same reason `navSections` leaves one group
  // unlabelled. Constructed rather than built, because Settings is unconditional so a real
  // nav always has a System band — the same reason `navSectionsAreLabelled`'s own
  // single-group case is a literal in `cms-editor-nav.test.ts`.
  test("a single section stays entirely flat", () => {
    const [content] = sections({ hidePages: true, collections: [col("lectures")] });
    const { tabs, menus } = topbarNav([content!]);
    expect(tabs.map((e) => e.key)).toEqual(["col:lectures", "media"]);
    expect(menus).toEqual([]);
  });

  test("an empty nav is not a crash", () => {
    expect(topbarNav([])).toEqual({ tabs: [], menus: [] });
  });
});
