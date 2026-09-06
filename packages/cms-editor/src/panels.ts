// The panel registry — where a deployment's own React screens are registered, and what
// they are handed.
//
// A panel is a component in a SEPARATE bundle, built by the consuming project, that renders
// inside this editor's chrome at `/apps/:slug`. The entry itself is a server fact
// (`adminPanel()` in @pramen/cms): the server owns the slug, label, icon, position and the
// role filter, and the bundle owns only the component. So this module never decides whether
// a panel exists — it answers "is there a component for this slug yet", and nothing more.
//
// HOW A BUNDLE GETS LOADED, AND WHY THE EDITOR DOES THE LOADING
//
// The obvious shape is for the shell to emit a second `<script type="module">` beside the
// editor's. It does not work in either order. Placed FIRST, the panel bundle evaluates
// before the editor has published the React it must share, so its very first import fails.
// Placed SECOND, it races the editor's own first render, and a deep link to `/apps/:slug`
// would resolve before the component it needs exists.
//
// So the shell declares panel bundle URLs as configuration and the EDITOR imports them,
// after publishing the runtime and before mounting the router. Ordering stops being a
// property of script tags and becomes a line of code. It also makes failure containable:
// a bundle that 404s or throws costs its own panel, and the admin still boots.
//
// The loads are NOT awaited before the first paint. Everything else in the chrome already
// arrives a round trip late (`listAdminPages` is what puts the entry in the nav at all), and
// blocking `createRoot` on a third-party fetch means one hanging request is a blank admin.
// Registration therefore notifies subscribers and the panel route re-reads — which is also
// what makes "still loading" tellable from "the bundle never registered this slug".
//
// Deliberately free of React at RUNTIME (the component type below is erased), so every rule
// here can be exercised without a DOM — the same discipline `mount.ts` keeps.

import type { ComponentType } from "react";
import type { RpcInput } from "./types";

/** The authenticated transport a panel is handed.
 *
 * A NARROW view of the editor's `Api`, not the class itself. `Api` carries ~40 typed
 * wrappers for CMS handlers — pages, media, menus, taxonomies — and none of that is a
 * panel's business; handing the object over would make every one of those methods an API to
 * keep. What a panel needs is the ability to call ITS OWN project handlers with the
 * session's credentials attached, plus a way to turn a relative media path into a URL.
 *
 * The session is not exposed and cannot be: no token, no base URL, no tenant. A panel calls
 * through this or it does not call at all, which keeps one answer to "what does an
 * authenticated request from the admin look like".
 */
export interface PanelApi {
  /** Call a CMS/project RPC handler as the signed-in user. Rejects with the server's error
   * message on a non-`ok` envelope. */
  call<T = unknown>(name: string, input?: RpcInput): Promise<T>;
  /** Absolute URL for a relative media/serving path the backend returned. */
  resolve(path: string): string;
}

/** What a panel component is handed. Four things, and the case for each:
 *
 *  - `api` — a panel with no authenticated transport is a static page.
 *  - `basePath` — the editor may be mounted under a prefix (`/__admin`), and a panel that
 *    builds its own hrefs has no other way to stay inside it. Without this the one thing a
 *    panel is FOR — being part of the admin — is the thing it gets wrong.
 *  - `theme` — the chrome's light/dark choice. Styling follows automatically (podoba tokens
 *    flip on `[data-theme]` at the document root), so this is for the decisions CSS cannot
 *    make: a chart's palette, a canvas, an embedded third-party widget.
 *  - `setError` — the editor has ONE error surface, the banner in the root layout. A panel
 *    that invented a second would put failures in a place the reader has not learned to
 *    look, and the two would style differently.
 *
 * What is deliberately NOT here is the identity (`me`). It is one `api.call("me")` away, and
 * a panel that branches on the caller's roles to decide what to show is doing client-side
 * authorization — the gate that counts is `roles` on `adminPanel()`, enforced server-side
 * before the entry is even listed. Making the roles inconvenient to reach is the point.
 */
export interface PanelProps {
  api: PanelApi;
  basePath: string;
  theme: "light" | "dark";
  setError: (message: string) => void;
}

/** What a bundle registers: a slug, and the component to draw for it.
 *
 * No label, no icon, no position — those travel on the server's `adminPanel()` entry. If the
 * bundle declared them, a bundle that failed to load would take the nav entry with it (so
 * the section would silently cease to exist rather than say what went wrong), and a bundle
 * that loaded would be asserting its own placement with nothing to check it against.
 */
export interface PanelDefinition {
  /** Must match the `adminPanel()` slug on the server. A slug the server did not register
   * (or did not list for this caller) is simply never routed to. */
  slug: string;
  render: ComponentType<PanelProps>;
}

const panels = new Map<string, PanelDefinition>();
const listeners = new Set<() => void>();
/** Bundle imports still in flight. What tells "loading" from "loaded and never registered
 * this slug" — the two look identical from the registry alone, and the second is a
 * diagnostic worth printing rather than a spinner to leave up forever. */
let inFlight = 0;
/** Bumped on every registration and on every change to `inFlight`, and read as the
 * `useSyncExternalStore` snapshot. A number rather than the Map, because a snapshot has to
 * be referentially stable between notifications and a Map that is mutated in place is not. */
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/**
 * Register a panel component. Called by a panel bundle, through the runtime published on
 * `globalThis` — see `panel-runtime.ts`.
 *
 * A duplicate slug REPLACES rather than throwing. Registration happens inside a dynamic
 * import of code this editor does not own, where a throw is swallowed into the loader's
 * per-bundle catch and shows up as "the panel never registered" — the least informative
 * possible report of "you registered it twice". A warning names both the slug and the fact,
 * and the last registration wins, which is the only rule that makes a dev-time hot reload
 * (re-evaluating the same bundle) behave.
 */
export function registerPanel(def: PanelDefinition, warn: (msg: string) => void = console.warn): void {
  const slug = typeof def?.slug === "string" ? def.slug.trim() : "";
  if (!slug) {
    warn("pramen/cms-editor: ignoring a panel registered with no slug — the slug is what matches it to its adminPanel() entry.");
    return;
  }
  if (typeof def.render !== "function") {
    warn(`pramen/cms-editor: ignoring panel '${slug}' — 'render' must be a React component.`);
    return;
  }
  if (panels.has(slug)) warn(`pramen/cms-editor: panel '${slug}' was registered twice — the last registration wins.`);
  panels.set(slug, { slug, render: def.render });
  notify();
}

/** The component registered for a slug, or `undefined`. */
export function getPanel(slug: string): PanelDefinition | undefined {
  return panels.get(slug);
}

/** Have all declared bundles finished loading (however they finished)? */
export function panelsSettled(): boolean {
  return inFlight === 0;
}

/** The registry's version — the `useSyncExternalStore` snapshot. */
export function panelsVersion(): number {
  return version;
}

export function subscribePanels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drop every registration and every listener. Tests only — the registry is module state,
 * and a test that registered a panel must not leak it into the next one. */
export function resetPanels(): void {
  panels.clear();
  listeners.clear();
  inFlight = 0;
  version = 0;
}

// --- bundle loading ---------------------------------------------------------------------

/** What the shell may set under `window.PRAMEN_CMS_EDITOR.panels`. */
export interface PanelHost {
  PRAMEN_CMS_EDITOR?: { panels?: unknown };
}

/**
 * Resolve one declared bundle URL, or reject it.
 *
 * These strings are `import()`ed, which is to say EXECUTED, so the check is about what a
 * scheme can do and not about tidiness. `javascript:`, `data:` and `blob:` all parse
 * happily as URLs and all name code with no origin to attribute it to; an http(s) URL is
 * fetched under the page's own CSP and shows up in the network log like every other asset.
 * So the allow-list is the two hierarchical web schemes and nothing else.
 *
 * Resolved against the DOCUMENT rather than the origin, for the reason `opensInSameTab`
 * spells out: a relative specifier is what the browser would itself resolve that way, and
 * resolving against `location.origin` instead would silently load a different file. It also
 * means a fingerprinted asset path emitted by the host's bundler (`/_astro/panel.a1b2.js`)
 * needs no special handling — it is just an absolute path.
 */
export function panelBundleUrl(raw: unknown, documentUrl: string): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim(), documentUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.href;
}

/**
 * The bundle URLs the shell declared, resolved and filtered.
 *
 * A rejected entry is WARNED about and dropped rather than throwing: the value is
 * server-generated (see `AdminRuntimeConfig` in @pramen/cms-astro), so one that fails this
 * check means something upstream is wrong — and taking the whole admin down over a bad panel
 * URL would be the worst possible place to discover it. `brand.ts` and `mount.ts` fail the
 * same way for the same reason.
 */
export function readPanelUrls(host: PanelHost | undefined, documentUrl: string, warn: (msg: string) => void = console.warn): string[] {
  const declared = host?.PRAMEN_CMS_EDITOR?.panels;
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) {
    warn("pramen/cms-editor: ignoring `panels` — it must be an array of module URLs.");
    return [];
  }
  const out: string[] = [];
  for (const entry of declared) {
    const url = panelBundleUrl(entry, documentUrl);
    if (url === undefined) warn(`pramen/cms-editor: ignoring unusable panel bundle URL ${JSON.stringify(entry)} — it must be an http(s) URL or a path.`);
    else out.push(url);
  }
  return out;
}

/** How a bundle is fetched. A parameter so the loader can be exercised without a network. */
export type PanelImporter = (url: string) => Promise<unknown>;

const dynamicImport: PanelImporter = (url) => import(/* @vite-ignore */ url);

/**
 * Import every declared panel bundle, in parallel.
 *
 * Per-bundle `catch`, not one `try` around the lot: bundles are independent deployments of
 * independent project code, and one that 404s must not take the others' registrations with
 * it. The returned promise settles when all of them have, which is what `panelsSettled`
 * reports — nothing awaits it on the boot path.
 */
export async function loadPanelBundles(
  urls: readonly string[],
  importer: PanelImporter = dynamicImport,
  warn: (msg: string) => void = console.warn,
): Promise<void> {
  if (urls.length === 0) return;
  inFlight += urls.length;
  notify();
  await Promise.all(
    urls.map((url) =>
      importer(url)
        .catch((e: unknown) => {
          warn(`pramen/cms-editor: panel bundle ${url} failed to load — ${String((e as Error)?.message ?? e)}`);
        })
        .finally(() => {
          inFlight -= 1;
          notify();
        }),
    ),
  );
}
