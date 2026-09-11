// @pramen/cms-editor — how a deployment dresses the screen header
// (`window.PRAMEN_CMS_EDITOR.pageHeader`).
//
// The seam exists because the only hook a host had was a stylesheet selecting on the header's
// internal DOM, which pins itself to private structure AND is blind to what it selects: the
// shipped example turned Media's `+ Upload` into "New + Upload" and put white text on a mint
// fill at 1.58:1. So the assertions here are not only "the config is read" — the load-bearing
// ones are the two the DOM hook could not get right and this API must not be able to:
//
//   - the derived label colour on an accent is the higher-contrast of podoba's two inks, and
//   - a value whose contrast CANNOT be computed (var(), oklch(), alpha) is refused outright.
//
// Plus the rule every one of these config modules shares: unconfigured renders exactly as it
// did before the seam existed, and nothing malformed throws — this is resolved at module load
// in the entry bundle's import graph, where a throw is a blank page.

import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader } from "../packages/cms-editor/src/page-header";
import {
  DEFAULT_PAGE_HEADER_STYLE,
  DEFAULT_VARIANT,
  ON_ACCENT_CANDIDATES,
  PAGE_HEADER_VARIANTS,
  accentVars,
  contrastRatio,
  hoverShade,
  onAccent,
  parseColor,
  readPageHeaderConfig,
  relativeLuminance,
  resolvePageHeader,
  setPageHeaderStyle,
  type PageHeaderHost,
} from "../packages/cms-editor/src/page-header-style";

describe("pageHeader config", () => {
  test("unconfigured is the cover panel every deployment already has", () => {
    for (const nothing of [undefined, null]) {
      expect(resolvePageHeader(nothing)).toEqual(DEFAULT_PAGE_HEADER_STYLE);
    }
    expect(DEFAULT_PAGE_HEADER_STYLE).toEqual({ variant: "cover", vars: {}, titleFont: undefined });
    expect(DEFAULT_VARIANT).toBe("cover");
    expect(readPageHeaderConfig(undefined)).toBeUndefined();
    expect(readPageHeaderConfig({})).toBeUndefined();
    expect(readPageHeaderConfig({ PRAMEN_CMS_EDITOR: {} })).toBeUndefined();
  });

  test("each declared variant is honoured, trimmed", () => {
    for (const variant of PAGE_HEADER_VARIANTS) expect(resolvePageHeader({ variant }).variant).toBe(variant);
    expect(resolvePageHeader({ variant: "  bare  " }).variant).toBe("bare");
    const host: PageHeaderHost = { PRAMEN_CMS_EDITOR: { pageHeader: { variant: "flat" } } };
    expect(resolvePageHeader(readPageHeaderConfig(host)).variant).toBe("flat");
  });

  // `resolveLayout`'s rule, for `resolveLayout`'s reason: this config is hand-edited and
  // templated from env vars, and there is no error boundary above module load.
  test("a malformed config falls back instead of throwing", () => {
    const junk: unknown[] = [true, 0, 123, "flat", [], ["flat"], () => "flat"];
    for (const v of junk) {
      expect(() => resolvePageHeader(v)).not.toThrow();
      expect(resolvePageHeader(v)).toEqual(DEFAULT_PAGE_HEADER_STYLE);
    }
    for (const v of [true, 7, "", "  ", "Flat", "panel", {}, []]) {
      expect(resolvePageHeader({ variant: v }).variant).toBe(DEFAULT_VARIANT);
    }
    // One bad field does not take the others down with it.
    expect(resolvePageHeader({ variant: "nope", accent: "#000000", titleFont: "Inter" })).toEqual({
      variant: "cover",
      vars: accentVars({ r: 0, g: 0, b: 0 }),
      titleFont: "Inter",
    });
  });

  test("a title font is applied as given; a value carrying CSS syntax is not", () => {
    expect(resolvePageHeader({ titleFont: "  Inter, system-ui, sans-serif  " }).titleFont).toBe("Inter, system-ui, sans-serif");
    expect(resolvePageHeader({ titleFont: '"GT America", sans-serif' }).titleFont).toBe('"GT America", sans-serif');
    // A host that meant to write a whole rule gets a warning, not the design system's font
    // silently back.
    for (const v of ["Inter; color: red", "Inter}", "<script>", "", 7, null, undefined]) {
      expect(resolvePageHeader({ titleFont: v }).titleFont).toBeUndefined();
    }
  });
});

describe("accent — colour the editor must reason about, not pass through", () => {
  test("the literals a host can write", () => {
    expect(parseColor("#73e2b2")).toEqual({ r: 0x73, g: 0xe2, b: 0xb2 });
    expect(parseColor("  #FFF  ")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#73e2b2ff")).toEqual({ r: 0x73, g: 0xe2, b: 0xb2 }); // full alpha changes nothing
    expect(parseColor("#ffff")).toEqual({ r: 255, g: 255, b: 255 }); // 4-digit, alpha f
    expect(parseColor("rgb(115, 226, 178)")).toEqual({ r: 115, g: 226, b: 178 });
    expect(parseColor("rgb(115 226 178)")).toEqual({ r: 115, g: 226, b: 178 });
    expect(parseColor("rgb(115 226 178 / 100%)")).toEqual({ r: 115, g: 226, b: 178 });
    expect(parseColor("rgb(0% 100% 50%)")).toEqual({ r: 0, g: 255, b: 128 });
  });

  // The whole reason the accent is parsed: an unreadable value is one we cannot derive a
  // label colour for, and shipping it with podoba's default `text-fg-inverted` is exactly the
  // 1.58:1 the issue reported. Refusing is louder than guessing.
  test("anything whose contrast cannot be measured is refused", () => {
    const unmeasurable = [
      "var(--gs-admin-mint)",
      "oklch(0.85 0.13 165)",
      "mint",
      "rebeccapurple",
      "#73e2b280", // alpha: contrast depends on a themed surface behind it
      "rgba(115, 226, 178, 0.5)",
      "rgb(115 226 178 / 50%)",
      "#12345",
      "rgb(300, 0, 0)",
      "rgb(1, 2)",
      "linear-gradient(#000, #fff)",
      "",
    ];
    for (const v of unmeasurable) expect(parseColor(v)).toBeUndefined();
    for (const v of unmeasurable) expect(resolvePageHeader({ accent: v }).vars).toEqual({});
    expect(resolvePageHeader({ accent: 123 }).vars).toEqual({});
  });

  test("the label on the accent is the ink that actually reads on it", () => {
    const [ink, paper] = ON_ACCENT_CANDIDATES as [string, string];
    // The mint from the issue: near-white text on it is the 1.58:1 bug, so the label is ink.
    expect(onAccent(parseColor("#73e2b2")!).color).toBe(ink);
    // …and a dark brand colour takes paper.
    expect(onAccent(parseColor("#0d0d0d")!).color).toBe(paper);
    expect(onAccent(parseColor("#005ff9")!).color).toBe(paper);
    // Whatever the accent, what we picked is never worse than the alternative — which is the
    // property the DOM hook had no way to express.
    for (const accent of ["#73e2b2", "#0d0d0d", "#ffcc6a", "#ff69b4", "#005ff9", "#808080", "#ffffff"]) {
      const rgb = parseColor(accent)!;
      const picked = onAccent(rgb);
      const other = picked.color === ink ? paper : ink;
      expect(picked.ratio).toBeGreaterThanOrEqual(contrastRatio(rgb, parseColor(other)!));
      expect(picked.ratio).toBeCloseTo(contrastRatio(rgb, parseColor(picked.color)!), 10);
    }
  });

  test("contrast is computed on gamma-expanded channels, per WCAG", () => {
    expect(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 })).toBeCloseTo(21, 6);
    expect(contrastRatio({ r: 12, g: 34, b: 56 }, { r: 12, g: 34, b: 56 })).toBeCloseTo(1, 6);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 6);
    // Green carries most of the luminance — the coefficient that makes a mid-mint LIGHT and a
    // mid-blue DARK, which is the whole decision above.
    expect(relativeLuminance({ r: 0, g: 255, b: 0 })).toBeGreaterThan(relativeLuminance({ r: 0, g: 0, b: 255 }));
  });

  // podoba's primary hovers from near-black to #333 — "visibly shifted, same button". A fixed
  // direction would take a mint button to a lighter mint nobody can see on the panel.
  test("the hover shade moves away from the accent, in the direction that stays visible", () => {
    const lighten = parseColor(hoverShade(parseColor("#0d0d0d")!))!;
    expect(relativeLuminance(lighten)).toBeGreaterThan(relativeLuminance(parseColor("#0d0d0d")!));
    const darken = parseColor(hoverShade(parseColor("#73e2b2")!))!;
    expect(relativeLuminance(darken)).toBeLessThan(relativeLuminance(parseColor("#73e2b2")!));
    // Still the same hue family, not a jump to another colour.
    expect(darken.g).toBeGreaterThan(darken.r);
    expect(hoverShade({ r: 255, g: 255, b: 255 })).toMatch(/^#[0-9a-f]{6}$/);
    expect(hoverShade({ r: 0, g: 0, b: 0 })).toMatch(/^#[0-9a-f]{6}$/);
  });

  // TOKENS, scoped to the header — so the accent reaches whatever control the slot holds, and
  // nothing outside the header shifts. The three names are podoba's own, read by the Button's
  // `bg-brand-primary text-fg-inverted hover:bg-neutral-600`.
  test("an accent resolves to the three podoba tokens the primary action reads", () => {
    const vars = resolvePageHeader({ accent: "#73e2b2" }).vars;
    expect(Object.keys(vars).sort()).toEqual(["--color-brand-primary", "--color-fg-inverted", "--color-neutral-600"]);
    expect(vars["--color-brand-primary"]).toBe("#73e2b2");
    expect(vars["--color-fg-inverted"]).toBe(ON_ACCENT_CANDIDATES[0]);
    expect(vars["--color-neutral-600"]).not.toBe(vars["--color-brand-primary"]);
    // Normalised to hex on the way through, so an `rgb()` literal and its hex are one value.
    expect(resolvePageHeader({ accent: "rgb(115 226 178)" }).vars).toEqual(vars);
  });
});

// --- what each variant actually puts in the DOM -------------------------------------------
//
// Asserting on the markup and not only on the resolved object, because for THIS feature the
// DOM is the contract: #60 is a project that had to select on it, and the first promise made
// back is that an unconfigured deployment is unchanged.

const render = (style?: Parameters<typeof setPageHeaderStyle>[0]) => {
  setPageHeaderStyle(style);
  return renderToStaticMarkup(createElement(PageHeader, { lead: "Media", em: "3 files" }));
};

afterEach(() => setPageHeaderStyle(undefined));

describe("PageHeader markup", () => {
  test("unconfigured is the panel, the artwork and the mask — unchanged", () => {
    const html = render(undefined);
    expect(html).toContain("rounded-panel border border-border bg-surface-card");
    expect(html).toContain("<svg"); // the seeded cover
    expect(html).toContain("from-surface-card via-surface-card/70 to-transparent"); // its mask
    expect(html).toContain("px-8");
    expect(html).toContain("<h1");
    expect(html).not.toContain("style=");
    // The one place the title and its state live, in the order a screen reader gets them.
    expect(html).toContain(">Media</span>");
    expect(html).toContain(">3 files</span>");
  });

  test("`flat` keeps the panel and drops the art WITH its mask", () => {
    const html = render({ variant: "flat", vars: {}, titleFont: undefined });
    expect(html).toContain("rounded-panel border border-border bg-surface-card");
    expect(html).not.toContain("<svg");
    // A mask over a panel with nothing under it would be a gradient for its own sake.
    expect(html).not.toContain("from-surface-card");
    expect(html).toContain("px-8");
  });

  test("`bare` drops the panel too, and the title moves to the content column's edge", () => {
    const html = render({ variant: "bare", vars: {}, titleFont: undefined });
    expect(html).not.toContain("rounded-panel");
    expect(html).not.toContain("border-border");
    expect(html).not.toContain("<svg");
    expect(html).toContain("px-0");
    expect(html).not.toContain("px-8");
  });

  test("every variant keeps the sticky gutter, the single h1 and the action slot", () => {
    for (const variant of PAGE_HEADER_VARIANTS) {
      setPageHeaderStyle({ variant, vars: {}, titleFont: undefined });
      const html = renderToStaticMarkup(
        createElement(PageHeader, { lead: "Media", em: "3 files" }, createElement("button", null, "+ Upload")),
      );
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toContain("sticky");
      expect(html).toContain("bg-surface");
      expect(html).toContain("<button>+ Upload</button>");
    }
  });

  test("an accent lands as custom properties on the header root — and nowhere else", () => {
    const style = resolvePageHeader({ accent: "#73e2b2" });
    const html = render(style);
    // React writes unknown properties verbatim, so the tokens reach the element as declared.
    expect(html).toContain("--color-brand-primary:#73e2b2");
    expect(html).toContain(`--color-fg-inverted:${ON_ACCENT_CANDIDATES[0]}`);
    expect(html).toContain("--color-neutral-600:");
    // On the STICKY wrapper, which is the element that encloses both the panel and the
    // action — one declaration, inherited by whatever control the slot holds.
    expect(html.indexOf("--color-brand-primary")).toBeLessThan(html.indexOf("<h1"));
    expect(html.match(/--color-brand-primary/g)).toHaveLength(1);
  });

  test("a title font reaches the h1 and only the h1", () => {
    const html = render(resolvePageHeader({ titleFont: "Inter, system-ui, sans-serif" }));
    expect(html).toMatch(/<h1[^>]*style="font-family:Inter, system-ui, sans-serif"/);
    expect(html.match(/font-family/g)).toHaveLength(1);
  });
});
