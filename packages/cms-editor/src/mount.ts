// Where the editor is mounted, and which backend it talks to — read off the shell that
// served it.
//
// The SPA's routes are authored from "/" ("/media", "/pages/:pageId", …), so an editor
// served under a path prefix needs buzola's Router to prepend it. That prefix is NOT
// something a human configures: the server that ROUTED the request is the same one that
// renders the shell, so it stamps the prefix onto the mount node and the two can never
// disagree. `@pramen/cms-astro` injects its admin route and writes this attribute from a
// single constant; the dev preview server does the same.
//
// A `data-*` attribute rather than a global, for the one value that must be right:
// `dataset` is a string or undefined BY CONSTRUCTION, so there is no non-string value to
// guard against, and it cannot be set for an element other than the one being mounted.
//
// Deliberately free of React and of any runtime buzola import (the adapter types below are
// type-only, hence erased), so every rule here can be exercised without a DOM.

import type { BuzolaNavigateEvent, NavigationAdapter } from "@buzola/router";

/** A mount path must be a chain of path segments rooted at the origin.
 *
 * Rooted, and required to say so: buzola prepends the base path to every href it builds, so
 * anything that is not already an absolute path resolves somewhere unintended. A leading
 * slash is NOT added for a value missing one — that convenience is what turns a pasted
 * `https://host/admin` into `/https://host/admin`, which is a real path and would be
 * mounted. `//cdn.example.com` is rejected for the same reason: protocol-relative, and the
 * natural product of `"/" + prefix` where the prefix already carried a slash.
 *
 * Segments only, too: a value carrying `?`, `#` or `\` is not a mount path, and each breaks
 * routing in its own silent way (a query swallows the rest of every href; a backslash
 * resolves off-site while looking local). */
const MOUNT_PATH = /^\/[^/\\?#][^\\?#]*$/;

/**
 * Normalize the mount node's declared prefix to buzola's shape: `""` for the origin root,
 * else a leading slash and no trailing one.
 *
 * Nothing declared means the root, which is how the editor has always been served. A
 * declared-but-unusable value is WARNED about and falls back to the root rather than
 * routing every link through a stray prefix — the value is server-generated, so if one
 * ever fails this check something upstream is wrong and a green deploy is the worst place
 * to discover it (`brand.ts` warns for the same reason).
 */
export function resolveBasePath(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "" || trimmed === "/") return "";
  if (!MOUNT_PATH.test(trimmed)) {
    console.warn(`pramen/cms-editor: ignoring unusable mount path ${JSON.stringify(trimmed)} — mounting at the origin root.`);
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

/** Read the prefix the shell stamped onto the mount node. */
export function readBasePath(el: { dataset: DOMStringMap } | null): string {
  return resolveBasePath(el?.dataset.basePath);
}

/**
 * Whether a pathname is INSIDE a mount prefix — the prefix itself, or something below it.
 *
 * Anchored at a segment boundary on purpose. buzola's own `stripBasePath` is a bare
 * `startsWith`, so with a prefix of `/cms` the host's `/cmsmedia` strips to `media` and
 * renders the editor's Media library at a URL that has nothing to do with the editor.
 */
export function isWithinBasePath(pathname: string, basePath: string): boolean {
  if (!basePath) return true;
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

/**
 * Scope a navigation adapter to one mount prefix.
 *
 * `Router.start()` intercepts every navigation that matches a route, and `_404.tsx`
 * registers the catch-all `/:__notFound+` — so EVERY same-origin path matches. At the
 * origin root that is correct (the editor is the whole origin). Co-hosted under a prefix
 * it is not: a click on the host site's own `/blog` would be cancelled by `event.intercept`
 * and render the editor's "Nothing lives here" while the address bar reads `/blog`.
 *
 * Filtering at the adapter means the router never SEES an off-prefix navigation, so the
 * browser handles it natively — no route table changes, no buzola fork.
 */
export function scopeToBasePath(inner: NavigationAdapter, basePath: string): NavigationAdapter {
  if (!basePath) return inner;
  type Handler = (event: BuzolaNavigateEvent) => void;
  // Keyed by the caller's handler so `removeEventListener` can find the wrapper it added;
  // without this the router's `start()` teardown would leave the listener attached.
  const wrappers = new Map<Handler, Handler>();
  return {
    getCurrentURL: () => inner.getCurrentURL(),
    navigate: (url, options) => inner.navigate(url, options),
    back: () => inner.back(),
    forward: () => inner.forward(),
    getState: () => inner.getState(),
    addEventListener(type, handler) {
      const wrapper: Handler = (event) => {
        // A malformed destination is not ours to claim.
        let pathname: string;
        try {
          pathname = new URL(event.destination.url).pathname;
        } catch {
          return;
        }
        if (isWithinBasePath(pathname, basePath)) handler(event);
      };
      wrappers.set(handler, wrapper);
      inner.addEventListener(type, wrapper);
    },
    removeEventListener(type, handler) {
      const wrapper = wrappers.get(handler);
      if (!wrapper) return;
      wrappers.delete(handler);
      inner.removeEventListener(type, wrapper);
    },
  };
}

/** The backend the shell declared: which Worker to call, and as which tenant.
 *
 * When present these are NOT read from (or written to) localStorage — the server knows
 * where its own API is, and a stale stored value from an earlier deployment would win
 * forever otherwise. Only the session token is the browser's to remember. */
export interface DeclaredBackend {
  /** Origin of the CMS Worker. `""` means same-origin. */
  url: string;
  tenant: string;
}

/** What the shell may set under `window.PRAMEN_CMS_EDITOR.backend`. */
export interface BackendHost {
  PRAMEN_CMS_EDITOR?: { backend?: { url?: unknown; tenant?: unknown } };
}

/** Read the declared backend off a host global, or `undefined` when the shell declared
 * none (the dev preview's standalone mode, where the Setup screen asks for it). */
export function readBackend(host: BackendHost | undefined): DeclaredBackend | undefined {
  const declared = host?.PRAMEN_CMS_EDITOR?.backend;
  // A url is what makes the declaration meaningful; `""` (same-origin) is a real value, so
  // this tests for the STRING, not for truthiness.
  if (typeof declared?.url !== "string") return undefined;
  const tenant = typeof declared.tenant === "string" && declared.tenant.trim() !== "" ? declared.tenant.trim() : "main";
  return { url: declared.url.replace(/\/+$/, ""), tenant };
}
