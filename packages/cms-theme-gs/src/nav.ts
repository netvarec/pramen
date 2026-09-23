// `slots.nav`: the Graphic Standard's navigation, as hooks a project can wrap.
//
// GS's topbar carries what an editor came to do, and nothing about running the CMS:
//
// - `types` (the schema editor) and `settings` (your account) leave the nav. Settings is
//   already in the account menu; the schema editor moves there as "Content structure", offered
//   to exactly the sessions whose nav had the `types` entry (`requiresNav`, checked against the
//   nav as the editor BUILT it, so hiding the entry does not hide the row that replaces it).
// - Users, for an administrator, is promoted into the FIRST group beside the editorial tools,
//   rather than sitting alone in "System" behind a dropdown.
// - A group left with no entries is dropped, so the topbar never renders a dead dropdown.
//
// Everything else keeps the editor's order and labels. The labels already arrive in the
// editor's language, so unlike the project this was lifted from, nothing here renames.
//
// COMPOSABLE. A slot module exports one `navHooks`, so a project with nav rules of its own
// (hide a content type that a custom panel replaces, rename a panel) writes its own module and
// runs the GS transform after its own step:
//
//   // src/admin/nav.ts
//   import type { NavHooks } from "@pramen/cms-editor/slots";
//   import { composeNav, gsNavHooks, gsTransformNav } from "@pramen/cms-theme-gs/nav";
//   export const navHooks: NavHooks = { ...gsNavHooks, transformNav: composeNav(myStep, gsTransformNav) };
//
// and hands that file to `gsEditor({ slots: { nav } })`.

import type { AccountMenuItem, NavContext, NavHooks, NavSection, NavTransform } from "@pramen/cms-editor/slots";
import { defineMessages } from "@pramen/cms-editor/i18n";

const copy = defineMessages({
  en: { structure: "Content structure" },
  cs: { structure: "Struktura obsahu" },
});

/** Nav keys GS keeps out of the bar. Both stay reachable from the account menu. */
export const GS_HIDDEN_NAV_KEYS: readonly string[] = ["types", "settings"];

/** One step of a nav transform: the editor's `transformNav` signature. */
export type NavStep = (context: NavContext) => NavTransform;

/** GS's nav: see the top of this file. Pure, and returns new objects. */
export function gsTransformNav({ sections, active }: NavContext): NavTransform {
  const kept: NavSection[] = sections.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) => !GS_HIDDEN_NAV_KEYS.includes(entry.key)),
  }));
  // Users moves to the end of the first group. Order inside every group is otherwise the
  // editor's (and so the server's `navOrder`).
  const users = kept.flatMap((section) => section.entries.filter((entry) => entry.key === "users"));
  const withoutUsers = kept.map((section) => ({ ...section, entries: section.entries.filter((entry) => entry.key !== "users") }));
  const first = withoutUsers[0];
  if (users.length > 0 && first) first.entries = [...first.entries, ...users];
  return { sections: withoutUsers.filter((section) => section.entries.length > 0), active };
}

/**
 * Run several nav steps in order, each seeing the previous one's sections and highlight.
 *
 * `isAdmin` and `me` pass through unchanged. Note that every step after the first sees the
 * TRANSFORMED nav, while `requiresNav` on an account-menu row is always checked against the nav
 * as the editor built it; that is the editor's rule, not this function's.
 */
export function composeNav(...steps: NavStep[]): NavStep {
  return (context) => {
    let current: NavTransform = { sections: context.sections, active: context.active };
    for (const step of steps) current = step({ ...context, ...current });
    return current;
  };
}

/** The account-menu row that replaces the hidden `types` entry. A function, so the label is read
 * in the editor's language when the menu is built rather than when this module loads. */
export function gsAccountMenu(): AccountMenuItem[] {
  return [{ label: copy.t("structure"), page: "schema", icon: "types", requiresNav: "types" }];
}

/**
 * The hooks as the theme ships them. `accountMenu` is a getter for the reason `gsAccountMenu`
 * is a function; spreading this object (`{ ...gsNavHooks, transformNav }`) reads it once, at
 * the spread, which in a slot module is when the editor's bundle runs and the language is
 * already configured.
 */
export const gsNavHooks: NavHooks = {
  transformNav: gsTransformNav,
  get accountMenu() {
    return gsAccountMenu();
  },
};

/** The name `slots.nav` imports. */
export const navHooks: NavHooks = gsNavHooks;
