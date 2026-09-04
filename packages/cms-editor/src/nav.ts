// The primary nav, as data.
//
// It used to be a fixed sequence written out in JSX: Pages, collections, Media, Users,
// Settings, then `extraNav`. That order was the whole reason a project-specific section
// could not be part of the admin — `extraNav` renders dead LAST and (by default, and for
// good reason) opens a new tab, so anything not backed by a `collection()` was structurally
// the final item and structurally a different app.
//
// So the nav is built as a list of entries carrying an ORDER, and sorted. `NAV_ORDER` gives
// the built-ins positions spaced 100 apart, a collection declares `navOrder` server-side,
// and a host `extraNav` link may declare one too — which is what lets a section sit between
// Pages and Media instead of after Settings.
//
// Split out of `_layout.tsx` so the ordering rule is testable without a DOM: the layout
// turns entries into buttons, this decides what they are and what order they come in.

import type { BuzolaPageMap } from "@buzola/router";
import { NAV_ORDER, type AdminPageMeta, type CmsCapabilities, type CollectionMeta, type ContentType } from "./types";

/** A buzola page id. Typed off the generated page map, so a nav entry naming a route that
 * does not exist is a compile error rather than a tab that navigates nowhere. */
export type NavPage = keyof BuzolaPageMap;

/** A host-configured link to a companion tool. */
export interface ExtraNavLink {
  label: string;
  href: string;
  target?: "_blank" | "_self";
  /** Where it sits — see {@link NAV_ORDER}. Defaults to `NAV_ORDER.extra` (last), which is
   * where every `extraNav` link rendered before this existed. */
  order?: number;
}

/** The glyphs the sidebar can draw, by NAME.
 *
 * A name, not a component: this module is a pure function of the session's facts and is
 * tested without a DOM, so it must not import JSX. `NAV_GLYPHS` in `icons.tsx` maps each
 * name to the drawing, and because this is a closed union a glyph added here without a
 * drawing is a compile error rather than a blank square in the nav. */
export type NavGlyph =
  | "pages"
  | "collection"
  | "media"
  | "menus"
  | "taxonomies"
  | "widgets"
  | "redirects"
  | "app"
  | "types"
  | "users"
  | "settings"
  | "link";

/** What sits in an entry's icon slot.
 *
 * Two cases because a collection and a Block Kit page may declare their OWN icon
 * server-side, and that is an arbitrary string (an emoji, in practice). It used to be
 * prepended to the label — which read as part of the words, wrapped with them, and could
 * not be aligned with anything. In a sidebar the icon is a column, so a declared emoji goes
 * in that column and the built-in glyph is the fallback. */
export type NavIcon = { kind: "glyph"; name: NavGlyph } | { kind: "emoji"; char: string };

/** A server-declared icon if there is one, else the section's own glyph. */
function iconFor(declared: string | undefined, fallback: NavGlyph): NavIcon {
  const char = declared?.trim();
  return char ? { kind: "emoji", char } : { kind: "glyph", name: fallback };
}

/** One entry in the primary nav.
 *
 * `kind` is what the layout switches on to render it; everything else here is the data it
 * needs. Keeping the ROUTE out of this module is deliberate — `page`/`params` name a
 * buzola page, and the layout is where navigation (and the unsaved-changes guard it runs
 * through) belongs. */
export type NavEntry =
  | { kind: "route"; key: string; order: number; icon: NavIcon; label: string; page: NavPage; params?: Record<string, string> }
  | { kind: "link"; key: string; order: number; icon: NavIcon; link: ExtraNavLink };

/** What the nav is built from. All of it is already in the app context; passing it in keeps
 * this a pure function of the session's facts. */
export interface NavInput {
  collections: CollectionMeta[];
  /** Block Kit pages this caller may open — already role-filtered by the server. */
  adminPages: AdminPageMeta[];
  contentTypes: ContentType[] | null;
  cms: CmsCapabilities;
  /** Deployment hides the block/page builder entirely (`hidePages`). */
  hidePages: boolean;
  /** One tab per content type rather than a single pooled "Pages" tab. */
  splitByType: boolean;
  isAdmin: boolean;
  extraNav: ExtraNavLink[];
}

/**
 * Build the primary nav, in order.
 *
 * The sort is STABLE (`Array.prototype.sort` is, per spec, since ES2019), which is what
 * carries the two groupings that have no numeric expression: content-type tabs stay in the
 * server's order among themselves, and so do collections that share a `navOrder`. Ties are
 * therefore declaration order, which is the only answer a host can predict.
 */
export function buildNav(input: NavInput): NavEntry[] {
  const { collections, adminPages, contentTypes, cms, hidePages, splitByType, isAdmin, extraNav } = input;
  const entries: NavEntry[] = [];

  if (!hidePages) {
    if (splitByType) {
      // One tab per content type: a CMS holding pages AND articles pooled them into a
      // single list where the only thing telling a landing page from a news item was the
      // slug. The label is the type's own `name`, so a host that wants a plural tab writes
      // one.
      for (const t of contentTypes ?? []) {
        entries.push({ kind: "route", key: `type:${t.slug}`, order: NAV_ORDER.pages, icon: { kind: "glyph", name: "pages" }, label: t.name, page: "type", params: { slug: t.slug } });
      }
    } else {
      entries.push({ kind: "route", key: "pages", order: NAV_ORDER.pages, icon: { kind: "glyph", name: "pages" }, label: "Pages", page: "home" });
    }
  }

  for (const c of collections) {
    entries.push({
      kind: "route",
      key: `col:${c.slug}`,
      order: c.navOrder ?? NAV_ORDER.collections,
      icon: iconFor(c.icon, "collection"),
      label: c.pluralLabel,
      page: "collection",
      params: { slug: c.slug },
    });
  }

  entries.push({ kind: "route", key: "media", order: NAV_ORDER.media, icon: { kind: "glyph", name: "media" }, label: "Media", page: "media" });

  if (cms.siteFurniture) {
    entries.push({ kind: "route", key: "menus", order: NAV_ORDER.menus, icon: { kind: "glyph", name: "menus" }, label: "Menus", page: "menus" });
    // Taxonomies classify PAGES — `cms_page_terms` links a term to a page and to nothing
    // else — so a collections-only deployment has nothing to classify and the section would
    // be a vocabulary editor with no subject.
    if (!hidePages) entries.push({ kind: "route", key: "taxonomies", order: NAV_ORDER.taxonomies, icon: { kind: "glyph", name: "taxonomies" }, label: "Taxonomies", page: "taxonomies" });
    entries.push({ kind: "route", key: "widgets", order: NAV_ORDER.widgets, icon: { kind: "glyph", name: "widgets" }, label: "Widgets", page: "widgets" });
    entries.push({ kind: "route", key: "redirects", order: NAV_ORDER.redirects, icon: { kind: "glyph", name: "redirects" }, label: "Redirects", page: "redirects" });
  }

  // A project's own screens, INSIDE the chrome and at a position they choose. This is the
  // whole difference from `extraNav`, which renders after Settings and opens a new tab — so
  // the odd 10% of a client site was a separate deployment that looked nothing like the
  // admin it hung off.
  for (const p of adminPages) {
    entries.push({ kind: "route", key: `app:${p.slug}`, order: p.navOrder ?? NAV_ORDER.adminPages, icon: iconFor(p.icon, "app"), label: p.label, page: "admin-page", params: { slug: p.slug } });
  }

  // Authoring the SCHEMA, not content — so it is gated on `canEdit` (every handler behind
  // it is editor-only) and hidden where there is no block/page builder to define types for.
  if (!hidePages && cms.canEdit) {
    entries.push({ kind: "route", key: "types", order: NAV_ORDER.types, icon: { kind: "glyph", name: "types" }, label: "Types", page: "schema" });
  }

  if (isAdmin) entries.push({ kind: "route", key: "users", order: NAV_ORDER.users, icon: { kind: "glyph", name: "users" }, label: "Users", page: "users" });
  entries.push({ kind: "route", key: "settings", order: NAV_ORDER.settings, icon: { kind: "glyph", name: "settings" }, label: "Settings", page: "settings" });

  for (const link of extraNav) {
    // Keyed on href AND label: two entries may legitimately point at the same href and
    // differ only in label or target, and keyed on href alone React reconciles them
    // together — the rendered label can end up on the other one's anchor.
    entries.push({ kind: "link", key: `extra:${link.href}|${link.label}`, order: link.order ?? NAV_ORDER.extra, icon: { kind: "glyph", name: "link" }, link });
  }

  return entries.sort((a, b) => a.order - b.order);
}

// --- sections ---------------------------------------------------------------------------
//
// Twelve items in one flat list is the thing that stopped being legible — it overran the
// topbar, and a sidebar alone only turns a crowded row into a long column. So the nav is
// GROUPED. Grouping rather than hiding: everything a session may reach stays one click away
// (a submenu costs a click and hides the thing being looked for), and the headings answer
// "where would I look for this" instead of making the reader scan twelve equal rows.
//
// A section is a BAND OF `order`, not a hand-written list of keys. That keeps the one
// contract this module has — position is a number a host sets (`navOrder` on a collection
// or an admin page, `order` on an `extraNav` link) — the single thing that decides where an
// entry appears. A host placing a section at 250 lands in Content, at 450 in Site, exactly
// as the number reads. Enumerating keys instead would have made a host-placed entry land
// visually inside a group it was not a member of.

/** A group of nav entries, in order. */
export type NavSectionId = "content" | "site" | "apps" | "system";

export interface NavSection {
  id: NavSectionId;
  /** The heading. Rendered only when there is more than one section — see `navSections`. */
  label: string;
  entries: NavEntry[];
}

/** The bands, in order. `upTo` is EXCLUSIVE, and each is expressed against `NAV_ORDER`
 * rather than a literal so the two cannot drift: a built-in moving to a new position moves
 * with its band. */
const BANDS: readonly { id: NavSectionId; label: string; upTo: number }[] = [
  // Pages / content types, collections, media — the things an editor came here to write.
  { id: "content", label: "Content", upTo: NAV_ORDER.menus },
  // Menus, taxonomies, widget areas, redirects — site-level furniture, not page content.
  { id: "site", label: "Site", upTo: NAV_ORDER.adminPages },
  // A project's own Block Kit screens. Their own band rather than a tail of "System",
  // because they are the project's, and the whole point of `adminPage()` is that they are
  // not administration of the CMS.
  { id: "apps", label: "Apps", upTo: NAV_ORDER.types },
  // Types, users, settings, and host links to companion tools.
  { id: "system", label: "System", upTo: Number.POSITIVE_INFINITY },
];

/** Every section id, in rail order. Derived from `BANDS` rather than written out again, so
 * a new group cannot exist in the layout's eyes but not in the reader's stored folds (or the
 * reverse). It is what makes a persisted fold PARSEABLE: a value read back out of
 * localStorage is checked against this, so a stale id from an older version — or anything a
 * hand-edit put there — is dropped rather than carried into state as "some string". */
export const NAV_SECTION_IDS: readonly NavSectionId[] = BANDS.map((b) => b.id);

/**
 * Group the entries `buildNav` returned, dropping empty sections.
 *
 * Takes the already-ordered list rather than re-deriving it: the order IS the grouping, so
 * a second traversal that could disagree with the first would be a bug waiting to happen.
 * Entries stay in the order they came in, which is what carries the sub-orderings that have
 * no numeric expression (content-type tabs among themselves, collections sharing a
 * `navOrder`).
 */
export function navSections(entries: NavEntry[]): NavSection[] {
  const sections: NavSection[] = BANDS.map((b) => ({ id: b.id, label: b.label, entries: [] }));
  for (const entry of entries) {
    // The last band is unbounded, so `find` always hits; the `??` is for the type checker.
    const i = BANDS.findIndex((b) => entry.order < b.upTo);
    (sections[i === -1 ? sections.length - 1 : i] as NavSection).entries.push(entry);
  }
  return sections.filter((s) => s.entries.length > 0);
}

/**
 * Should the sections be LABELLED?
 *
 * A single heading over the whole nav names nothing — it is a caption on a list with no
 * sibling to distinguish it from — and a collections-only deployment (`hidePages`, no site
 * furniture) genuinely is one group. So the headings appear once there are at least two,
 * and the small deployment keeps a plain list.
 */
export function navSectionsAreLabelled(sections: NavSection[]): boolean {
  return sections.length > 1;
}

/**
 * Is the rail ACTUALLY narrowed?
 *
 * A named function for `choice && wide`, because conflating those two is what broke it. The
 * choice is per-browser and persisted; narrowing is expressed entirely in `md:`-scoped
 * classes, so it only exists at desktop widths. A rail narrowed on a laptop therefore came
 * back "narrowed" on a phone, where every one of those classes is inert — the rows kept their
 * labels and their full width, while the JS gated on the stored choice removed all four group
 * headings, and the hairline that stands in for a heading at 56px is `md:`-only too. One
 * undifferentiated column of a dozen rows, and the toggle that would undo it is
 * `hidden md:inline-flex`: no way back from that viewport.
 *
 * So JS has to agree with the breakpoint rather than ignore it, and everything conditional —
 * headings, folding, the hairline — reads this instead of the stored value.
 */
export function railIsNarrow(choice: boolean, wideViewport: boolean): boolean {
  return choice && wideViewport;
}
