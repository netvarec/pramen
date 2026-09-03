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

/** One entry in the primary nav.
 *
 * `kind` is what the layout switches on to render it; everything else here is the data it
 * needs. Keeping the ROUTE out of this module is deliberate — `page`/`params` name a
 * buzola page, and the layout is where navigation (and the unsaved-changes guard it runs
 * through) belongs. */
export type NavEntry =
  | { kind: "route"; key: string; order: number; label: string; page: NavPage; params?: Record<string, string> }
  | { kind: "link"; key: string; order: number; link: ExtraNavLink };

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
        entries.push({ kind: "route", key: `type:${t.slug}`, order: NAV_ORDER.pages, label: t.name, page: "type", params: { slug: t.slug } });
      }
    } else {
      entries.push({ kind: "route", key: "pages", order: NAV_ORDER.pages, label: "Pages", page: "home" });
    }
  }

  for (const c of collections) {
    entries.push({
      kind: "route",
      key: `col:${c.slug}`,
      order: c.navOrder ?? NAV_ORDER.collections,
      label: `${c.icon ? `${c.icon} ` : ""}${c.pluralLabel}`,
      page: "collection",
      params: { slug: c.slug },
    });
  }

  entries.push({ kind: "route", key: "media", order: NAV_ORDER.media, label: "Media", page: "media" });

  if (cms.siteFurniture) {
    entries.push({ kind: "route", key: "menus", order: NAV_ORDER.menus, label: "Menus", page: "menus" });
    // Taxonomies classify PAGES — `cms_page_terms` links a term to a page and to nothing
    // else — so a collections-only deployment has nothing to classify and the section would
    // be a vocabulary editor with no subject.
    if (!hidePages) entries.push({ kind: "route", key: "taxonomies", order: NAV_ORDER.taxonomies, label: "Taxonomies", page: "taxonomies" });
    entries.push({ kind: "route", key: "widgets", order: NAV_ORDER.widgets, label: "Widgets", page: "widgets" });
    entries.push({ kind: "route", key: "redirects", order: NAV_ORDER.redirects, label: "Redirects", page: "redirects" });
  }

  // A project's own screens, INSIDE the chrome and at a position they choose. This is the
  // whole difference from `extraNav`, which renders after Settings and opens a new tab — so
  // the odd 10% of a client site was a separate deployment that looked nothing like the
  // admin it hung off.
  for (const p of adminPages) {
    entries.push({ kind: "route", key: `app:${p.slug}`, order: p.navOrder ?? NAV_ORDER.adminPages, label: `${p.icon ? `${p.icon} ` : ""}${p.label}`, page: "admin-page", params: { slug: p.slug } });
  }

  // Authoring the SCHEMA, not content — so it is gated on `canEdit` (every handler behind
  // it is editor-only) and hidden where there is no block/page builder to define types for.
  if (!hidePages && cms.canEdit) {
    entries.push({ kind: "route", key: "types", order: NAV_ORDER.types, label: "Types", page: "schema" });
  }

  if (isAdmin) entries.push({ kind: "route", key: "users", order: NAV_ORDER.users, label: "Users", page: "users" });
  entries.push({ kind: "route", key: "settings", order: NAV_ORDER.settings, label: "Settings", page: "settings" });

  for (const link of extraNav) {
    // Keyed on href AND label: two entries may legitimately point at the same href and
    // differ only in label or target, and keyed on href alone React reconciles them
    // together — the rendered label can end up on the other one's anchor.
    entries.push({ kind: "link", key: `extra:${link.href}|${link.label}`, order: link.order ?? NAV_ORDER.extra, link });
  }

  return entries.sort((a, b) => a.order - b.order);
}
