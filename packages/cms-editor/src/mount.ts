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

/** A mount path must be a chain of non-empty path segments rooted at the origin, written
 * only in characters that `URL.pathname` returns UNENCODED.
 *
 * Rooted, and required to say so: buzola prepends the base path to every href it builds, so
 * anything that is not already an absolute path resolves somewhere unintended. A leading
 * slash is NOT added for a value missing one — that convenience is what turns a pasted
 * `https://host/admin` into `/https://host/admin`, which is a real path and would be
 * mounted. `//cdn.example.com` is rejected for the same reason: protocol-relative, and the
 * natural product of `"/" + prefix` where the prefix already carried a slash.
 *
 * The character set is not a style choice. Every comparison against a mount path in this
 * file — and buzola's own `stripBasePath`, which we cannot change — is a raw `startsWith`
 * against a `URL.pathname`, which is percent-ENCODED. Admit a character the parser encodes
 * and the two sides can never match: a mount of `/správa` is compared against
 * `/spr%C3%A1va/...` and EVERY in-prefix url reads as off-prefix. So the admitted set is
 * derived from the parser rather than guessed — `"<>^`{}`, backslash, space and everything
 * non-ASCII all encode, and are refused here. */
const MOUNT_PATH = /^(?:\/[A-Za-z0-9!$%&'()*+,\-.:;=@[\]_|~]+)+$/;

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
  // Trailing slashes come off FIRST, so `MOUNT_PATH` only ever judges the canonical form
  // and a value that is nothing but slashes collapses to the root rather than being warned
  // about as malformed.
  const canonical = trimmed.replace(/\/+$/, "");
  if (canonical === "") return "";
  if (!MOUNT_PATH.test(canonical)) {
    console.warn(`pramen/cms-editor: ignoring unusable mount path ${JSON.stringify(trimmed)} — mounting at the origin root.`);
    return "";
  }
  return canonical;
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
  // Spread, not a hand-written list of the seven methods. Enumerating them forwards
  // correctly today but only fails safe by luck: tsc catches a newly REQUIRED member of
  // `NavigationAdapter`, while an OPTIONAL one is silently dropped — and the next planned
  // buzola bump (past ^0.0.12, for `router.leaveApp`) is exactly where such a member would
  // arrive. Overriding the two listener methods is the whole of what this wrapper does.
  return {
    ...inner,
    addEventListener(type, handler) {
      // Adding the same handler twice would attach two wrappers to the inner adapter while
      // the map kept only the second, so the first could never be removed and would keep
      // feeding a torn-down router. Nothing does this today (`Router.start()` mints a fresh
      // closure per call), which is precisely why it should be closed while it is free.
      if (wrappers.has(handler)) return;
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

/**
 * Whether a host-configured nav link may navigate the CURRENT tab.
 *
 * The default for `extraNav` is a new tab, because `_404.tsx` registers the catch-all
 * `/:__notFound+`: an unmounted editor's router matches every same-origin path, so a
 * same-tab click would land on the in-app 404 instead of the tool. `target: "_self"` asks
 * for the co-hosted case, and is honoured only where it cannot strand the user.
 *
 * Lives here, not in the layout, for two reasons: these are the same containment rules
 * `scopeToBasePath` enforces and they belong beside them, and a predicate that decides
 * whether a click escapes the SPA has to be testable without a DOM. `documentUrl` is a
 * PARAMETER rather than a read of `window.location` for the same reason — and because it
 * is the one input that must not be guessed:
 *
 *   - Resolve against `location.origin` and a relative href like `"curate"` is judged as
 *     `/curate` while the browser navigates to `<current dir>/curate`. Off-prefix by the
 *     check, in-prefix in fact, so the link lands on the very 404 this exists to avoid.
 *     `?tab=x` and `#top` are the same mistake with an even wider gap.
 *   - So the caller passes the document URL the browser will itself resolve against.
 */
export function opensInSameTab(href: string, target: string | undefined, basePath: string, documentUrl: string): boolean {
  if (target !== "_self") return false;
  let url: URL;
  let docOrigin: string;
  try {
    url = new URL(href, documentUrl);
    docOrigin = new URL(documentUrl).origin;
  } catch {
    return false;
  }
  // `new URL` happily parses `javascript:` and `data:`, and their `pathname` is an opaque
  // string that trivially fails any containment test — so without this they would take the
  // same-tab branch and shed the `rel` that used to confine them. A url with no hierarchical
  // path cannot be reasoned about as "inside or outside the mount"; the answer is no.
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // Cross-origin ALWAYS escapes on its own — the catch-all can only claim same-origin paths
  // — so it is safe in the same tab whether or not this editor is mounted. That makes an
  // external tool the one configuration that works at the origin root, which is the opposite
  // of what a bare `basePath` check concludes.
  if (url.origin !== docOrigin) return true;
  // Same origin: safe only where the router will not claim it. At the root `isWithinBasePath`
  // is true for everything, so this correctly refuses every same-origin `_self` there.
  return !isWithinBasePath(url.pathname, basePath);
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
