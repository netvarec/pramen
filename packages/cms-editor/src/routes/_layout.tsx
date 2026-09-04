// Root layout: the persistent chrome (sidebar nav + global error banner) wrapped around
// every route via <Outlet />. The active section is derived from the current path, so a deep
// link or refresh lands with the right item lit.
//
// The nav is a SIDEBAR, not the topbar row it used to be. The podoba/Graphic Standard topbar
// is a brand-left / few-tabs-right bar, and this admin outgrew it: Pages, one tab per
// content type, N collections, Media, Menus, Taxonomies, Widgets, Redirects, Apps, Types,
// Users, Settings and any host links is a dozen-plus destinations, which on a 1280px screen
// left the tabs a dense unlabelled ribbon and below that a horizontal scroller — a nav whose
// items you have to scroll to discover. A column has room for all of them AT ONCE, plus an
// icon per row and headings that group them (see `navSections`), which is the same
// information in a shape that can be scanned rather than read.
//
// It is shaped like NOTION's rail, which is the shape this kind of nav has converged on and
// the one an editor already knows how to read:
//
//   - a GROUND of its own — the rail is `surface-card`, the content `surface` — so the two
//     regions separate without a rule between them. In DARK the two tokens are the same
//     colour by design (podoba flattens the card onto the surface), so there the hairline
//     does the separating; that is why the border is unconditional and the tone is not.
//   - DENSE rows: 13px label, 15px icon, ~26px tall. The rail is a list to scan, not a strip
//     of buttons to aim at, and the podoba pill (`rounded-full`, `py-2`) is the latter.
//   - COLLAPSIBLE groups. This is the "hide some of it in a submenu" answer, without the
//     click a submenu costs on the way IN: everything is one click away by default, and a
//     deployment that never touches Site or System folds them away for good (persisted).
//
// Everything else stays podoba: rows are still `Button variant="ghost"`, the type is
// `text-compact`, and every colour is a token (`surface-card` / `surface-muted` / `fg-muted`
// / `border`). What changed is the chrome's LAYOUT and DENSITY, not the design system.

import { Outlet, useNavigate, useRoute, useRouter } from "@buzola/router";
import { Avatar, Button, Card, Text, UserMenu, UserMenuItem } from "@podoba/react";
import { useEffect, useState, type ReactNode } from "react";
import { useApp, type Me } from "../app-context";
import { BreadcrumbProvider } from "../breadcrumb";
import { BRAND } from "../brand";
import { GroupFoldedIcon as CrumbSeparatorIcon } from "../icons";
import { pagesHidden, splitsByType } from "../components";
import { APP_BAR_H } from "../chrome";
import { DarkThemeIcon, GroupFoldedIcon, GroupOpenIcon, LightThemeIcon, MenuToggleIcon, NAV_GLYPHS, RailToggleIcon, SettingsIcon, SignOutIcon } from "../icons";
import { opensInSameTab } from "../mount";
import { buildNav, NAV_SECTION_IDS, navSections, navSectionsAreLabelled, railIsNarrow, type ExtraNavLink, type NavIcon, type NavSectionId } from "../nav";

const THEME_KEY = "pramen.cms.theme";
/** Which nav groups this browser has folded away. Per-browser, like the theme — it is a
 * reading preference, not deployment configuration, and nothing server-side should carry it. */
const COLLAPSED_KEY = "pramen.cms.nav.collapsed";
/** …and whether the whole rail is down to icons. Same reasoning, separate key: folding a
 * group and narrowing the rail are different decisions and a reader makes them separately. */
const RAIL_KEY = "pramen.cms.nav.rail";

/** Tailwind's `md`. The rail's narrow state is expressed entirely in `md:`-scoped classes, so
 * JS has to agree with the same number or the two describe different rails. */
const RAIL_BREAKPOINT = "(min-width: 48rem)";

/**
 * Whether a media query matches, kept in sync as the viewport changes.
 *
 * SSR-safe and paranoid about the API: `matchMedia` is absent in a non-browser render and has
 * been present-but-partial (no `addEventListener`, only the deprecated `addListener`) in
 * browsers this editor still meets. Defaults to TRUE, which is the desktop reading — the same
 * direction the layout already fails in, and the one where every control is on screen.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    try {
      return globalThis.matchMedia?.(query).matches ?? true;
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const mql = globalThis.matchMedia?.(query);
    if (!mql) return;
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

/** Whether this browser last left the rail narrowed.
 *
 * `try`/`catch` and no `typeof` guard, matching `readCollapsed` below: referencing an absent
 * `localStorage` throws a ReferenceError the catch already handles, and the catch additionally
 * covers the case a `typeof` check cannot — a browser that HAS the object and throws on access
 * (a private window with site data blocked). One shape for both readers. */
function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === "narrow";
  } catch {
    return false;
  }
}

/** The folded groups, tolerating every shape localStorage can be in (absent, another
 * version's value, hand-edited, a private window that throws on read). A bad value costs an
 * expanded rail, which is the state the reader can always fix.
 *
 * The read is a PARSE against the closed set of section ids, not a cast: it walks
 * `NAV_SECTION_IDS` and keeps the ones the stored array mentions, so the result is section
 * ids by construction and a stale or invented id simply is not in it. */
function readCollapsed(): NavSectionId[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? NAV_SECTION_IDS.filter((id) => parsed.includes(id)) : [];
  } catch {
    return [];
  }
}

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

  // Every chrome action here is a way OUT of the current screen, so it runs through that
  // screen's unsaved-changes guard first (the page editor registers one; with no guard
  // registered this is a pass-through). In-app navigation fires no `beforeunload`, so
  // without this the chrome silently discards unsaved edits. An `extraNav` link that opens a
  // NEW tab leaves this document alone and needs no guard; one honoured as `_self` is a real
  // cross-document navigation, so it takes the guard too (below). `beforeunload` is not a
  // fallback for it — only `PageEditor` registers one, so a dirty CollectionEditor form would
  // otherwise be discarded with no prompt of any kind.
  const guarded = (go: () => void) => () => { if (confirmNavigation()) go(); };

  // Dark mode: podoba tokens flip under `[data-theme="dark"]` — no `dark:` prefixes.
  const [theme, setTheme] = useState(() => (typeof localStorage !== "undefined" ? localStorage.getItem(THEME_KEY) ?? "light" : "light"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Below `md` the rail collapses to a disclosure under the brand row. A DISCLOSURE, not an
  // overlay drawer: an overlay owes the reader a focus trap, a restore and an Esc handler,
  // and the pieces to do that properly (react-aria's ModalOverlay) are podoba's dependency,
  // not ours — a hand-rolled one would be a modal that keyboard focus walks straight out of.
  // In the flow it is just a `<nav>` that is there or not.
  const [menuOpen, setMenuOpen] = useState(false);
  // Navigating is what a nav is for, so arriving somewhere closes it. Keyed on the path
  // rather than on each item's handler so an in-page link, the brand button and the back
  // button all close it too.
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  // Folded groups, remembered. A deployment where nobody touches Site or System should not
  // have to re-fold them every morning, and the state is small enough to keep as a list of
  // ids — the sections are named, so an id that no longer exists simply matches nothing.
  const [collapsed, setCollapsed] = useState<NavSectionId[]>(() => (typeof localStorage === "undefined" ? [] : readCollapsed()));
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch {
      // A private window that refuses writes costs the memory of the fold, nothing else.
    }
  }, [collapsed]);
  const toggleSection = (id: NavSectionId) =>
    setCollapsed((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  // The rail, narrowed to its icon column. Remembered like the folds: someone who works in a
  // three-column page editor wants the width back, and wants it back tomorrow too.
  const [railChoice, setRailChoice] = useState(readRail);
  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, railChoice ? "narrow" : "wide");
    } catch {
      /* a private window that refuses writes costs the memory of the choice, nothing else */
    }
  }, [railChoice]);
  // Below `md` the rail is already a disclosure under the wordmark — a width it does not have
  // there. Narrowing is a desktop affordance, and every class that expresses it is `md:`-scoped.
  //
  // Which is why the STORED CHOICE is not the same thing as being narrowed, and JS has to know
  // the difference. The choice is per-browser and persisted, so a rail narrowed on a laptop
  // came back narrowed on a phone — where the `md:` classes do nothing, so the rows kept their
  // labels, but the JS gate below removed every group heading AND the hairline that stands in
  // for one is `md:`-only too. That left one undifferentiated column of a dozen rows, with the
  // toggle that would undo it `hidden md:inline-flex`: no way back from that viewport.
  const railNarrow = railIsNarrow(railChoice, useMediaQuery(RAIL_BREAKPOINT));

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

  // Host-configured links to companion tools (e.g. a curation page), from /config.js.
  const extraNav: ExtraNavLink[] = typeof window !== "undefined" ? window.PRAMEN_CMS_EDITOR?.extraNav ?? [] : [];
  // Collections-only deployments hide the block/page builder entirely.
  const hidePages = pagesHidden();
  // Same rule as the landing redirect and the page editor's back target — see `splitsByType`.
  const splitByType = splitsByType(contentTypes, cms, hidePages);
  const nav = buildNav({ collections, adminPages, contentTypes, cms, hidePages, splitByType, isAdmin, extraNav });
  const sections = navSections(nav);
  const labelled = navSectionsAreLabelled(sections);
  // The section half of the breadcrumb, and the way back to its list. Taken from the entry
  // that is LIT rather than re-derived from the path: the nav already answered "where am I",
  // and a second answer computed differently is a second answer that can disagree.
  const activeEntry = nav.find((e) => e.key === active);
  const sectionCrumb = activeEntry?.kind === "route" ? activeEntry : undefined;
  // …and the detail half, published by whatever screen is mounted (see `breadcrumb.tsx`).
  const [crumb, setCrumb] = useState<string | null>(null);

  // See the extraNav comment in `NavLink`. The rules live in `mount.ts` beside the
  // containment they depend on; what this supplies is the URL the BROWSER will resolve a
  // relative href against — the current document, not the origin. Empty when there is no
  // `window`, which makes every href unparseable and so degrades to the safe new-tab default.
  const basePath = useRouter().basePath;
  const documentUrl = typeof window !== "undefined" ? window.location.href : "";

  return (
    // Page-level surface so the whole viewport (not just the rail + cards) flips under
    // `[data-theme="dark"]` — otherwise the body stays white in dark mode. The rail is a grid
    // COLUMN rather than a fixed overlay, so the content column needs no compensating offset
    // and the document keeps its own scroll (which is what the page editor's full-height
    // grid and every in-page anchor already assume).
    <div className={`min-h-screen bg-surface text-fg md:grid ${railNarrow ? "md:grid-cols-[3.5rem_1fr]" : "md:grid-cols-[15rem_1fr]"}`}>
      {/* The rail's own ground. `border-r` is unconditional and the tone is not, because in
          DARK podoba maps `surface-card` onto `surface` — the hairline is the only separation
          left there, and a border that appeared only in one theme would be a rule with no
          reason a reader could see. */}
      <aside
        aria-label="Sidebar"
        className="border-b border-border bg-surface-card md:sticky md:top-0 md:h-screen md:self-start md:overflow-y-auto md:border-b-0 md:border-r"
      >
        <div className="flex min-h-full flex-col">
          <div className={`flex h-12 shrink-0 items-center gap-1 ${railNarrow ? "md:justify-center md:px-0" : ""} px-2`}>
            {/* The workspace row: the wordmark is the way back to the top of the admin, as it
                is on every other site — a `button` (not an `<a>`) so the SPA router handles
                it — and it reads as a row of the rail rather than a masthead above one. */}
            <button
              type="button"
              onClick={guarded(() => navigate("home"))}
              aria-label={`${BRAND.spoken} — home`}
              className={`flex min-w-0 items-center gap-2 rounded-md py-1.5 text-left transition-colors hover:bg-surface-muted ${railNarrow ? "md:flex-none md:px-1.5" : "flex-1 px-2"}`}
            >
              {/* The mark. One letter of the deployment's own name, which is the only glyph
                  available for a wordmark a host supplies at runtime. */}
              <span
                aria-hidden="true"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-fg text-[11px] font-bold leading-none text-fg-inverted"
              >
                {BRAND.name.slice(0, 1).toUpperCase()}
              </span>
              {/* The wordmark itself is what a 56px rail cannot hold; the mark stays, because a
                  narrowed rail still has to say whose admin this is. */}
              <span className={`min-w-0 truncate text-compact font-medium leading-4 text-fg ${railNarrow ? "md:hidden" : ""}`}>{BRAND.name}</span>
              {BRAND.suffix ? <span className={`shrink-0 text-caption text-fg-subtle ${railNarrow ? "md:hidden" : ""}`}>{BRAND.suffix}</span> : null}
            </button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={menuOpen ? "Hide navigation" : "Show navigation"}
              aria-expanded={menuOpen}
              aria-controls="pramen-cms-nav"
              className="shrink-0 rounded-md px-2 py-2 text-fg-muted md:hidden"
              onPress={() => setMenuOpen((open) => !open)}
            >
              <MenuToggleIcon className="h-4 w-4" />
            </Button>
          </div>

          <div id="pramen-cms-nav" className={`${menuOpen ? "flex" : "hidden"} flex-1 flex-col md:flex`}>
            <nav aria-label="Primary" className={`flex flex-col pb-2 ${railNarrow ? "md:px-1.5" : ""} px-2`}>
              {sections.map((section) => {
                // Only a LABELLED group can be folded: the header is the control, so without
                // one there would be no way back — and an unlabelled rail is the
                // single-group case, where there is nothing to fold away from anyway.
                // Narrowed, a group cannot be folded: the heading IS the control, and at 56px
                // there is no room for one. The rows show instead — hiding them behind a
                // control that is not on screen would strand a section with no way back.
                const foldable = labelled && !railNarrow;
                const open = !foldable || !collapsed.includes(section.id);
                return (
                  // The space between groups lives on the GROUP, not on its heading: a
                  // heading is the first child of its own wrapper, so `first:` there matches
                  // every one of them and the gap silently never appears.
                  <div
                    key={section.id}
                    className={`flex flex-col gap-px pt-4 first:pt-1 ${
                      // A hairline stands in for the heading at 56px: the grouping is still
                      // information, and dropping it would leave one undifferentiated column
                      // of a dozen icons.
                      railNarrow ? "md:mt-2 md:border-t md:border-border md:pt-2 md:first:mt-0 md:first:border-t-0 md:first:pt-1" : ""
                    }`}
                  >
                    {foldable ? (
                      <SectionHeader
                        label={section.label}
                        open={open}
                        controls={`nav-group-${section.id}`}
                        onPress={() => toggleSection(section.id)}
                      />
                    ) : null}
                    {/* `hidden` rather than not rendering: the group keeps its identity
                        across a fold, so `aria-controls` always points at a real element and
                        React does not tear down and rebuild every row on a toggle. */}
                    <div id={`nav-group-${section.id}`} className="flex flex-col gap-px" hidden={!open}>
                      {section.entries.map((entry) =>
                        entry.kind === "route" ? (
                          <NavItem
                            key={entry.key}
                            icon={entry.icon}
                            label={entry.label}
                            narrow={railNarrow}
                            active={active === entry.key}
                            onPress={guarded(() => navigate(entry.page as never, entry.params ? ({ params: entry.params } as never) : undefined as never))}
                          />
                        ) : (
                          <NavLink
                            key={entry.key}
                            link={entry.link}
                            icon={entry.icon}
                            narrow={railNarrow}
                            sameTab={opensInSameTab(entry.link.href, entry.link.target, basePath, documentUrl)}
                            confirm={confirmNavigation}
                          />
                        ),
                      )}
                    </div>
                  </div>
                );
              })}
            </nav>

          </div>
        </div>
      </aside>

      {/* `min-w-0`, because a grid column's default `min-width: auto` lets a wide child (a
          table, a long slug) push the column past its track and squeeze the rail. */}
      <div className="min-w-0">
        {/* The app bar. Everything here belongs to the SESSION rather than to the screen, which
            is why it is not in the screen header — and why it survives a narrowed rail, where
            the sign-out and theme controls used to live and no longer fit. Sticky at the top of
            the content column; `page-header.tsx` pins the screen header directly beneath it,
            both off the one height in `chrome.ts`. No rule under it, and the header below has no
            padding above it: the two read as one block of chrome rather than a bar with a
            panel parked beneath it. `bg-surface` is what keeps content from scrolling
            through — the border was never what did that. */}
        <div className={`sticky top-0 z-30 flex ${APP_BAR_H} items-center gap-2 bg-surface px-7`}>
          <Button
            variant="ghost"
            size="sm"
            aria-label={railNarrow ? "Expand the sidebar" : "Collapse the sidebar"}
            aria-expanded={!railNarrow}
            className="-ml-2 hidden rounded-md px-2 py-1.5 text-fg-muted hover:text-fg md:inline-flex"
            onPress={() => setRailChoice((narrow) => !narrow)}
          >
            <RailToggleIcon className="h-[17px] w-[17px]" />
          </Button>
          {/* The trail. The section is a BUTTON while a detail crumb is showing and plain text
              otherwise — a link to the page you are already on is a link that does nothing,
              and the only thing more annoying than no breadcrumb is one that lies about being
              navigable. */}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-compact">
            {sectionCrumb ? (
              crumb ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="max-w-[220px] shrink-0 truncate rounded-md px-2 py-1 text-fg-muted hover:text-fg"
                  onPress={guarded(() =>
                    navigate(sectionCrumb.page as never, sectionCrumb.params ? ({ params: sectionCrumb.params } as never) : (undefined as never)),
                  )}
                >
                  {sectionCrumb.label}
                </Button>
              ) : (
                <span className="max-w-[220px] truncate px-2 py-1 text-fg-muted">{sectionCrumb.label}</span>
              )
            ) : null}
            {crumb ? (
              <>
                {/* Only BETWEEN two crumbs. A screen can publish a detail crumb from a route
                    no nav entry matches (a per-content-type deployment's `/pages/:id`), and
                    the separator then led the trail with a stray "›". */}
                {sectionCrumb ? <CrumbSeparatorIcon aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-subtle" /> : null}
                {/* `aria-current="page"` so the trailing crumb is announced as where you are,
                    not as one more thing to visit. */}
                <span aria-current="page" className="min-w-0 truncate px-1 py-1 font-medium text-fg">
                  {crumb}
                </span>
              </>
            ) : null}
          </nav>
          <div className="ml-auto pl-4">
            <AccountMenu
              me={me}
              theme={theme}
              onTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
              onSettings={guarded(() => navigate("settings"))}
              onSignOut={guarded(reconfigure)}
            />
          </div>
        </div>
        {error ? (
          <Card variant="outlined" padding="none" className="mx-7 mt-2 border-danger px-4 py-2.5">
            <Text size="small" className="text-danger">
              {error}
            </Text>
          </Card>
        ) : null}
        <BreadcrumbProvider publish={setCrumb}>
          <Outlet />
        </BreadcrumbProvider>
      </div>
    </div>
  );
}

/** The icon column of a nav row.
 *
 * A collection and a Block Kit page may declare their own icon server-side, which is an
 * arbitrary string (an emoji, in practice). It used to be prepended to the LABEL, where it
 * read as part of the words and wrapped with them; here both cases occupy the same 16px box,
 * so a rail mixing declared emoji with built-in glyphs still has one aligned icon column.
 */
function NavIconSlot({ icon }: { icon: NavIcon }): ReactNode {
  if (icon.kind === "emoji") {
    return (
      <span aria-hidden="true" className="flex h-[15px] w-[15px] shrink-0 items-center justify-center text-[13px] leading-none">
        {icon.char}
      </span>
    );
  }
  const Glyph = NAV_GLYPHS[icon.name];
  return <Glyph className="h-[15px] w-[15px] shrink-0" />;
}

/** The shared shape of a rail row — a full-width ghost rect, icon then label.
 *
 * Three overrides of podoba's `Button`, all for the same reason: it is an ACTION button and
 * this is a list row. `justify-start`, because a centred label gives a column with no left
 * edge to read down (and sits differently from the host-link rows, which are plain anchors);
 * `rounded-md`, because the pill is a shape you aim at and a rail is a shape you scan; and
 * the tighter padding, which is what puts a dozen destinations on screen without scrolling.
 *
 * `truncate` rather than wrapping: a long collection label is recognisable from its first
 * words, and a row that grows to two lines breaks the rhythm of the column it sits in (the
 * `title` carries the full text for the one reader who needs it). */
const ROW = "flex w-full items-center justify-start gap-2 rounded-md px-2 py-[5px] text-left leading-4";

/** One group's heading, and the control that folds it.
 *
 * The chevron is always drawn, not revealed on hover: this rail is read by people who are
 * not power users of it, and an affordance that only exists once you are already pointing at
 * it is one nobody discovers. It points DOWN when open and RIGHT when folded, which is the
 * one rotation every file tree has agreed on.
 */
function SectionHeader({ label, open, controls, onPress }: { label: string; open: boolean; controls: string; onPress: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-controls={controls}
      className="flex w-full items-center justify-start gap-2 rounded-md px-2 py-1 text-left text-caption font-medium leading-4 text-fg-subtle hover:text-fg-muted"
      onPress={onPress}
    >
      {/* The chevron sits in a box the width of a row's ICON, so the heading's label starts
          on the same x as the labels it heads. A chevron sized to itself pulls the heading
          7px left of its own group, which reads as a stray indent rather than as a level. */}
      <span aria-hidden="true" className="flex h-[15px] w-[15px] shrink-0 items-center justify-center">
        {open ? <GroupOpenIcon className="h-3 w-3" /> : <GroupFoldedIcon className="h-3 w-3" />}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  );
}

/** One route destination in the rail.
 *
 * `aria-current` alongside the tint: the rail is N mutually-exclusive destinations whose
 * only "you are here" cue is a background, which is invisible to a screen reader and
 * marginal for anyone who cannot see it. The active row also takes `font-medium` — podoba
 * has ONE muted-surface token, so hover and active would otherwise be the same pixel, and
 * "where am I" would vanish under the cursor.
 */
function NavItem({ icon, label, narrow, active, onPress }: { icon: NavIcon; label: string; narrow: boolean; active: boolean; onPress: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      // Narrowed, the label is gone from the screen but not from the accessible name — the
      // row is still "Media", not an unnamed button with a picture in it.
      {...(narrow ? { "aria-label": label } : {})}
      className={`${ROW} ${narrow ? "md:justify-center md:px-0" : ""} ${active ? "bg-surface-muted font-medium text-fg" : "text-fg-muted hover:text-fg"}`}
      {...(active ? { "aria-current": "page" as const } : {})}
      onPress={onPress}
    >
      <NavIconSlot icon={icon} />
      {/* The tooltip rides the SPAN, not the button: react-aria's `Button` filters `title`
          out of the DOM props it forwards, so it would silently never render. It is also the
          only thing naming a narrowed row on hover, so it is not optional there. */}
      <span title={label} className={`min-w-0 truncate ${narrow ? "md:hidden" : ""}`}>{label}</span>
    </Button>
  );
}

/**
 * The account cluster in the app bar.
 *
 * podoba's `UserMenu` (a React Aria `Menu`), so the popover, roving focus, typeahead and
 * dismissal are the design system's rather than three more hand-rolled handlers. It carries
 * what the rail's foot used to: the theme, the way out, and now Settings and who you are —
 * which is the half of this that a narrowed rail has no room for at all.
 */
function AccountMenu({
  me,
  theme,
  onTheme,
  onSettings,
  onSignOut,
}: {
  me: Me | null;
  theme: string;
  onTheme: () => void;
  onSettings: () => void;
  onSignOut: () => void;
}) {
  // The server-resolved identity, which is a username rather than a display name — this app
  // has no profile. Falling back to "account" keeps the avatar's initials from reading as "?"
  // in the window between boot and the `me` call landing.
  const who = me?.userId ?? "account";
  return (
    <UserMenu
      triggerLabel={`Account — ${who}`}
      trigger={
        <>
          <Avatar name={who} size="sm" ring={false} />
          <span className="max-w-[180px] truncate text-compact text-fg-muted max-[560px]:hidden">{who}</span>
        </>
      }
      onAction={(key) => {
        if (key === "theme") onTheme();
        else if (key === "settings") onSettings();
        else if (key === "signout") onSignOut();
      }}
    >
      <UserMenuItem id="theme" className="gap-2.5">
        {theme === "dark" ? <LightThemeIcon className="h-[15px] w-[15px]" /> : <DarkThemeIcon className="h-[15px] w-[15px]" />}
        {theme === "dark" ? "Light theme" : "Dark theme"}
      </UserMenuItem>
      <UserMenuItem id="settings" className="gap-2.5">
        <SettingsIcon className="h-[15px] w-[15px]" />
        Settings
      </UserMenuItem>
      <UserMenuItem id="signout" className="gap-2.5">
        <SignOutIcon className="h-[15px] w-[15px]" />
        Sign out
      </UserMenuItem>
    </UserMenu>
  );
}

/** One host-configured link to a companion tool.
 *
 * `rel="noreferrer"` is on BOTH branches. `noopener` is genuinely moot in the same tab (no
 * new browsing context is created, so there is no `window.opener` to sever) but `noreferrer`
 * is not: without it a click from `/__admin/pages/<id>` hands that full url to the
 * destination as `Referer`, and `_self` is honoured for cross-origin destinations.
 *
 * The key pairs href with label, because two entries may legitimately point at the same href
 * and differ only in label or target — keyed on href alone React reconciles them together
 * and the rendered label can end up on the other one's anchor.
 */
function NavLink({ link, icon, narrow, sameTab, confirm }: { link: ExtraNavLink; icon: NavIcon; narrow: boolean; sameTab: boolean; confirm: () => boolean }) {
  return (
    <a
      href={link.href}
      rel={sameTab ? "noreferrer" : "noopener noreferrer"}
      // Only the same-tab case unloads this document, so only it consults the guard.
      onClick={sameTab ? (e) => { if (!confirm()) e.preventDefault(); } : undefined}
      {...(sameTab ? {} : { target: "_blank" })}
      {...(narrow ? { "aria-label": link.label } : {})}
      className={`${ROW} ${narrow ? "md:justify-center md:px-0" : ""} text-compact text-fg-muted no-underline transition-colors hover:bg-surface-muted hover:text-fg`}
    >
      <NavIconSlot icon={icon} />
      <span title={link.label} className={`min-w-0 truncate ${narrow ? "md:hidden" : ""}`}>{link.label}</span>
    </a>
  );
}
