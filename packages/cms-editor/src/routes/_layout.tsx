// Root layout: the persistent chrome (podoba Topbar + tab nav + global error banner)
// wrapped around every route via <Outlet />. Tab highlighting is derived from the
// current path, so a deep link or refresh lands with the right tab lit.

import { Outlet, useNavigate, useRoute, useRouter } from "@buzola/router";
import { Button, Card, MoonIcon, SunIcon, Text, Topbar } from "@podoba/react";
import { useEffect, useState } from "react";
import { useApp } from "../app-context";
import { BRAND } from "../brand";
import { pagesHidden, splitsByType } from "../components";
import { opensInSameTab } from "../mount";
import { buildNav, type ExtraNavLink } from "../nav";

const THEME_KEY = "pramen.cms.theme";

/**
 * The slug segment under `prefix`, DECODED.
 *
 * `useRoute().pathname` comes off a `URL`, so it is percent-encoded; the slugs it is compared
 * against are the raw values the server stored. buzola encodes when it builds an href and
 * decodes into `params` when it matches, so routing is unaffected — only this comparison was,
 * and a content type called `články` navigated correctly to a tab bar with nothing lit.
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
  const { isAdmin, collections, contentTypes, cms, error, reconfigure, confirmNavigation } = useApp();
  const navigate = useNavigate();
  const { pathname } = useRoute();

  // Every chrome action here is a way OUT of the current screen, so it runs through that
  // screen's unsaved-changes guard first (the page editor registers one; with no guard
  // registered this is a pass-through). In-app navigation fires no `beforeunload`, so
  // without this the topbar silently discards unsaved edits. An `extraNav` link that opens a
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

  // The active collection slug, if we're under /collections/:slug(/...).
  const collectionSlug = segmentAt(pathname, "/collections/");
  // …and the active content type, under /types/:slug.
  const typeSlug = segmentAt(pathname, "/types/");

  // "Pages" stays lit while editing a page (/pages/:id) too — but only on a deployment that
  // still HAS a pooled Pages tab. Split by type, the page editor lights nothing: the route
  // carries a page id and nothing else, so which type's tab to light isn't knowable here
  // without fetching the page the editor is already fetching.
  const active = collectionSlug ? `col:${collectionSlug}`
    : typeSlug ? `type:${typeSlug}`
    : pathname.startsWith("/pages") || pathname === "/" ? "pages"
    : pathname.startsWith("/media") ? "media"
    // `/schema` rather than `/types`, because `/types/:slug` is already one content type's
    // PAGE LIST — a different thing entirely, and the tab keyed `type:<slug>` above.
    : pathname.startsWith("/schema") ? "types"
    : pathname.startsWith("/menus") ? "menus"
    : pathname.startsWith("/taxonomies") ? "taxonomies"
    : pathname.startsWith("/widgets") ? "widgets"
    : pathname.startsWith("/redirects") ? "redirects"
    : pathname.startsWith("/users") ? "users"
    : pathname.startsWith("/settings") ? "settings"
    : "";

  // `aria-current` alongside the class: split by type the nav is N mutually-exclusive tabs
  // whose only "you are here" cue is a background tint, which is invisible to a screen reader
  // and marginal for anyone who cannot see the tint.
  const tabProps = (key: string) => ({
    className: active === key ? "bg-surface-muted text-fg" : "text-fg-muted",
    ...(active === key ? { "aria-current": "page" as const } : {}),
  });

  // Host-configured links to companion tools (e.g. a curation page), from /config.js.
  const extraNav: ExtraNavLink[] = typeof window !== "undefined" ? window.PRAMEN_CMS_EDITOR?.extraNav ?? [] : [];
  // Collections-only deployments hide the block/page builder entirely.
  const hidePages = pagesHidden();
  // Same rule as the landing redirect and the page editor's back target — see `splitsByType`.
  const splitByType = splitsByType(contentTypes, cms, hidePages);
  const nav = buildNav({ collections, contentTypes, cms, hidePages, splitByType, isAdmin, extraNav });

  // See the extraNav comment below. The rules live in `mount.ts` beside the containment they
  // depend on; what this supplies is the URL the BROWSER will resolve a relative href
  // against — the current document, not the origin. Empty when there is no `window`, which
  // makes every href unparseable and so degrades to the safe new-tab default.
  const basePath = useRouter().basePath;
  const documentUrl = typeof window !== "undefined" ? window.location.href : "";

  return (
    // Page-level surface so the whole viewport (not just the topbar + cards) flips
    // under `[data-theme="dark"]` — otherwise the body stays white in dark mode.
    <div className="min-h-screen bg-surface text-fg">
      <Topbar className="sticky top-0 z-10 bg-surface px-7">
        <Topbar.Brand>
          {/* The wordmark is the way back to the top of the admin, as it is on every
              other site — a `button` (not an `<a>`) so the SPA router handles it. */}
          <button
            type="button"
            onClick={guarded(() => navigate("home"))}
            aria-label={`${BRAND.spoken} — home`}
            className="flex items-baseline gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-surface-muted"
          >
            <span className="text-callout font-bold tracking-[0.01em] text-fg">{BRAND.name}</span>
            {BRAND.suffix ? <span className="text-fg-subtle">· {BRAND.suffix}</span> : null}
          </button>
        </Topbar.Brand>
        <Topbar.Nav aria-label="Primary">
          {/* Order comes from `buildNav`, not from the sequence written here — see nav.ts.
              A section can therefore sit BETWEEN two built-ins (a collection declaring
              `navOrder`, a host link declaring `order`) rather than only after Settings,
              which is what made a project-specific section structurally a bolted-on second
              app. Rendering stays here because navigation belongs to the layout: every
              route entry goes through the unsaved-changes guard, and an `extraNav` link
              that leaves the document takes the same guard. */}
          {nav.map((entry) =>
            entry.kind === "route" ? (
              <Button
                key={entry.key}
                variant="ghost"
                size="sm"
                {...tabProps(entry.key)}
                onPress={guarded(() => navigate(entry.page as never, entry.params ? ({ params: entry.params } as never) : undefined as never))}
              >
                {entry.label}
              </Button>
            ) : (
              <NavLink
                key={entry.key}
                link={entry.link}
                sameTab={opensInSameTab(entry.link.href, entry.link.target, basePath, documentUrl)}
                confirm={confirmNavigation}
              />
            ),
          )}
        </Topbar.Nav>
        <Topbar.Actions>
          {/* The tenant is deployment configuration, not something an editor acts on —
              it stays visible on the Settings page (Connection), not in the chrome. */}
          <Button
            variant="ghost"
            size="sm"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onPress={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="sm" onPress={guarded(reconfigure)}>
            sign out
          </Button>
        </Topbar.Actions>
      </Topbar>
      {error ? (
        <Card variant="outlined" padding="none" className="mx-7 mt-2 border-danger px-4 py-2.5">
          <Text size="small" className="text-danger">
            {error}
          </Text>
        </Card>
      ) : null}
      <Outlet />
    </div>
  );
}

/** One host-configured link to a companion tool.
 *
 * `rel="noreferrer"` is on BOTH branches. `noopener` is genuinely moot in the same tab (no
 * new browsing context is created, so there is no `window.opener` to sever) but `noreferrer`
 * is not: without it a click from `/_pramen/admin/pages/<id>` hands that full url to the
 * destination as `Referer`, and `_self` is honoured for cross-origin destinations.
 *
 * The key pairs href with label, because two entries may legitimately point at the same href
 * and differ only in label or target — keyed on href alone React reconciles them together
 * and the rendered label can end up on the other one's anchor.
 */
function NavLink({ link, sameTab, confirm }: { link: ExtraNavLink; sameTab: boolean; confirm: () => boolean }) {
  return (
    <a
      href={link.href}
      rel={sameTab ? "noreferrer" : "noopener noreferrer"}
      // Only the same-tab case unloads this document, so only it consults the guard.
      onClick={sameTab ? (e) => { if (!confirm()) e.preventDefault(); } : undefined}
      {...(sameTab ? {} : { target: "_blank" })}
      className="rounded-md px-2.5 py-1.5 text-small text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
    >
      {link.label}
    </a>
  );
}
