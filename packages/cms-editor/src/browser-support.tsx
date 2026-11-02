// What the editor renders in a browser its router cannot run in.
//
// buzola drives every navigation through the Navigation API, and its browser adapter THROWS
// where that is missing (Safari before 26.2). The throw happens while `EditorRouter` renders,
// with no error boundary above it, so the result was a blank page after sign-in and an
// English error in a console nobody opens.
//
// buzola's own `BuzolaProvider` has an `unsupportedBrowser` notice, but it only renders when
// the provider builds the router itself. The editor hands it a router it built (a scoped
// adapter and a `basePath`, see `mount.ts`), and on that path the provider never checks, so the
// check lives here. It runs ABOVE `AppProvider` on purpose: signing in through a provider
// only to be told the browser cannot open the editor is the same dead end one step later.

import { isNavigationApiSupported } from "@buzola/router";
import type { ReactNode } from "react";
import { BRAND } from "./brand";
import { useI18n } from "./i18n";

/** The notice itself, in the editor's language. */
export function UnsupportedBrowser() {
  const { t } = useI18n();
  return (
    <div className="mx-auto mt-[14vh] w-full max-w-[520px] px-6">
      <div role="alert" className="rounded-panel border border-border bg-surface-card px-10 py-8 shadow-[0_24px_60px_rgba(30,20,10,0.08)]">
        <p className="mb-2 text-sm text-fg-subtle">{BRAND.name}</p>
        <h1 className="mb-4 text-display text-fg">{t("unsupported.title")}</h1>
        <p className="text-sm text-fg-muted">{t("unsupported.body")}</p>
      </div>
    </div>
  );
}

/**
 * Render `children` where the router can run, and the notice everywhere else.
 *
 * `supported` defaults to buzola's own detection, so the editor and the router agree on what
 * "supported" means (it also rules out the Chromium releases whose Navigation API lacked
 * `NavigateEvent.intercept`). Support cannot change while the page is open, so it is read on
 * every render rather than remembered.
 */
export function RequireNavigationApi({ children, supported = isNavigationApiSupported() }: { children: ReactNode; supported?: boolean }) {
  return supported ? children : <UnsupportedBrowser />;
}
