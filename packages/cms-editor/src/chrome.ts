// The layout primitives every screen shares — and the choice of which chrome wraps them.
//
// A LEAF module on purpose. These were copied into four files, and the obvious fix — put
// them in `components.tsx`, which already has them — is not available: `components.tsx`
// imports from `furniture.tsx` (for `flattenTerms`, used by the page editor's Terms panel),
// so `furniture.tsx` importing back would be a cycle. Constants and class strings have no
// dependencies of their own, so they belong below both.
//
// Class strings rather than components, because that is what the call sites want: most
// apply them to an element they are already styling for their own reasons.
//
// Free of React and of DOM-lib imports, like `brand.ts`: the layout is resolved at module
// load, before any component renders, and the resolution is a pure function of config that a
// test can exercise with a plain object.

/** The page gutter every full-width screen uses. */
export const WRAP = "mx-auto max-w-[1200px] px-7 pb-8 pt-2";

/** One row in a list — a card-surfaced strip with the standard inset. */
export const ROW = "flex items-center gap-3 rounded-[14px] border border-transparent bg-surface-card px-[18px] py-3.5";

// --- which chrome ------------------------------------------------------------------------
//
// TWO shapes for the same nav, chosen by the deployment. The default is the SIDEBAR, which
// is what this admin grew into: a dozen-plus destinations (Pages or one entry per content
// type, N collections, Media, Menus, Taxonomies, Widgets, Redirects, Apps, Types, Users,
// Settings, host links) read as a scannable column with icons and headings, and as a dense
// unlabelled ribbon in a row.
//
// `"topbar"` is the second: the brand-left / tabs-right bar the Graphic Standard apps use
// (podoba's `Topbar`, which is the same bar extracted). It is the right chrome when the
// admin sits INSIDE a product that already wears that bar — a horizontal nav under a
// vertical one reads as two apps stacked — and for a small deployment whose whole nav fits a
// row. `chrome-topbar.tsx` keeps it legible past that size by rendering the first nav
// section as tabs and folding each later section into a dropdown, rather than reviving the
// horizontal scroller the sidebar replaced.

/** The chrome a deployment wears. */
export type ChromeLayout = "sidebar" | "topbar";

/** What ships when nothing is configured — the shape every existing deployment already has. */
export const DEFAULT_LAYOUT: ChromeLayout = "sidebar";

/** Every value `layout` accepts, for the warning below and for the docs to stay in step. */
export const CHROME_LAYOUTS: readonly ChromeLayout[] = ["sidebar", "topbar"];

/**
 * Resolve the configured chrome, falling back to the sidebar.
 *
 * A present-but-unrecognised value is WARNED about rather than silently accepted, for the
 * reason `resolveBrand` warns: this config is templated from env vars and hand-edited, so
 * `layout: "top"` or `layout: true` is a plausible slip, and it would otherwise ship the
 * DEFAULT chrome to a deployment that asked for the other one — silently, and only
 * noticeable by someone who knew what they were expecting to see.
 */
export function resolveLayout(value: unknown): ChromeLayout {
  if (value === undefined || value === null) return DEFAULT_LAYOUT;
  const named = typeof value === "string" ? value.trim() : "";
  if ((CHROME_LAYOUTS as readonly string[]).includes(named)) return named as ChromeLayout;
  console.warn(
    `pramen/cms-editor: ignoring unusable \`layout\` ${JSON.stringify(value)} — using "${DEFAULT_LAYOUT}". Expected one of ${CHROME_LAYOUTS.map((l) => JSON.stringify(l)).join(", ")}.`,
  );
  return DEFAULT_LAYOUT;
}

/** The global the host's shell writes. Declared structurally rather than reaching for
 * `Window`, so this module needs no DOM lib — and so a test can hand it a plain object. */
export interface LayoutHost {
  PRAMEN_CMS_EDITOR?: { layout?: unknown };
}

/** Pull the layout config off a host global, tolerating its absence (SSR, tests, a shell
 * that declared nothing). Exported so the READ is testable, not just the resolution. */
export function readLayoutConfig(host: LayoutHost | undefined): unknown {
  return host?.PRAMEN_CMS_EDITOR?.layout;
}

/** The chrome for THIS page load. Read at module load, like `BRAND` — the shell's inline
 * script runs ahead of the bundle, so it is already set. */
export const CHROME_LAYOUT: ChromeLayout = resolveLayout(readLayoutConfig(globalThis as LayoutHost));

// --- the app bar, and what has to clear it -----------------------------------------------
//
// ONE number, read by three modules. The bar at the top of the content column is sticky, and
// the screen header is sticky BELOW it — so the header's offset has to be the bar's height,
// exactly. A magic `44` written out in each is a one-pixel gap or overlap waiting for the
// next edit.
//
// It is a CSS VARIABLE rather than a pair of literal classes because the number is no longer
// a constant: the sidebar's app bar is 44px and the topbar is 77px (podoba's `Topbar` at the
// height the Graphic Standard apps set it to). Tailwind needs literal class names, so a
// per-layout class string would mean every sticky call site taking the layout as a prop and
// picking between two — threading a value through `page-header.tsx` and three levels of the
// page editor to express one length. The variable is declared once on the chrome's root
// element (see `chromeVars`) and defaulted in `app.css`, so a screen rendered outside the
// chrome (a test, a panel) still lays out.

/** How tall each chrome is, and how much air it leaves under itself.
 *
 * The topbar's 77px is the Graphic Standard bar's own height (`Topbar` defaults to 56px;
 * gs sets `h-[77px]`), and the 24px under it stands in for the gap gs leaves between its
 * bar and the first section — pramen's screen header is a sticky panel rather than gs's
 * static one, so the full 48px would be that much dead space pinned to the top all the way
 * down a list. The sidebar keeps 0: its bar carries no rule, and the header meeting it
 * directly is what makes the two read as one block of chrome. */
export const CHROME_METRICS = {
  sidebar: { height: "2.75rem", pad: "0px" },
  topbar: { height: "77px", pad: "1.5rem" },
} satisfies Record<ChromeLayout, { height: string; pad: string }>;

/** The two custom properties to declare on the chrome's root element. */
export function chromeVars(layout: ChromeLayout) {
  const m = CHROME_METRICS[layout];
  return { "--pramen-chrome-h": m.height, "--pramen-chrome-pad": m.pad };
}

// The property NAMES are written out as literal text here, in `chromeVars` above and in
// `app.css` — not interpolated from a constant. Tailwind v4 finds utilities by scanning
// source files for class names, so a built string like `` `top-[var(${CHROME_H_VAR})]` ``
// names a utility that never gets generated: the app builds, the rule is simply absent, and
// every sticky header silently stops sticking. Keep the three sites in step by hand; there
// are two names and they are one screen apart.

/** The sidebar app bar's height. Only the sidebar chrome renders it; the topbar sizes
 * itself (podoba's `Topbar` owns its height), which is why this is not `Record`-shaped. */
export const APP_BAR_H = "h-11";

/** The sticky offset anything pinned beneath the chrome must use. */
export const BELOW_APP_BAR = "top-[var(--pramen-chrome-h)]";

/** The air between the chrome and the first panel of a screen. Applied ONCE, by the chrome,
 * to the column it wraps — not by `page-header.tsx`, so that it belongs to every screen and
 * so that it scrolls away rather than staying pinned above a stuck header. */
export const BELOW_CHROME_PAD = "pt-[var(--pramen-chrome-pad)]";

// --- the page editor's own toolbar ---------------------------------------------------------
//
// Same "one number, several readers" rule as the app bar above, one level deeper. The
// editor's toolbar is sticky BELOW the chrome, and the inspector column is sticky below
// THAT — three elements, two of which need to know the height of what is above them.

/** The page editor's toolbar height. */
export const PAGE_TOOLBAR_H = "h-14";

/** …and the offset for anything pinned beneath it: the chrome plus the toolbar (56px). */
export const BELOW_PAGE_TOOLBAR = "top-[calc(var(--pramen-chrome-h)+3.5rem)]";

/** The inspector column's cap: everything above it (chrome + toolbar) plus a 28px gutter,
 * so the panel ends where the viewport does instead of running under it. */
export const INSPECTOR_MAX_H = "max-h-[calc(100vh-var(--pramen-chrome-h)-3.5rem-1.75rem)]";
