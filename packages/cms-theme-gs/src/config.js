// The runtime half of the theme: what goes in `pramenCms({ admin })` next to `editorAssets`.
//
// Plain JavaScript with no imports, unlike the rest of this package, because its reader is an
// `astro.config.mjs`, which Node loads without a TypeScript step and without the editor's
// build (Bun APIs) or React. Typed by `config.d.ts` beside it.

/**
 * The shell settings GS's admin runs with. Spread it into `admin` and put yours after it:
 *
 * ```js
 * admin: { ...gsAdmin, editorAssets: "/admin", locale: "cs" }
 * ```
 *
 * - `layout: "topbar"`: GS's AppShell is a 77px top bar with tabs, not a sidebar. The editor's
 *   layout variables (`--pramen-*`, see `@pramen/cms-editor/app.css`) already default to its
 *   proportions: full-width content, 24px gutters, 48px under the bar.
 * - `hideControls`: GS's asset library is a masonry of cards with no search field and no filter
 *   toolbar over it, and its relation pickers have no search input either. Hiding a control
 *   never narrows a list (the full library is shown), so this is a product call a deployment
 *   can undo by overriding the key.
 *
 * The "Content structure" account-menu row is NOT here: it replaces the nav entry the theme's
 * `nav` slot hides, so the two ship together as build-time hooks (`gsNavHooks.accountMenu`).
 *
 * @type {import("./config").GsAdminConfig}
 */
export const gsAdmin = {
  layout: "topbar",
  hideControls: ["mediaSearch", "mediaFilters", "relationSearch"],
};
