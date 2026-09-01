// Root layout: the persistent chrome (podoba Topbar + tab nav + global error banner)
// wrapped around every route via <Outlet />. Tab highlighting is derived from the
// current path, so a deep link or refresh lands with the right tab lit.

import { Outlet, useNavigate, useRoute, useRouter } from "@buzola/router";
import { Button, Card, MoonIcon, SunIcon, Text, Topbar } from "@podoba/react";
import { useEffect, useState } from "react";
import { useApp } from "../app-context";
import { BRAND } from "../brand";
import { opensInSameTab } from "../mount";

const THEME_KEY = "pramen.cms.theme";

export default function RootLayout() {
  const { isAdmin, collections, contentTypes, error, reconfigure, confirmNavigation } = useApp();
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
  const collectionSlug = pathname.startsWith("/collections/") ? pathname.split("/")[2] : undefined;
  // …and the active content type, under /types/:slug.
  const typeSlug = pathname.startsWith("/types/") ? pathname.split("/")[2] : undefined;

  // "Pages" stays lit while editing a page (/pages/:id) too — but only on a deployment that
  // still HAS a pooled Pages tab. Split by type, the page editor lights nothing: the route
  // carries a page id and nothing else, so which type's tab to light isn't knowable here
  // without fetching the page the editor is already fetching.
  const active = collectionSlug ? `col:${collectionSlug}`
    : typeSlug ? `type:${typeSlug}`
    : pathname.startsWith("/pages") || pathname === "/" ? "pages"
    : pathname.startsWith("/media") ? "media"
    : pathname.startsWith("/users") ? "users"
    : pathname.startsWith("/settings") ? "settings"
    : "";

  const tabCls = (key: string) => (active === key ? "bg-surface-muted text-fg" : "text-fg-muted");

  // Host-configured links to companion tools (e.g. a curation page), from /config.js.
  const extraNav = typeof window !== "undefined" ? window.PRAMEN_CMS_EDITOR?.extraNav ?? [] : [];
  // Collections-only deployments hide the block/page builder entirely.
  const hidePages = typeof window !== "undefined" ? window.PRAMEN_CMS_EDITOR?.hidePages === true : false;

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
          {/* One tab per content type once a deployment declares more than one: a CMS holding
              pages AND articles pooled them into a single "Pages" list where the only thing
              distinguishing a landing page from a news item was the slug. A single type keeps
              the plain "Pages" tab — there is nothing there to separate, and splitting it
              would put the deployment's own type name where a generic label reads better.
              The label is the type's `name`, so a host that wants a plural tab writes one. */}
          {hidePages ? null : contentTypes.length > 1 ? (
            contentTypes.map((t) => (
              <Button
                key={t.slug}
                variant="ghost"
                size="sm"
                className={tabCls(`type:${t.slug}`)}
                onPress={guarded(() => navigate("type", { params: { slug: t.slug } }))}
              >
                {t.name}
              </Button>
            ))
          ) : (
            <Button variant="ghost" size="sm" className={tabCls("pages")} onPress={guarded(() => navigate("home"))}>
              Pages
            </Button>
          )}
          {collections.map((c) => (
            <Button key={c.slug} variant="ghost" size="sm" className={tabCls(`col:${c.slug}`)} onPress={guarded(() => navigate("collection", { params: { slug: c.slug } }))}>
              {c.icon ? `${c.icon} ` : ""}
              {c.pluralLabel}
            </Button>
          ))}
          <Button variant="ghost" size="sm" className={tabCls("media")} onPress={guarded(() => navigate("media"))}>
            Media
          </Button>
          {isAdmin ? (
            <Button variant="ghost" size="sm" className={tabCls("users")} onPress={guarded(() => navigate("users"))}>
              Users
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" className={tabCls("settings")} onPress={guarded(() => navigate("settings"))}>
            Settings
          </Button>
          {extraNav.map((l) => (
            // Defaults to a new tab: a companion tool is normally a separate deployment, and
            // `_404.tsx` registers the catch-all `/:__notFound+`, so the router matches every
            // SAME-ORIGIN path — a same-tab click would land on the in-app 404 rather than the
            // tool. `target: "_self"` asks for the co-hosted case, and is honoured only where
            // the router provably will not claim the url (`opensInSameTab` in mount.ts):
            //
            //   - cross-origin: always, mounted or not. The catch-all cannot reach another
            //     origin, so this is the ONE case that also works at the origin root.
            //   - same-origin: only outside the mount prefix, where `scopeToBasePath` leaves
            //     the navigation to the browser. At the root there is no outside, so never.
            //
            // Anything else degrades to the new tab rather than stranding the user on a 404.
            // (When @buzola/router moves past ^0.0.12 here, `router.leaveApp(href)` releases
            // one navigation to the browser and makes same-origin `_self` work unmounted too.)
            <NavLink key={`${l.href}|${l.label}`} link={l} sameTab={opensInSameTab(l.href, l.target, basePath, documentUrl)} confirm={confirmNavigation} />
          ))}
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
function NavLink({ link, sameTab, confirm }: { link: { label: string; href: string; target?: string }; sameTab: boolean; confirm: () => boolean }) {
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
