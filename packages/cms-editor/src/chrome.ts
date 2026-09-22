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

// The page's width and gutters are THEME, not code: custom properties defaulted in `app.css`,
// so a host re-proportions every screen from its own stylesheet (the `styles` entry of
// `buildEditor()`) with one `:root` rule, instead of rewriting class strings in our source.
// The names are written out literally for the reason given under the app bar below.

/** The content column: capped width, centred, with the side gutter. For a screen that sets
 * its own vertical rhythm (a notice, the users list). */
export const CONTENT = "mx-auto max-w-[var(--pramen-content-max)] px-[var(--pramen-gutter)]";

/** The page gutter every full-width screen uses: the content column plus the page's own
 * padding above and below. */
export const WRAP =
  "mx-auto max-w-[var(--pramen-content-max)] px-[var(--pramen-gutter)] pb-[var(--pramen-page-pb)] pt-[var(--pramen-page-pt)]";

/** One row in a list — a card-surfaced strip with the standard inset. */
export const ROW = "flex items-center gap-3 rounded-[14px] border border-transparent bg-surface-card px-[18px] py-3.5";

/** What a `<button>` that opens something needs on top of its own look: full width and
 * left-aligned like the `<div>` it replaced, the hover every clickable row had, and a focus
 * ring for the keyboard.
 *
 * The rows and tiles that open a page, a collection row, a menu or a file were `<div
 * onClick>`: reachable by mouse, invisible to Tab, and announced as plain text. A real button
 * is focusable and answers Enter and Space with no key handler of ours. `focus-visible`
 * rather than `focus`, so a mouse click does not leave a ring behind. */
export const ROW_BUTTON =
  "w-full cursor-pointer text-left outline-none transition-colors hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-ring";

/** The same for a grid tile (the media library, the media picker): no row hover fill, since
 * the tile is mostly thumbnail and a tinted card behind an image reads as a selection. */
export const TILE_BUTTON = "block w-full cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
// page editor to express one length.
//
// The values live in `app.css`, keyed by `data-pramen-chrome` on the document root (see
// `chromeAttr`), not in an inline style. That is what makes them theme: an inline style beats
// every stylesheet, so a host that wanted a taller bar or more air under it had nothing to
// override but our source. Declared on the ROOT, next to podoba's tokens, so a host's plain
// `:root { --pramen-chrome-pad: 3rem }` lands on the same element and wins by being
// unlayered (ours sit in `@layer base`). The bars size themselves off the same variable, so
// the height and every offset measured against it cannot drift apart.
//
// The property NAMES are written out as literal text, here and in `app.css`, not
// interpolated from a constant. Tailwind v4 finds utilities by scanning source files for
// class names, so a built string like `` `top-[var(${CHROME_H_VAR})]` `` names a utility that
// never gets generated: the app builds, the rule is simply absent, and every sticky header
// silently stops sticking.

/** Put the layout where `app.css` keys the chrome metrics off it. Called once, from
 * `main.tsx`, before the first render, for the same reason as `initTheme`. Takes the
 * root structurally, so this module keeps needing no DOM lib. */
export function chromeAttr(root: { dataset: Record<string, string | undefined> }, layout: ChromeLayout): void {
  root.dataset.pramenChrome = layout;
}

/** The app bar's height, for whichever chrome is showing. */
export const APP_BAR_H = "h-[var(--pramen-chrome-h)]";

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
