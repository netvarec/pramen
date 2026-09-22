// Root layout: the persistent chrome wrapped around every route via <Outlet />. The active
// section is derived from the current path, so a deep link or refresh lands with the right
// item lit.
//
// This module DERIVES; it does not draw. Two chromes render the same nav — the default
// sidebar rail (`chrome-sidebar.tsx`) and the Graphic Standard topbar (`chrome-topbar.tsx`),
// chosen per deployment by `CHROME_LAYOUT` — and both are handed the same props
// (`ChromeProps` in `chrome-shared.tsx`): the grouped nav, what is lit, the breadcrumb, and
// callbacks that are already wrapped in the unsaved-changes guard.
//
// The split is what keeps the two from drifting. Deciding where a nav entry goes, what it
// lights and what happens when it is clicked is subtle and shared (the order rule in
// `nav.ts`, the percent-decoding in `segmentAt`, the guard on every way out, the same-tab
// containment rules in `mount.ts`); the difference between the chromes is markup. Adding a
// third shape means writing a component, not re-deriving state.

import { Outlet, useNavigate, useRoute, useRouter, type BuzolaPageMap } from "@buzola/router";
import { useState } from "react";
import { useApp } from "../app-context";
import { BreadcrumbProvider } from "../breadcrumb";
import { CHROME_LAYOUT } from "../chrome";
import { ErrorBanner, SidebarChrome } from "../chrome-sidebar";
import { TopbarChrome } from "../chrome-topbar";
import type { AccountMenuEntry, ChromeProps, NavRoute } from "../chrome-shared";
import { pagesHidden, splitsByType } from "../components";
import { opensInSameTab } from "../mount";
import { setTheme, useTheme } from "../theme";
import { accountMenuFor, applyNavTransform, buildNav, navSections, navSectionsAreLabelled, readAccountMenuConfig, resolveAccountMenu, type AccountMenuHost, type ExtraNavLink } from "../nav";
import { navHooks } from "../nav-hooks";
import type { EditorPage, NavContext } from "../slots";

/** `EditorPage` (the public contract's list of screens, in `slots.ts`) and the router's own
 * page map must be the same set, in BOTH directions: a page missing from the contract cannot
 * be named by a theme, and a page in the contract that the router lacks is an account-menu
 * row that navigates nowhere. Written out there so a theme's typecheck needs no route table;
 * proved here, where the route table is in the program, so the two cannot drift. */
type Assert<T extends true> = T;
export type EditorPagesMatchRouter = Assert<
  [EditorPage] extends [keyof BuzolaPageMap] ? ([keyof BuzolaPageMap] extends [EditorPage] ? true : false) : false
>;

/** Account-menu rows from the shell's runtime config, resolved once per page load like
 * `CHROME_LAYOUT`. A theme's rows (`navHooks.accountMenu`) follow them. */
const CONFIGURED_ACCOUNT_MENU = resolveAccountMenu(readAccountMenuConfig(globalThis as AccountMenuHost));

/**
 * The slug segment under `prefix`, DECODED.
 *
 * `useRoute().pathname` comes off a `URL`, so it is percent-encoded; the slugs it is compared
 * against are the raw values the server stored. buzola encodes when it builds an href and
 * decodes into `params` when it matches, so routing is unaffected — only this comparison was,
 * and a content type called `články` navigated correctly to a nav with nothing lit.
 *
 * A malformed sequence (`%zz`) throws in `decodeURIComponent`; that cannot match any slug
 * either way, so it degrades to no highlight rather than tearing down the chrome.
 */
export function segmentAt(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const raw = pathname.slice(prefix.length).split("/")[0];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default function RootLayout() {
  const { isAdmin, me, collections, adminPages, contentTypes, cms, error, reconfigure, confirmNavigation } = useApp();
  const navigate = useNavigate();
  const { pathname } = useRoute();

  // Every chrome action is a way OUT of the current screen, so it runs through that screen's
  // unsaved-changes guard first (the page editor registers one; with no guard registered
  // this is a pass-through). In-app navigation fires no `beforeunload`, so without this the
  // chrome silently discards unsaved edits. An `extraNav` link that opens a NEW tab leaves
  // this document alone and needs no guard; one honoured as `_self` is a real cross-document
  // navigation, so it takes the guard too (in the chrome, which owns the anchor).
  // `beforeunload` is not a fallback for it — only `PageEditor` registers one, so a dirty
  // CollectionEditor form would otherwise be discarded with no prompt of any kind.
  // Returns whether it went, which a chrome that dismisses itself on click needs — see the
  // note on `ChromeProps`.
  const guarded = (go: () => void) => (): boolean => {
    if (!confirmNavigation()) return false;
    go();
    return true;
  };

  // Dark mode. The choice lives in `theme.ts` rather than here: podoba's tokens flip under
  // `[data-theme="dark"]` on the document root, `main.tsx` applies the stored one before the
  // first paint, and a PANEL is handed the same value — three readers, so one store.
  const theme = useTheme();

  // The active collection slug, if we're under /collections/:slug(/...).
  const collectionSlug = segmentAt(pathname, "/collections/");
  // …and the active content type, under /types/:slug.
  const typeSlug = segmentAt(pathname, "/types/");
  // …and the active Block Kit page, under /apps/:slug.
  const appSlug = segmentAt(pathname, "/apps/");

  // "Pages" stays lit while editing a page (/pages/:id) too — but only on a deployment that
  // still HAS a pooled Pages entry. Split by type, the page editor lights nothing: the route
  // carries a page id and nothing else, so which type's entry to light isn't knowable here
  // without fetching the page the editor is already fetching.
  const active = collectionSlug ? `col:${collectionSlug}`
    : typeSlug ? `type:${typeSlug}`
    : appSlug ? `app:${appSlug}`
    : pathname.startsWith("/pages") || pathname === "/" ? "pages"
    : pathname.startsWith("/media") ? "media"
    // `/schema` rather than `/types`, because `/types/:slug` is already one content type's
    // PAGE LIST — a different thing entirely, and the entry keyed `type:<slug>` above.
    : pathname.startsWith("/schema") ? "types"
    : pathname.startsWith("/menus") ? "menus"
    : pathname.startsWith("/taxonomies") ? "taxonomies"
    : pathname.startsWith("/widgets") ? "widgets"
    : pathname.startsWith("/redirects") ? "redirects"
    : pathname.startsWith("/users") ? "users"
    : pathname.startsWith("/settings") ? "settings"
    : "";

  // Host-configured links to companion tools (e.g. a curation page), from the shell.
  const extraNav: ExtraNavLink[] = typeof window !== "undefined" ? window.PRAMEN_CMS_EDITOR?.extraNav ?? [] : [];
  // Collections-only deployments hide the block/page builder entirely.
  const hidePages = pagesHidden();
  // Same rule as the landing redirect and the page editor's back target — see `splitsByType`.
  const splitByType = splitsByType(contentTypes, cms, hidePages);
  const nav = buildNav({ collections, adminPages, contentTypes, cms, hidePages, splitByType, isAdmin, extraNav });
  // A deployment's say over the nav (`slots.nav`, see `nav-hooks.ts`), applied HERE so both
  // chromes, the breadcrumb and the account menu all read the one transformed answer. The
  // context is the nav as built, which is also what `requiresNav` is checked against.
  const navContext: NavContext = { sections: navSections(nav), active, isAdmin, me };
  const { sections, active: lit } = applyNavTransform(navHooks, navContext);
  const labelled = navSectionsAreLabelled(sections);
  // The section half of the breadcrumb, and the way back to its list. Taken from the entry
  // that is LIT rather than re-derived from the path: the nav already answered "where am I",
  // and a second answer computed differently is a second answer that can disagree. Looked up
  // in the TRANSFORMED nav, so a renamed entry is named by its new label and a remapped
  // highlight brings its crumb with it.
  const activeEntry = sections.flatMap((s) => s.entries).find((e) => e.key === lit);
  const sectionCrumb: NavRoute | undefined = activeEntry?.kind === "route" ? activeEntry : undefined;
  // …and the detail half, published by whatever screen is mounted (see `breadcrumb.tsx`).
  const [crumb, setCrumb] = useState<string | null>(null);

  // See `opensInSameTab`. The rules live in `mount.ts` beside the containment they depend
  // on; what this supplies is the URL the BROWSER will resolve a relative href against — the
  // current document, not the origin. Empty when there is no `window`, which makes every
  // href unparseable and so degrades to the safe new-tab default.
  const basePath = useRouter().basePath;
  const documentUrl = typeof window !== "undefined" ? window.location.href : "";

  /** Navigate to a nav entry, through the guard. Not inlined into `chrome` below because
   * buzola's `navigate` is typed off the generated page map and an entry's `page`/`params`
   * are the untyped halves of a runtime-built list — the casts belong in one place. */
  const onGo = (entry: NavRoute): boolean =>
    guarded(() => navigate(entry.page as never, entry.params ? ({ params: entry.params } as never) : (undefined as never)))();

  // The deployment's account-menu rows, filtered for this session and made into guarded
  // navigations, so a chrome renders them without knowing what any of them is.
  const accountItems: AccountMenuEntry[] = accountMenuFor([...CONFIGURED_ACCOUNT_MENU, ...(navHooks.accountMenu ?? [])], navContext).map((item, i) => ({
    id: `extra:${i}`,
    label: item.label,
    ...(item.icon ? { icon: item.icon } : {}),
    onSelect: guarded(() => navigate(item.page as never, item.params ? ({ params: item.params } as never) : (undefined as never))),
  }));

  const chrome: ChromeProps = {
    sections,
    labelled,
    active: lit,
    sectionCrumb,
    crumb,
    me,
    theme,
    onTheme: () => setTheme(theme === "dark" ? "light" : "dark"),
    onSettings: guarded(() => navigate("settings")),
    onSignOut: guarded(reconfigure),
    onHome: guarded(() => navigate("home")),
    accountItems,
    onGo,
    sameTab: (link) => opensInSameTab(link.href, link.target, basePath, documentUrl),
    confirmNavigation,
    children: (
      <>
        {error ? <ErrorBanner error={error} /> : null}
        <BreadcrumbProvider publish={setCrumb}>
          <Outlet />
        </BreadcrumbProvider>
      </>
    ),
  };

  // The metrics every sticky offset below the chrome is measured against come from `app.css`,
  // keyed off the root attribute `main.tsx` writes; see `chrome.ts`.
  return CHROME_LAYOUT === "topbar" ? <TopbarChrome {...chrome} /> : <SidebarChrome {...chrome} />;
}
