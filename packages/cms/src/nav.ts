// Where each built-in section sits in the CMS editor's primary nav.
//
// A LEAF module, like `href.ts`: both `index.ts` (for `CollectionDef.navOrder`) and
// `blockkit.ts` (for `AdminPageDef.navOrder`) need it, and importing it from `index.ts`
// would make `blockkit.ts` depend on a module that evaluates `Entity(...)` calls at module
// scope — a cycle, and one whose evaluation order would decide whether `NAV_ORDER` is
// defined when `adminPage()` reads it.

/**
 * Positions for the editor's built-in nav sections.
 *
 * Spaced 100 apart so anything can be placed BETWEEN two built-ins without renumbering
 * them — `navOrder: 150` puts a section after Pages and before collections. The values
 * themselves are ordinals with no other meaning; only their relative order is contract.
 *
 * Declared server-side, and not only in the editor, because the ordering key travels on
 * `CollectionMeta` and `AdminPageMeta`: a host choosing a position has to be able to name
 * what it is placing against, and it is writing `app.ts`, not editor code. The editor keeps
 * a mirror — it is a standalone browser app that speaks to the CMS purely over HTTP, so it
 * cannot import this.
 */
export const NAV_ORDER = {
  pages: 100,
  collections: 200,
  media: 300,
  menus: 400,
  taxonomies: 500,
  widgets: 600,
  redirects: 700,
  /** Custom admin pages (`adminPage()`), which are project surfaces, not CMS furniture. */
  adminPages: 800,
  /** Block/content-type authoring — schema, so it sits with the admin tools, not content. */
  types: 900,
  users: 1000,
  settings: 1100,
  /** Host-configured `extraNav` links, which are still last by default. */
  extra: 1200,
} as const;
