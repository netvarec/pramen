// A custom admin PANEL — a project's own React screen, rendered inside the editor's chrome
// at a real route with a real nav entry.
//
// WHY A SECOND KIND, WHEN `adminPage()` EXISTS
//
// Block Kit (`adminPage()`) is a server-driven vocabulary: the handler returns JSON, the
// editor renders it, and the whole page comes back on every interaction. That is exactly
// right for a list-and-form screen, and it is the reason no project JavaScript runs in the
// admin. But the properties that make it safe are the same ones that cap it — an input
// cannot fire an interaction, every control is disabled for the round trip (so focus and
// caret are lost on each keystroke that matters), a table row cannot expand, and there is
// no link, no redirect, no dialog, no autofocus and no date input. Those are not gaps to
// patch one element at a time; a screen that needs local interaction needs local code.
//
// The alternative a project reaches for when Block Kit runs out is what this replaces: a
// standalone React SPA served next to the editor with the chrome rebuilt by hand. It goes
// out of the application, it does not have the same layout, and every chrome fix has to be
// made twice.
//
// So a panel is the SAME registry entry as a Block Kit page with the render moved to the
// browser. Same slug space, same `/apps/:slug` route, same "Apps" band in the nav, and —
// the part that matters — the same server-side role filter: a panel the caller may not open
// is absent from `listAdminPages`, so there is no nav entry to click and no route to reach.
//
// WHAT LIVES WHERE. The server owns everything a nav entry is made of (slug, label, icon,
// position, roles); the browser bundle owns only the component. That split is deliberate:
// if the bundle declared the label and the position, a client that failed to load would
// take the nav entry with it, and a client that loaded would be declaring its own placement
// with nothing to check it against. A panel whose bundle never registers is a listed entry
// that renders a diagnostic — which is a legible failure — rather than a section that
// silently ceases to exist.
//
// WHAT IS GIVEN UP. Block Kit's headline property is that no project JavaScript ever runs in
// the admin (#33). A panel gives that up, deliberately and only where a deployment asks for
// it: the bundle runs in the editor's own page with the editor's own session in scope, so it
// can read the stored token and call anything the caller can. `roles` below and the ACL still
// bound what the SERVER will do, and `PanelApi` is a small surface to write against, but
// neither is a sandbox — a panel is part of the admin, not a guest in it. That is the reason
// `adminPage()` remains the first thing to reach for and this the second.
//
// A LEAF module, like `href.ts` and `nav.ts`: `blockkit.ts` imports it to widen the
// registry, and it imports nothing back.

/** One custom admin panel: a nav entry the browser bundle fills in.
 *
 * There is no `render` here and there is not meant to be one — the rendering half is a
 * React component the deployment's panel bundle registers under the same `slug`. Everything
 * that decides whether the entry EXISTS is here, on the server, where it can be enforced.
 */
export interface AdminPanelDef {
  /** Discriminates a panel from an `AdminPageDef` in the one registry they share. Set by
   * {@link adminPanel}; it is a required field rather than an inferred one so a hand-built
   * object literal cannot be a half-declared panel. */
  readonly kind: "panel";
  /** URL + registry key: served at `/apps/:slug` in the editor, and the id the browser
   * bundle registers its component under. */
  readonly slug: string;
  /** Nav label. */
  readonly label: string;
  /** Optional nav icon (emoji or short string). */
  readonly icon?: string;
  /** Where it sits in the nav — see `NAV_ORDER`. Defaults to `NAV_ORDER.adminPages`. */
  readonly navOrder?: number;
  /** Roles that may open it. Defaults to the deployment's `editorRoles`, exactly as a Block
   * Kit page's does — one registry, one gate.
   *
   * This is the ONLY authorization a panel gets for free. A panel's own code runs in the
   * browser, so every call it makes is an ordinary RPC under the caller's own identity and
   * ACL; this list decides who is shown the screen, not what the screen may do. */
  readonly roles?: readonly string[];
}

/**
 * Declare a custom admin panel. Spread the result into `createAdminPageHandlers` alongside
 * any `adminPage()`s:
 *
 *   const curation = adminPanel("curation", {
 *     label: "Curation",
 *     icon: "🎛",
 *     navOrder: NAV_ORDER.media + 10,
 *     roles: ["editor", "admin"],
 *   });
 *
 *   handlers = { ...createAdminPageHandlers([desk, curation], { editorRoles }) };
 *
 * The matching component is registered by the deployment's panel bundle — see the
 * "Custom admin panels" section of the CMS docs.
 */
export function adminPanel(slug: string, opts: Omit<AdminPanelDef, "slug" | "kind">): AdminPanelDef {
  return { ...opts, kind: "panel", slug };
}

/** Whether a registry entry is a panel (and so has no server-side render).
 *
 * Reads the discriminant rather than testing for the ABSENCE of `render`: "no render" is
 * also what a malformed page looks like, and `validateAdminPages` has to be able to tell a
 * panel from a page someone forgot to finish. */
export function isAdminPanel(def: { readonly kind?: string }): def is AdminPanelDef {
  return def.kind === "panel";
}
