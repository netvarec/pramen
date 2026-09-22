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

import type { AccountMenuItem, EditorPage, NavContext, NavHooks, NavTransform } from "./slots";
import { EDITOR_PAGES } from "./slots";
import { NAV_ORDER, type AdminPageMeta, type CmsCapabilities, type CollectionMeta, type ContentType } from "./types";

/** A buzola page id, so a nav entry naming a route that does not exist is a compile error
 * rather than a tab that navigates nowhere.
 *
 * `EditorPage` rather than `keyof BuzolaPageMap` directly, because this module's types are
 * part of the public slot contracts (`slots.ts` re-exports `NavEntry`), and the page map only
 * has keys once the generated route table is in the program, which a theme typechecking
 * against us does not have, and should not need. `routes/_layout.tsx` proves the two equal. */
export type NavPage = EditorPage;

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

/** The nav, arranged for a HORIZONTAL bar. */
export interface TopbarNav {
  /** Rendered as flat tabs, left to right. */
  tabs: NavEntry[];
  /** Rendered as dropdown triggers after them, one per remaining section. */
  menus: NavSection[];
}

/**
 * Split the sections into the tabs a bar shows and the menus it folds the rest into.
 *
 * The FIRST section is flat and every later one is a dropdown. That is the whole rule, and
 * it falls out of what the bands already mean: `navSections` orders them Content · Site ·
 * Apps · System, so the flat half is the destinations an editor came here to write and the
 * folded half is the furniture and the administration — the same reason the sidebar ships
 * with Site and System foldable and Content not.
 *
 * It exists because a row is the one shape this nav does NOT fit: twelve destinations at
 * 1280px is a dense unlabelled ribbon over a horizontal scroller, which is the nav the
 * sidebar was built to replace. A dropdown costs a click on the way IN, which is exactly the
 * cost the sidebar's collapsible groups were designed to avoid — but a row has no column to
 * spend instead, so the choice is between paying it and hiding items behind a scroll nobody
 * discovers. Three or four triggers beside the tabs is also the shape the Graphic Standard
 * bar already has (its app switcher is a dropdown in the same nav), so it stays one design.
 *
 * A single section stays entirely flat: there is nothing to fold away from, and one lone
 * dropdown labelled "Content" would hide the whole nav behind a click.
 */
export function topbarNav(sections: NavSection[]): TopbarNav {
  // No special case for the single section: `slice(1)` of a one-element list is already the
  // empty menu list, and of an empty one it is empty twice over.
  return { tabs: sections[0]?.entries ?? [], menus: sections.slice(1) };
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

// --- hooks: a deployment's say over the nav -------------------------------------------------
//
// The nav is DERIVED (from the session's collections, content types, capabilities and role),
// and until now the derivation was the whole story: a deployment that wanted "Events" instead
// of two entries for the same thing, or Users promoted beside the editorial tools, had nothing
// to change but our source. The one that needed it rewrote `chrome-topbar.tsx` at build time
// to run its own function over `sections` just before the bar split them, remapped `active`
// inline beside it, and so had nothing at all for the sidebar.
//
// So the hook sits HERE, upstream of both chromes: `_layout.tsx` applies it once and hands
// the result to whichever chrome is mounted, and the breadcrumb and the account menu read the
// same result. `NavHooks` in `slots.ts` is the contract; `nav-hooks.ts` is the slot that
// carries a theme's implementation into the build.

/**
 * Run a deployment's `transformNav`, and survive it.
 *
 * Survive, because this runs in the root layout's render: a throw there is not a nav that
 * looks wrong, it is a blank admin with no way to reach anything. The editor's own nav is
 * always a correct answer, so a failing or malformed transform falls back to it and says so.
 * Empty sections are dropped here rather than trusted to the hook: the topbar renders a
 * section as a dropdown, and a dropdown with nothing in it is a dead control.
 */
export function applyNavTransform(hooks: NavHooks, context: NavContext): NavTransform {
  const fallback = { sections: context.sections, active: context.active };
  if (!hooks.transformNav) return fallback;
  try {
    const out = hooks.transformNav(context);
    if (!out || !Array.isArray(out.sections) || typeof out.active !== "string" || !out.sections.every((s) => s && Array.isArray(s.entries))) {
      console.error("pramen/cms-editor: `transformNav` must return `{ sections, active }`; rendering the nav untransformed.", out);
      return fallback;
    }
    return { sections: out.sections.filter((s) => s.entries.length > 0), active: out.active };
  } catch (e) {
    console.error("pramen/cms-editor: `transformNav` threw; rendering the nav untransformed.", e);
    return fallback;
  }
}

/** The account-menu rows this session sees, in order: runtime config first, then the theme's.
 *
 * `requiresNav` is checked against the nav the editor BUILT, not the transformed one, and that
 * is the point of it: the common case is a theme that hides an entry from the nav and moves it
 * into this menu (Types -> "Content structure"), and checked after the transform the row would
 * hide itself along with the entry it replaced. The nav's keys are already the capability
 * answers (`types` exists only for a session that may author the schema, `users` only for an
 * admin), so a row gated on one cannot offer a screen the session would be refused. */
export function accountMenuFor(items: readonly AccountMenuItem[], context: NavContext): AccountMenuItem[] {
  const keys = new Set(context.sections.flatMap((s) => s.entries.map((e) => e.key)));
  return items.filter((item) => {
    if (item.requiresNav !== undefined && !keys.has(item.requiresNav)) return false;
    if (!item.visible) return true;
    try {
      return item.visible(context) === true;
    } catch (e) {
      console.error(`pramen/cms-editor: the \`visible\` of account-menu item "${item.label}" threw; hiding it.`, e);
      return false;
    }
  });
}

const PAGES: ReadonlySet<string> = new Set(EDITOR_PAGES);
const GLYPHS: ReadonlySet<string> = new Set<NavGlyph>(["pages", "collection", "media", "menus", "taxonomies", "widgets", "redirects", "app", "types", "users", "settings", "link"]);

/**
 * Parse `accountMenu` from the shell's runtime config.
 *
 * Same rule as `resolveLayout` and `resolveBrand`: this is JSON a person typed into an Astro
 * config, read at module load with no error boundary above it, so nothing here may throw. A
 * row naming a page that does not exist is DROPPED with a warning rather than rendered: a
 * menu item that navigates nowhere is worse than a missing one, because it looks like it works.
 * `visible` is not accepted here: JSON cannot carry a function, and `requiresNav` is the
 * declarative form of the same question.
 */
export function resolveAccountMenu(value: unknown): AccountMenuItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    console.warn(`pramen/cms-editor: ignoring \`accountMenu\` ${JSON.stringify(value)}; expected an array of { label, page }.`);
    return [];
  }
  const out: AccountMenuItem[] = [];
  for (const raw of value as unknown[]) {
    const row = raw as Record<string, unknown> | null;
    const label = typeof row?.label === "string" ? row.label.trim() : "";
    const page = row?.page;
    if (!label || typeof page !== "string" || !PAGES.has(page)) {
      console.warn(`pramen/cms-editor: ignoring account-menu item ${JSON.stringify(raw)}; it needs a \`label\` and a \`page\` that is one of ${EDITOR_PAGES.join(", ")}.`);
      continue;
    }
    const item: AccountMenuItem = { label, page: page as EditorPage };
    const params = row?.params;
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const clean = Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string");
      if (clean.length > 0) item.params = Object.fromEntries(clean);
    }
    if (typeof row?.icon === "string" && GLYPHS.has(row.icon)) item.icon = row.icon as NavGlyph;
    if (typeof row?.requiresNav === "string" && row.requiresNav.trim()) item.requiresNav = row.requiresNav.trim();
    out.push(item);
  }
  return out;
}

/** The global the host's shell writes. Structural, like `LayoutHost`, so a test can hand it a
 * plain object. */
export interface AccountMenuHost {
  PRAMEN_CMS_EDITOR?: { accountMenu?: unknown };
}

/** Pull the account-menu config off a host global, tolerating its absence. */
export function readAccountMenuConfig(host: AccountMenuHost | undefined): unknown {
  return host?.PRAMEN_CMS_EDITOR?.accountMenu;
}
