// Root layout: the persistent chrome (podoba Topbar + tab nav + global error banner)
// wrapped around every route via <Outlet />. Tab highlighting is derived from the
// current path, so a deep link or refresh lands with the right tab lit.

import { Outlet, useNavigate, useRoute } from "@buzola/router";
import { Button, Card, MoonIcon, SunIcon, Text, Topbar } from "@podoba/react";
import { useEffect, useState } from "react";
import { useApp } from "../app-context";
import { BRAND } from "../brand";

const THEME_KEY = "pramen.cms.theme";

export default function RootLayout() {
  const { isAdmin, collections, error, reconfigure, confirmNavigation } = useApp();
  const navigate = useNavigate();
  const { pathname } = useRoute();

  // Every chrome action here is a way OUT of the current screen, so it runs through that
  // screen's unsaved-changes guard first (the page editor registers one; with no guard
  // registered this is a pass-through). In-app navigation fires no `beforeunload`, so
  // without this the topbar silently discards unsaved edits. The external `extraNav` links
  // open in a new tab and leave nothing behind, so they stay unguarded.
  const guarded = (go: () => void) => () => { if (confirmNavigation()) go(); };

  // Dark mode: podoba tokens flip under `[data-theme="dark"]` — no `dark:` prefixes.
  const [theme, setTheme] = useState(() => (typeof localStorage !== "undefined" ? localStorage.getItem(THEME_KEY) ?? "light" : "light"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // The active collection slug, if we're under /collections/:slug(/...).
  const collectionSlug = pathname.startsWith("/collections/") ? pathname.split("/")[2] : undefined;

  // "Pages" stays lit while editing a page (/pages/:id) too.
  const active = collectionSlug ? `col:${collectionSlug}`
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
          {hidePages ? null : (
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
            // Companion tools live OUTSIDE this SPA (a separate static page/worker route), so
            // open them in a new tab. NOT a style choice, and `target: "_self"` alone would not
            // fix it: `_404.tsx` registers the catch-all `/:__notFound+`, so buzola matches
            // EVERY same-origin path and intercepts it — a same-tab click and `location.assign`
            // both land on the in-app 404 (verified). Only a cross-origin url escapes on its own.
            //
            // The supported same-tab route is `router.leaveApp(href)` (@buzola/router >= 0.0.16),
            // which releases one navigation to the browser. This package still pins ^0.0.12, so
            // adopting it is a version bump plus a `target` option on the config item.
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md px-2.5 py-1.5 text-small text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
            >
              {l.label}
            </a>
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
