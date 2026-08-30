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
// which is the entire failure mode a configurable prefix invites. The `_`-prefixed segment
// is a reserved namespace: the host keeps every ordinary path for its own pages.

/** Where the editor is mounted on the host site. */
export const ADMIN_BASE = "/_pramen/admin";

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
  /** Extra top-nav links to companion tools the host serves. */
  extraNav?: { label: string; href: string }[];
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
