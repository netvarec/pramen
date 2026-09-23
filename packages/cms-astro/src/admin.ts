// The admin mount — where @pramen/cms-editor lives on the host site, and what the shell
// tells it when it boots.
//
// The editor is a routed SPA. Serving it used to mean deploying its `dist/` somewhere and
// asking the host for three things it had no way to verify: a catch-all rewrite to
// index.html, hashed assets at the ORIGIN ROOT (so any prefix mount broke), and a
// hand-edited `config.js` that failed silently when it 404'd. None of that survives here:
// the integration injects ONE Astro route, so the host's own routing table serves every
// deep link, its bundler emits and fingerprints the two assets, and the config is rendered
// into the page from typed options.
//
// `ADMIN_BASE` is a constant, not an option. It is the pattern passed to `injectRoute` AND
// the prefix stamped onto the mount node, so the route and the router cannot disagree —
// which is the entire failure mode a configurable prefix invites. The `__`-prefixed segment
// is a reserved namespace: the host keeps every ordinary path for its own pages.
//
// It does NOT name the framework. `/_pramen/admin` did, and that is the same mistake the
// `brand` option exists to undo: this path is a client-facing URL — it is what an editor
// bookmarks, types and reads out over the phone — and the name of the library the agency
// happened to build with does not belong in it any more than it belongs in the wordmark.
//
// `__` rather than a single `_` or a leading dot. A dot-segment is the one shape to avoid:
// dotfile protection is on by default in a great many static hosts, CDNs and reverse
// proxies, so `/.admin` is a path a share of deployments will simply 404 — `.well-known`
// needed a whole RFC and per-server carve-outs to be reachable, which is the proof, not the
// counterexample. `__` is instead the settled marker for "the framework serves this, not
// you": `/_next`, `/_nuxt`, `/_astro`, Cloudflare's `/__scheduled`, lopata's
// `/__dashboard` — and pramen's own `/__migrations`. Doubling it keeps clear of Astro's own
// single-underscore conventions.

/** Where the editor is mounted on the host site. */
export const ADMIN_BASE = "/__admin";

/** The route pattern injected for it — one catch-all, so every in-app URL is a real server
 * route and a refresh or a deep link is served like any other page. */
export const ADMIN_ROUTE = `${ADMIN_BASE}/[...path]`;

/** What the editor is handed at boot. Rendered into the shell as one inline script, so it
 * is set before the bundle runs — the contract the old `/config.js` had, minus the file. */
export interface AdminRuntimeConfig {
  /** Which CMS Worker to call, and as which tenant. The editor asks for a token and
   * nothing else once this is present. */
  backend: { url: string; tenant: string };
  /** The wordmark in the topbar, on the sign-in screen and in the browser tab. Set it when
   * you deploy for a client — the default is the framework's name, not theirs. */
  brand?: { name?: string; suffix?: string | null };
  /** Send unauthenticated/expired sessions to your own sign-in page. Must be a page that
   * EXISTS: the editor clears the session before redirecting, so a path that lands back
   * inside the editor is a loop with nothing to recover from. */
  signInUrl?: string;
  /** Hide the Pages tab, for deployments that use collections only. */
  hidePages?: boolean;
  /**
   * Which chrome the editor wears. `"sidebar"` (the default) is the rail: a scannable
   * column with icons and collapsible groups, which is what a dozen-plus destinations
   * needs. `"topbar"` is the Graphic Standard bar — brand left, tabs right, avatar at the
   * end — for a site whose own chrome is that bar, or whose nav fits a row.
   *
   * Past the first nav group the bar folds each later group into a dropdown rather than
   * scrolling sideways, so a big admin stays usable in it; it is still the smaller shape.
   */
  layout?: "sidebar" | "topbar";
  /**
   * How the SCREEN header is dressed — the sticky panel with the title and the primary
   * action, on the editor's own screens.
   *
   * The declarative alternative to a stylesheet that selects on the editor's internal DOM.
   * That was the only hook a deployment had, and it cannot tell one screen from another or a
   * container from a control: a rule written for "the header's action" injected a label that
   * read "New + Upload" on Media, and landed on both the panel and the button at once (white
   * on mint, 1.58:1). Here the host names the presentation and the editor keeps owning the
   * text, the action and the contrast.
   *
   * - `variant` — `"cover"` (default) is the seeded artwork; `"flat"` keeps the panel without
   *   it; `"bare"` drops the panel too, leaving the title and action on the page.
   * - `accent` — the colour the primary action wears. An OPAQUE hex or `rgb()` literal, not
   *   `var()` or `oklch()`: the editor parses it to derive the label colour on it and the
   *   hover shade, which is what makes the contrast bug above unreachable through this API.
   * - `titleFont` — a `font-family` list for the `<h1>`, and only the `<h1>`. A declaration,
   *   not a loader: your site is what fetches the face.
   *
   * Anything unusable is warned about in the console and falls back; it never throws.
   */
  pageHeader?: { variant?: "cover" | "flat" | "bare"; accent?: string; titleFont?: string };
  /**
   * Turn off optional list controls. Search and filters stay on by default; whether a CMS
   * needs them is a product decision for the deployment (a small curated library may be
   * better without), so it is taken here rather than by rebuilding the editor.
   *
   * - `"mediaSearch"`: the media library's search field.
   * - `"mediaFilters"`: the media library's sort menu, tag menu and type chips.
   * - `"relationSearch"`: the search input in a relation field's picker.
   *
   * Hiding a control never narrows a list: its state stays at the default, so the list is the
   * complete one. An unknown name is warned about in the console and ignored.
   */
  hideControls?: ("mediaSearch" | "mediaFilters" | "relationSearch")[];
  /**
   * Extra rows in the account menu (the avatar's menu), each opening a screen of the editor.
   *
   * For a destination that belongs with the session's own affordances rather than in the nav:
   * the usual case is a deployment that hides the schema editor's nav entry from everyday
   * editors and offers it here instead.
   *
   * - `page`: which screen, by its editor route id (`"schema"`, `"users"`, `"media"`, …), with
   *   `params` for one that takes them (`{ page: "collection", params: { slug: "lectures" } }`).
   * - `icon`: one of the nav's glyphs (`"types"`, `"settings"`, …), so the row lines up.
   * - `requiresNav`: show the row only when the nav the editor built has an entry with this
   *   key. The nav keys already encode capability (`"types"` exists only for someone who may
   *   author the schema, `"users"` only for an admin), so this is how a row avoids offering a
   *   screen the session would be refused.
   *
   * A row naming an unknown page is dropped with a console warning. A theme built with
   * `buildEditor({ slots: { nav } })` can add rows too, with an arbitrary `visible` predicate.
   */
  accountMenu?: { label: string; page: string; params?: Record<string, string>; icon?: string; requiresNav?: string }[];
  /**
   * Serve an editor YOU built instead of the one this package ships.
   *
   * A directory URL — `"/admin"` for a `buildEditor({ outdir: "public/admin" })`, or an
   * absolute `https://…` — under which all six of its outputs are served: `editor.js`,
   * `editor.css` and the four `panel-*.js` shims. ONE option rather than six URLs because
   * `buildEditor` writes them to one directory and they have to agree: a shim re-exports the
   * names of the React that *that* bundle linked, so a shim from one build sitting beside an
   * editor from another is a browser link error in somebody else's panel.
   *
   * Unset, the packaged assets are used, imported with `?url` so the SITE's bundler emits and
   * fingerprints them. Set, they are referenced exactly as given — a path this build never
   * sees is a path it cannot hash, so **cache-busting becomes yours**: emit under a
   * content-hashed directory, or serve them with a short max-age.
   *
   * The reason to set it is a design system. The packaged bundle has podoba compiled in at the
   * version @pramen/cms-editor pins, so a site whose own design system is podoba would
   * otherwise run two generations of it — `buildEditor({ designSystem })` links yours instead.
   * See "Build it against your own design system" in that package's README.
   */
  editorAssets?: string;
  /**
   * The language of the editor's own copy: every button, heading, dialog and count. `"en"`
   * (the default) or `"cs"`; a region subtag (`"cs-CZ"`) is kept for date and number
   * formatting. Also the shell's `<html lang>`.
   *
   * An unknown language is warned about in the browser console and the editor stays English.
   * The words for your own content types and collections are yours, declared with them
   * (`labels` on `defineContentType` / `collection` in @pramen/cms), in this same language.
   */
  locale?: string;
  /**
   * Replace individual messages of the chosen catalog, by key: `{ "nav.settings": "Account" }`.
   * A plural message takes its forms: `{ "media.count": { one: "{count} asset", other:
   * "{count} assets" } }`. For a deployment that wants one word different, not for a new
   * language. An unknown key, or a value of the wrong shape, is warned about and ignored.
   * The keys are the ones in `@pramen/cms-editor`'s catalog (`src/i18n/catalog/`).
   */
  messages?: Record<string, string | ({ other: string } & { [category in "zero" | "one" | "two" | "few" | "many"]?: string })>;
  /** Extra top-nav links to companion tools the host serves.
   *
   * `target` defaults to `"_blank"`, because a companion tool is normally a separate
   * deployment and the editor's catch-all route would otherwise swallow a same-tab click.
   * Set `"_self"` when the tool is a page of the SAME site as a mounted editor: the mount
   * scopes navigation to its own prefix, so an off-prefix path is left to the browser and
   * a new tab is just clutter. */
  /** `order` places a link against `NAV_ORDER` (from @pramen/cms) instead of leaving it
   * after Settings — the documented example did not typecheck without it. */
  extraNav?: { label: string; href: string; target?: "_blank" | "_self"; order?: number }[];
  /**
   * Module URLs of this deployment's PANEL bundles — your own React screens, rendered
   * inside the editor's chrome at `/apps/<slug>`.
   *
   * A panel is the escape hatch for the screen Block Kit (`adminPage()`) cannot describe:
   * one that needs local interaction — a control that responds as you type, a row that
   * expands, a dialog, a redirect. The entry itself is still declared server-side with
   * `adminPanel()` in `app.ts`, which is what carries the label, the position and the role
   * filter; this option only says where the browser half lives.
   *
   * Each entry is an ES module URL — an absolute path (`/admin/panels.js`, from `public/`),
   * a path your build emitted, or an absolute http(s) URL. It is IMPORTED BY THE EDITOR, not
   * loaded by a script tag: a panel bundle links against the editor's React (see the import
   * map in `PramenAdmin.astro`), so it cannot be evaluated until the editor has published
   * it. Anything that is not an http(s) URL is refused client-side and warned about.
   *
   * Build one with react, react-dom and the JSX runtimes marked EXTERNAL — see "Custom
   * admin panels" in the CMS docs for the recipe and the `registerPanel` call.
   */
  panels?: string[];
  /** Where YOUR SITE renders a page preview — e.g. `"/preview"`.
   *
   * `signPagePreview` mints a token and a RELATIVE url that the CMS Worker itself redeems,
   * and that endpoint answers with JSON: the CMS is headless, so it has the draft but no
   * idea what the page should look like. Unset, the editor's Preview link therefore opens a
   * wall of JSON — correct, and useless to the stakeholder preview exists for.
   *
   * Point this at a route of your own that redeems the token (`client.getPreview(token)`)
   * and renders it with the same components the published page uses; the editor appends
   * `?token=…`. The same seam as `menuHref` and the sitemap's `pageUrl`: the CMS cannot know
   * how a deployment routes, so the deployment says.
   *
   * PAGES only. A collection row has no canonical URL — the site decides what, if anything,
   * one looks like — so `signCollectionPreview` keeps returning the backend's JSON. */
  previewUrl?: string;
}

/** Options for the injected admin route. `true` is "mount it with the integration's own
 * backend and no other configuration". */
export type AdminOptions = boolean | Omit<AdminRuntimeConfig, "backend">;

/** Characters that must not survive into an inline `<script>` verbatim. */
const UNSAFE_IN_SCRIPT = /[<\u2028\u2029]/g;

/** `<` as a JS unicode escape (so `</script>` cannot close the tag), and U+2028/U+2029 —
 * legal in JSON strings, and historically line terminators in JS source — as their own. */
function escapeForScript(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * Serialize the runtime config for an inline `<script>`.
 *
 * `</script>` inside any string value would close the tag early and drop the rest of the
 * page into the browser's HTML parser — and every one of these fields (a brand name, a nav
 * label) is content someone types. Escaping at the JSON level is the fix that does not
 * depend on where in the object the value happens to sit.
 */
export function serializeAdminConfig(cfg: AdminRuntimeConfig): string {
  return `window.PRAMEN_CMS_EDITOR=${JSON.stringify(cfg).replace(UNSAFE_IN_SCRIPT, escapeForScript)};`;
}

/** The shell's `<title>`, which is only the pre-hydration fallback — the bundle re-applies
 * the wordmark itself on boot. Mirrors `brand.ts`'s rule so the tab does not visibly change
 * text a moment after load: a configured name replaces the whole string (nothing English is
 * appended to a client's name), and `suffix: null` drops the second half. */
export function adminDocumentTitle(cfg: AdminRuntimeConfig): string {
  const name = cfg.brand?.name?.trim();
  if (!name) return "pramen · cms editor";
  const suffix = cfg.brand?.suffix === undefined ? "cms" : cfg.brand.suffix;
  return suffix ? `${name} · ${suffix}` : name;
}

/**
 * The shell's `<html lang>`: the configured `locale`, canonicalized, else `"en"`.
 *
 * Only the pre-hydration value, like the title: the editor re-stamps the attribute on boot
 * with the language it actually resolved, which is English again for a locale it ships no
 * catalog for. A value that is not a language tag at all is not written into the document.
 */
export function adminLang(cfg: AdminRuntimeConfig): string {
  const raw = typeof cfg.locale === "string" ? cfg.locale.trim() : "";
  if (!raw) return "en";
  try {
    return Intl.getCanonicalLocales(raw)[0] ?? "en";
  } catch {
    return "en";
  }
}

/** Build the runtime config from the integration's options and its backend descriptor. */
export function adminRuntimeConfig(admin: AdminOptions, backend: { url: string; tenant?: string }): AdminRuntimeConfig {
  const extra = admin === true ? {} : admin || {};
  return { ...extra, backend: { url: backend.url.replace(/\/+$/, ""), tenant: backend.tenant ?? "main" } };
}

/** Does this deployment declare any panel bundles?
 *
 * Gates the import map in the shell. The map is inert with no panels — nothing else on that
 * page imports a bare specifier — but it is a document-wide rewrite of what `react` means,
 * and a page that does not need one should not carry one. It also makes the feature legible
 * in the served HTML: the map is there exactly when panels are.
 */
export function adminHasPanels(cfg: AdminRuntimeConfig): boolean {
  return (cfg.panels?.length ?? 0) > 0;
}

/** The six files the shell references: the bundle, its stylesheet, and the four panel shims. */
export interface AdminAssetUrls {
  editor: string;
  css: string;
  react: string;
  reactDom: string;
  jsxRuntime: string;
  jsxDevRuntime: string;
}

/**
 * Which editor the shell points at: the packaged one, or the host's own build.
 *
 * All six move together or none do — see `editorAssets`. Taking them as a set rather than
 * letting a deployment override one is what makes "the shims match the bundle that generated
 * them" a property of the type instead of a sentence in a doc comment.
 *
 * Validated here rather than at the call site because the failure is remote from the cause: a
 * base like `"admin"` yields `admin/editor.js`, which resolves against whatever path the
 * editor was deep-linked to (`/__admin/pages/42/admin/editor.js`) and 404s on some routes and
 * not others. Anything that is not root-relative or absolute is refused with the shape it
 * needs, at build time.
 */
export function adminAssetUrls(base: string | undefined, packaged?: AdminAssetUrls): AdminAssetUrls {
  if (base === undefined) {
    // The shell resolves the packaged URLs only when they are the ones being served (see
    // `PramenAdmin.astro`), so "neither" is not a deployment state — it is this function
    // being called wrong, and silently returning six empty strings would ship a shell whose
    // module script has no src.
    if (!packaged) throw new Error("@pramen/cms-astro: adminAssetUrls needs either an editorAssets base or the packaged URLs");
    return packaged;
  }
  if (!/^(?:\/|https?:\/\/)/.test(base)) {
    throw new Error(`@pramen/cms-astro: admin.editorAssets must be root-relative ("/admin") or absolute ("https://…") — got ${JSON.stringify(base)}, which the browser would resolve against the current admin route.`);
  }
  const at = base.replace(/\/+$/, "");
  return {
    editor: `${at}/editor.js`,
    css: `${at}/editor.css`,
    react: `${at}/panel-react.js`,
    reactDom: `${at}/panel-react-dom.js`,
    jsxRuntime: `${at}/panel-jsx-runtime.js`,
    jsxDevRuntime: `${at}/panel-jsx-dev-runtime.js`,
  };
}

/**
 * The import map that lets a panel bundle's `import … from "react"` resolve to the React the
 * editor already loaded.
 *
 * The alternative was to make each consumer alias those specifiers in their own bundler, and
 * it is worse in the way that matters: a panel would then be React code that cannot be built
 * like React code, and the port of an existing screen would start with a build-config
 * archaeology session. With the map, a panel is ordinary source built with three externals.
 *
 * It has to be in the DOCUMENT, and ahead of every module script — an import map cannot be
 * added by the editor at runtime once module loading has begun — which is why this is the
 * shell's job and not the bundle's. The three shim modules it points at are generated at
 * build time from the editor's own React namespaces, so the names they re-export cannot
 * drift from the React that is actually loaded.
 */
export function adminImportMap(urls: { react: string; reactDom: string; jsxRuntime: string; jsxDevRuntime: string }): string {
  return JSON.stringify({
    imports: {
      react: urls.react,
      "react-dom": urls.reactDom,
      "react/jsx-runtime": urls.jsxRuntime,
      // The specifier an UNMINIFIED panel build emits. Mapped for the same reason the other
      // three are: unmapped, it is the one bare import that still resolves — from the
      // consumer's own node_modules, into a second React nobody asked for.
      "react/jsx-dev-runtime": urls.jsxDevRuntime,
    },
  });
}
