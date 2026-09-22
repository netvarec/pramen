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
  CHROME_LAYOUTS,
  DEFAULT_LAYOUT,
  chromeAttr,
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

  // The sticky offsets in `page-header.tsx` and the page editor are measured against the
  // chrome's height, so a chrome that reported the wrong one would leave a gap or an overlap on
  // every screen. The values are theme now (see `app.css`); what the code owns is naming the
  // layout on the root, where the stylesheet keys them.
  test("the layout is named on the document root", () => {
    for (const layout of CHROME_LAYOUTS) {
      const root = { dataset: {} as Record<string, string | undefined> };
      chromeAttr(root, layout);
      expect(root.dataset.pramenChrome).toBe(layout);
    }
  });

  // The defaults a host overrides: the Graphic Standard AppShell's proportions (full width,
  // 24px gutters, 48px under the topbar). The sidebar keeps its bar height and no gap, so the
  // screen header still meets that bar directly.
  test("app.css defaults every layout length, in a layer a host's :root beats", async () => {
    const css = await Bun.file(new URL("../packages/cms-editor/src/app.css", import.meta.url)).text();
    const layered = css.slice(css.indexOf("@layer base {\n  :root {"));
    const root = layered.slice(0, layered.indexOf("}"));
    expect(root).toContain("--pramen-content-max: none;");
    expect(root).toContain("--pramen-gutter: 1.5rem;");
    expect(root).toContain("--pramen-page-pt: 0px;");
    expect(root).toContain("--pramen-page-pb: 1.5rem;");
    expect(root).toContain("--pramen-chrome-h: 2.75rem;");
    expect(root).toContain("--pramen-chrome-pad: 0px;");
    const topbar = layered.slice(layered.indexOf(':root[data-pramen-chrome="topbar"]'));
    expect(topbar.slice(0, topbar.indexOf("}"))).toContain("--pramen-chrome-h: 77px;");
    expect(topbar.slice(0, topbar.indexOf("}"))).toContain("--pramen-chrome-pad: 3rem;");
  });

  // The regression this seam exists for: a literal width or gutter left in one screen is a
  // screen that ignores the host's theme, noticed only by someone comparing it to the others.
  test("no screen hardcodes the content width or gutter", async () => {
    const src = new URL("../packages/cms-editor/src/", import.meta.url).pathname;
    for await (const file of new Bun.Glob("**/*.tsx").scan(src)) {
      const text = await Bun.file(src + file).text();
      expect({ file, width: /max-w-\[1200px\]/.test(text), gutter: /(?<![\w-])-?(?:px|mx)-7\b/.test(text) })
        .toEqual({ file, width: false, gutter: false });
    }
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
