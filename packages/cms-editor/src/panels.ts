// The panel registry — where a deployment's own React screens are registered, and what
// they are handed.
//
// A panel is a component in a SEPARATE bundle, built by the consuming project, that renders
// inside this editor's chrome at `/apps/:slug`. The entry itself is a server fact
// (`adminPanel()` in @pramen/cms): the server owns the slug, label, icon, position and the
// role filter, and the bundle owns only the component. So this module never decides whether
// a panel exists — it answers "is there a component for this slug yet, and if not, was one
// turned away", and nothing more.
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

// --- the runtime contract ----------------------------------------------------------------
//
// A panel bundle is COMPILED there and LINKED here. Its JSX calls and its hook usage are
// fixed at the consumer's build against whichever React they had installed; the React it
// actually runs on is the one this editor loaded, on a deployment they do not control, at
// whatever version that deployment is pinned to. Nothing in the loading path notices the
// difference — the import map resolves, the shims hand over a perfectly good React — so a
// mismatch surfaces as a missing export or a hook that behaves differently, somewhere inside
// a stranger's minified bundle, with no message anyone can act on.
//
// So a bundle has to SAY which contract it was built against, and be turned away if it is not
// this one.

/**
 * The panel runtime contract this editor implements.
 *
 * WHAT BUMPS IT. Three things, and this is the whole list:
 *
 *   1. **A React major in this package.** A panel's hooks and JSX are compiled against one
 *      React's rules and executed against the editor's; going 19 -> 20 here silently moves
 *      every panel bundle ever built onto a React it was not written for. This is the rule
 *      that gets missed, because a React bump is a line in `package.json` nowhere near this
 *      file — hence `PANEL_RUNTIME_REACT_MAJOR` below, which a test pins to the manifest.
 *   2. **A change to what a panel is handed.** A key leaving `PanelProps`, or one changing
 *      meaning; the same for `PanelApi`. ADDING a key is not a bump — a panel that does not
 *      read it cannot notice.
 *   3. **A change to the published runtime.** A name leaving `panel-runtime.ts`, or the
 *      global it is published on being renamed.
 *
 * What does NOT bump it is everything a panel cannot reach: the chrome, the routes, the CMS
 * handlers, podoba's version, this package's own release number. A contract that moved for
 * those would be a release version wearing a check's clothes — every panel refused on an
 * unrelated upgrade, and the only available response would be to edit the literal without
 * rebuilding anything. A check people learn to satisfy blindly is worse than no check.
 */
export const PANEL_RUNTIME_CONTRACT = 1;

/**
 * The React major `PANEL_RUNTIME_CONTRACT` stands for.
 *
 * Written down so rule 1 above has somewhere to be enforced rather than only stated:
 * `test/cms-editor-panels.test.ts` reads the `react` range out of this package's manifest and
 * fails if it has moved past this number. Upgrading React therefore cannot silently leave the
 * contract behind — the bump gets decided, in a red test, by whoever did the upgrade.
 */
export const PANEL_RUNTIME_REACT_MAJOR = 19;

/** What a bundle passes to `registerPanel`: a slug, the contract it was built against, and
 * the component to draw for it.
 *
 * No label, no icon, no position — those travel on the server's `adminPanel()` entry. If the
 * bundle declared them, a bundle that failed to load would take the nav entry with it (so
 * the section would silently cease to exist rather than say what went wrong), and a bundle
 * that loaded would be asserting its own placement with nothing to check it against.
 */
export interface PanelRegistration {
  /** Must match the `adminPanel()` slug on the server. A slug the server did not register
   * (or did not list for this caller) is simply never routed to. */
  slug: string;
  /**
   * The {@link PANEL_RUNTIME_CONTRACT} this bundle was BUILT against — a literal in the
   * bundle's own source, `contract: 1`.
   *
   * A LITERAL, and it can be nothing else. None of this editor is in a panel bundle at build
   * time: react, react-dom and both JSX runtimes are external and resolve, at runtime, to the
   * copies this editor published. So every value the bundle could look up is this editor's,
   * and a check fed from `globalThis` would be comparing our number to our number and passing
   * for every bundle ever built. The literal is the only fact about the BUILD that survives
   * into the bundle, which is why the published runtime does not carry the number at all —
   * see `panel-runtime.ts`.
   *
   * That makes it the same kind of claim as a `peerDependencies` range: the author asserts it
   * and the host verifies the shape. It can be edited without rebuilding and no check can
   * catch that — but it cannot be edited by ACCIDENT, and it is the one line the refusal
   * message names, right after telling you to rebuild.
   *
   * Required, never defaulted. A default is a value for the bundles that say nothing, and
   * those are exactly the set this exists for: everything built before the field existed
   * would be waved through as current.
   */
  contract: number;
  render: ComponentType<PanelProps>;
}

/** What the registry KEEPS: the slug and the component.
 *
 * A separate type from `PanelRegistration` because the contract is a fact about the CALL, not
 * about the panel — once it has been checked there is nothing left to store, and storing it
 * would leave a field a later reader could imagine still differs from ours. */
export interface RegisteredPanel {
  slug: string;
  render: ComponentType<PanelProps>;
}

const panels = new Map<string, RegisteredPanel>();
const listeners = new Set<() => void>();
/** Bundle imports still in flight. What tells "loading" from "loaded and never registered
 * this slug" — the two look identical from the registry alone, and the second is a
 * diagnostic worth printing rather than a spinner to leave up forever. */
let inFlight = 0;
/** Bumped on every registration, every refusal and every change to `inFlight`, and read as
 * the `useSyncExternalStore` snapshot. A number rather than the Map, because a snapshot has to
 * be referentially stable between notifications and a Map that is mutated in place is not. */
let version = 0;
/** Why a slug's registration was REFUSED, keyed by slug, so the panel's own route can say it
 * instead of the generic "nothing registered this slug". The bundle IS there and it DID run;
 * a refusal that reached only the console leaves the screen telling the reader something that
 * is true and useless, and points them at the one thing that is not the problem. */
const refusals = new Map<string, string>();

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** Turn a registration away.
 *
 * One sentence, two readers: it is rendered by the panel's route for whoever is looking at
 * the admin, and warned for whoever is looking at the build — so it is written to read as
 * prose in both places, with the package prefix added only on the console side. `notify`,
 * because a route already mounted on that slug is showing "Loading…" and has to be told the
 * loading ended in a refusal. */
function refuse(slug: string, reason: string, warn: (msg: string) => void): void {
  refusals.set(slug, reason);
  warn(`pramen/cms-editor: ${reason}`);
  notify();
}

/**
 * Why a bundle's stated contract is unacceptable, or `undefined` if it is fine.
 *
 * BOTH directions are refusals, because they are different mistakes with different fixes. A
 * bundle BEHIND this editor is stale — built against a React, or a `PanelProps`, that is not
 * what it will be handed. A bundle AHEAD of it is not itself wrong; the deployment is, with a
 * panel and an admin shipped out of step, and rendering it would link it against a runtime
 * missing whatever the newer contract added. Accepting either would trade a message naming
 * the slug for a crash inside someone else's bundle.
 *
 * A separate exported function, and not folded into `registerPanel`, so the sentence a
 * consumer will actually be sent can be asserted on its own — the wording IS the feature
 * here, and a check whose only test is "it refused" pins none of it.
 *
 * `implemented` is a parameter rather than a read of the constant for one reason, and it is
 * not tidiness: at contract 1 there is no legal number BELOW ours, so the stale branch has
 * nothing to be exercised with and would ship as a branch whose only evidence is that it
 * typechecks. It is the same kind of seam as `warn`, and the registry never passes it.
 */
export function contractRefusal(slug: string, stated: unknown, implemented: number = PANEL_RUNTIME_CONTRACT): string | undefined {
  // `stated` came out of a foreign bundle's object literal, so it is genuinely unknown: `"1"`
  // is what a hand-edited build config produces, `NaN` is what `Number(undefined)` produces,
  // and neither is a version. `Number.isInteger` alone would reject every one of them at
  // RUNTIME — the `typeof` is what narrows the value for the comparisons below, and dropping
  // it as redundant is a type error, not a passing simplification.
  if (typeof stated !== "number" || !Number.isInteger(stated) || stated < 1) {
    return `The '${slug}' panel did not state which panel runtime contract it was built against. Add \`contract: ${implemented}\` to its registerPanel() call and rebuild it against the @pramen/cms-editor this admin serves (React ${PANEL_RUNTIME_REACT_MAJOR}).`;
  }
  if (stated < implemented) {
    return `The '${slug}' panel was built against panel runtime contract ${stated}, and this editor implements ${implemented}. Rebuild the bundle against the @pramen/cms-editor this admin serves (React ${PANEL_RUNTIME_REACT_MAJOR}) and set \`contract: ${implemented}\` in its registerPanel() call.`;
  }
  if (stated > implemented) {
    return `The '${slug}' panel was built against panel runtime contract ${stated}, and this editor implements ${implemented}. Upgrade @pramen/cms-editor — and the shell that serves it — to the release implementing contract ${stated}, or rebuild the panel against this one.`;
  }
  return undefined;
}

/**
 * Register a panel component. Called by a panel bundle, through the runtime published on
 * `globalThis` — see `panel-runtime.ts`.
 *
 * THE CONTRACT IS CHECKED HERE, not in the runtime wrapper that publishes this function, and
 * that is a decision rather than a convenience. This is the only chokepoint: the wrapper is
 * one caller of it, and a check living there would leave the registry itself accepting a
 * bundle built for another React — so the invariant would hold on one path and be a comment
 * on every other. It is also the same KIND of judgement as the two refusals beside it (a
 * missing slug, a `render` that is not a component): whether this registration may enter the
 * registry at all. And it is here rather than in the generated shims because a shim resolves
 * one bare specifier and has no registration to inspect — by the time anything knows a
 * contract was stated, it is in this function's argument.
 *
 * A duplicate slug REPLACES rather than throwing. Registration happens inside a dynamic
 * import of code this editor does not own, where a throw is swallowed into the loader's
 * per-bundle catch and shows up as "the panel never registered" — the least informative
 * possible report of "you registered it twice". A warning names both the slug and the fact,
 * and the last registration wins, which is the only rule that makes a dev-time hot reload
 * (re-evaluating the same bundle) behave. A refusal is not a throw for the same reason.
 */
export function registerPanel(def: PanelRegistration, warn: (msg: string) => void = console.warn): void {
  const slug = typeof def?.slug === "string" ? def.slug.trim() : "";
  if (!slug) {
    // The only refusal with nothing to record it under, and nowhere to render it: without a
    // slug there is no route to put it on. The console is the whole report.
    warn("pramen/cms-editor: ignoring a panel registered with no slug — the slug is what matches it to its adminPanel() entry.");
    return;
  }
  // Before `render`, because the contract is what decides whether the rest of this call means
  // what it appears to: a bundle built for another React may well hand over a function that
  // is not a component this editor can drive.
  const mismatch = contractRefusal(slug, def.contract);
  if (mismatch !== undefined) return refuse(slug, mismatch, warn);
  const rendered = typeof def.render;
  if (rendered !== "function") {
    return refuse(slug, `The '${slug}' panel was ignored: 'render' must be a React component, and this one is of type ${rendered}.`, warn);
  }
  if (panels.has(slug)) warn(`pramen/cms-editor: panel '${slug}' was registered twice — the last registration wins.`);
  // A registration that lands CLEARS the slug's refusal: a dev loop that fixes the contract
  // and re-evaluates the bundle must not leave the old message on the screen.
  refusals.delete(slug);
  panels.set(slug, { slug, render: def.render });
  notify();
}

/** The component registered for a slug, or `undefined`. */
export function getPanel(slug: string): RegisteredPanel | undefined {
  return panels.get(slug);
}

/** Why this slug's registration was turned away, if it was — read by the panel route, so a
 * refused panel says what happened on the screen it was supposed to be. */
export function panelRefusal(slug: string): string | undefined {
  return refusals.get(slug);
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
  refusals.clear();
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
