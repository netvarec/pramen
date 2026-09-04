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

/** Build the runtime config from the integration's options and its backend descriptor. */
export function adminRuntimeConfig(admin: AdminOptions, backend: { url: string; tenant?: string }): AdminRuntimeConfig {
  const extra = admin === true ? {} : admin || {};
  return { ...extra, backend: { url: backend.url.replace(/\/+$/, ""), tenant: backend.tenant ?? "main" } };
}
