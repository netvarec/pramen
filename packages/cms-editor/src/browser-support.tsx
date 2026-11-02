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
import { CenteredCard } from "./centered-card";
import { useI18n } from "./i18n";

/** The notice itself, in the editor's language. */
export function UnsupportedBrowser() {
  const { t } = useI18n();
  return (
    <CenteredCard role="alert">
      <p className="mb-2 text-sm text-fg-subtle">{BRAND.name}</p>
      <h1 className="mb-4 text-display text-fg">{t("unsupported.title")}</h1>
      <p className="text-sm text-fg-muted">{t("unsupported.body")}</p>
    </CenteredCard>
  );
}

/**
 * Render `children` where the router can run, and the notice everywhere else.
 *
 * `supported` defaults to buzola's own detection, so the editor and the router agree on what
 * "supported" means (it also rules out the Chromium releases whose Navigation API lacked
 * `NavigateEvent.intercept`). `main.tsx` passes the answer it already has, because the same
 * answer decides whether panel bundles are loaded at all.
 */
export function RequireNavigationApi({ children, supported = isNavigationApiSupported() }: { children: ReactNode; supported?: boolean }) {
  return supported ? children : <UnsupportedBrowser />;
}
