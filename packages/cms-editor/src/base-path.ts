// Where the editor is MOUNTED, resolved once from the host's /config.js.
//
// The SPA's routes are authored from "/" ("/media", "/page/:pageId/:tab", …). A host that
// serves the editor under a prefix — an Astro site putting it at /admin so the CMS and the
// site share one origin — needs those to resolve under that prefix instead. buzola's Router
// already does exactly this (`basePath`: prepended for navigation, stripped for matching);
// all that was missing was a way for the host to say so.
//
// Deliberately free of React and buzola imports, like brand.ts: it is read at module load
// before any component renders, so it stays a pure function of config that can be exercised
// without a DOM.
//
// NOT the Worker's `basePath` (reverted before 0.0.52) — that mounted the SERVER under a
// prefix, where `/files` and `/media` and minted URLs all had to learn about it. This is the
// browser-side router only, and the host keeps serving the assets wherever it likes.

/** What the host may set under `window.PRAMEN_CMS_EDITOR.basePath`. */
export interface BasePathHost {
  PRAMEN_CMS_EDITOR?: { basePath?: string };
}

/**
 * Normalize a mount prefix to buzola's shape: `""` for the root, else a leading slash and no
 * trailing one (`"admin/"` and `"/admin"` are the same mount).
 *
 * Anything meaningless — absent, blank, or a bare `"/"` — resolves to `""`, which is the
 * unmounted default, so a malformed value degrades to "as before" rather than routing every
 * link through a stray prefix.
 */
export function resolveBasePath(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "/") return "";
  const leading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return leading.replace(/\/+$/, "");
}

/** Read the prefix off a host object (the global in the browser, an injected one in tests). */
export function readBasePath(host?: BasePathHost): string {
  return resolveBasePath(host?.PRAMEN_CMS_EDITOR?.basePath);
}

/** The mount prefix for THIS page load. Read at module load, like BRAND — /config.js is a
 * plain script tag ahead of the bundle, so it is already set. */
export const BASE_PATH: string = readBasePath(typeof window === "undefined" ? undefined : (window as unknown as BasePathHost));
