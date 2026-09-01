// App-wide context for the routed editor: the HTTP client, the persisted config, the
// signed-in identity (`me`), and a global error sink rendered by the root layout. Also
// owns the pre-route config gate — when there's no base URL + token yet, it renders the
// Setup screen instead of mounting the router at all.

import { Button, Input } from "@podoba/react";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, clearConfig, isTokenExpired, loadConfig, saveConfig, type Config } from "./api";
import { BRAND, SETUP_TITLE, type BrandConfig } from "./brand";
import { readBackend, type BackendHost } from "./mount";
import { DEFAULT_CAPABILITIES, type CmsCapabilities, type CollectionMeta, type ContentType, type JsonValue } from "./types";

declare global {
  interface Window {
    /** Runtime config written by the SHELL that served the editor — a server-rendered
     * inline script, not a file anyone hand-edits (see `PramenAdmin.astro` in
     * @pramen/cms-astro, and the dev preview in scripts/build.ts). */
    PRAMEN_CMS_EDITOR?: {
      /** Which CMS Worker to call, and as which tenant. Declared by the shell because the
       * server already knows — it is what makes the Setup screen a token field and
       * nothing else. `url: ""` means the CMS is on this same origin. */
      backend?: { url?: string; tenant?: string };
      signInUrl?: string;
      /** Hide the Pages tab for deployments that use collections only — no block/page
       * building. The tab is otherwise always shown and lands on an empty list, which
       * reads as "the CMS is broken" rather than "this site has no pages". */
      hidePages?: boolean;
      /** Extra top-nav links to companion tools the host serves (e.g. a curation page).
       * Rendered as plain external `<a>` links after the built-in tabs. */
      extraNav?: { label: string; href: string; target?: "_blank" | "_self" }[];
      /** The wordmark in the topbar, on the Setup screen, and in the browser tab.
       *
       * This editor ships as a package an agency deploys FOR ITS CLIENT, so the default
       * put the framework's name where the client's belongs — someone logging into their
       * own CMS was greeted by "pramen". Set `name` (and optionally `suffix`) to the
       * deployment's own; `suffix: null` drops the "· cms" half entirely. */
      brand?: BrandConfig;
    };
  }
}

/** The backend the shell declared, or `undefined` when it declared none (the dev preview's
 * standalone mode). Present ⇒ the Setup screen asks for a token and nothing else. */
const BACKEND = readBackend(globalThis as BackendHost);

/** External sign-in URL, if the host configured one. When set, an
 * unauthenticated OR expired session is redirected here instead of the built-in Setup
 * screen — for deployments whose auth (magic-link, SSO, …) lives on a separate page.
 *
 * `?setup=1` forces the built-in Setup screen even when a sign-in URL is configured — the
 * bootstrap escape hatch for pasting a first-admin JWT before any account exists. */
const SIGN_IN_URL: string | undefined =
  typeof window !== "undefined" && !new URLSearchParams(window.location.search).has("setup") ? window.PRAMEN_CMS_EDITOR?.signInUrl : undefined;

/** Drop the stale session and hand off to the external sign-in page. */
function redirectToSignIn(): void {
  clearConfig();
  location.replace(SIGN_IN_URL!);
}

export interface Me {
  userId?: string;
  roles?: string[];
  [k: string]: JsonValue | undefined;
}

/**
 * Whether the SERVER accepted this session — the answer to `me`, which is the identity it
 * resolved the bearer token to, or `null` when it resolved none.
 *
 * The editor used to decide it was signed in from the token's own `exp` claim alone, read
 * client-side. That covers exactly one way to stop being signed in. Every other way — the
 * signing secret rotated, the account deleted or deactivated, the token revoked onto the
 * denylist, a stored token from an older deployment — leaves an unexpired `exp` on a token
 * the server treats as ANONYMOUS. And anonymous is not an error here: pramen's ACL answers
 * it, so the editor mounted and rendered a shell that looked signed in and was empty.
 * `listContentTypes` and `listBlockTypes` 403 into swallowed catches, `me` comes back null,
 * so the tabs collapse to the pre-types default and the page list shows only what the public
 * can read — no error, no way back, nothing to click.
 *
 * `userId`, not truthiness of the object: `me` for an anonymous caller is `null` today, but
 * an identity carrying no subject is the same non-answer and must not read as a session.
 */
export function hasIdentity(me: Me | null | undefined): boolean {
  return typeof me?.userId === "string" && me.userId !== "";
}

interface AppContextValue {
  api: Api;
  cfg: Config;
  me: Me | null;
  isAdmin: boolean;
  /** Collections registered on the server (from `listCollections`) — drives the nav + the
   * generic list/edit routes. Empty when the server registers none. */
  collections: CollectionMeta[];
  /** Content types registered on the server (from `listContentTypes`). More than one ⇒ each
   * gets its own nav tab and its own list route, instead of one pooled "Pages" list where a
   * page and an article sit in the same column with nothing to tell them apart. */
  contentTypes: ContentType[];
  /** What the SERVER says this deployment supports (from `listCmsCapabilities`) — today,
   * its declared locales. The editor renders its i18n surface off this rather than a local
   * flag, so the UI and the data can never disagree about whether the site is multilingual. */
  cms: CmsCapabilities;
  error: string;
  setError: (s: string) => void;
  /** Sign out — drop the token so the config gate falls back to Setup. */
  reconfigure: () => void;
  /** Ask the current screen whether it is safe to navigate away; `false` cancels.
   * `beforeunload` only covers a real page unload, so in-app navigation (the topbar, sign
   * out) would otherwise discard unsaved edits with no prompt. With no guard registered
   * this is always `true`. */
  confirmNavigation: () => boolean;
  /** Register the current screen's guard (`null` on unmount). Screens that can hold
   * unsaved edits — the page editor — register here; the root layout consults it. */
  setNavGuard: (fn: (() => boolean) | null) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = use(AppContext);
  if (!v) throw new Error("useApp must be used within <AppProvider>");
  return v;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [cfg, setCfg] = useState<Config>(() => loadConfig(BACKEND));
  const [me, setMe] = useState<Me | null>(null);
  const [collections, setCollections] = useState<CollectionMeta[]>([]);
  const [contentTypes, setContentTypes] = useState<ContentType[]>([]);
  const [cms, setCms] = useState<CmsCapabilities>(DEFAULT_CAPABILITIES);
  const [error, setError] = useState("");
  // A usable session = somewhere to call + a token that is NOT expired. An expired token
  // counts as no session: otherwise the editor mounts and every RPC 403s into an error
  // banner. "Somewhere to call" is satisfied by a declared backend even when its url is the
  // empty string, which is the same-origin case and a perfectly good place to call.
  const authValid = Boolean(BACKEND || cfg.baseUrl) && Boolean(cfg.token) && !isTokenExpired(cfg.token);
  const api = useMemo(() => new Api(cfg, SIGN_IN_URL ? redirectToSignIn : undefined), [cfg]);

  // Unsaved-changes guard for in-app navigation. A ref, not state: the guard is read at
  // click time and re-registering it must never re-render the whole app. Both accessors are
  // stable so a screen's register effect runs once per mount.
  const navGuard = useRef<(() => boolean) | null>(null);
  const setNavGuard = useCallback((fn: (() => boolean) | null) => { navGuard.current = fn; }, []);
  const confirmNavigation = useCallback(() => navGuard.current?.() ?? true, []);

  // When an external sign-in page is configured, bounce there on boot AND the moment the
  // token expires mid-session (poll + on tab focus), so an idle editor never sits on a dead
  // session showing errors. Keyed on the token's own `exp` — the server can't distinguish an
  // expired token (rejected as anonymous → 403) from a valid token lacking a role.
  useEffect(() => {
    if (!SIGN_IN_URL) return;
    const check = () => { if (!cfg.token || isTokenExpired(cfg.token)) redirectToSignIn(); };
    check();
    const onVisible = () => { if (!document.hidden) check(); };
    const id = window.setInterval(check, 30000);
    window.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [cfg.token]);

  useEffect(() => {
    if (!authValid) return;
    // `me` gates the Users tab + drives Settings — a failing call is fine (leaves it {}).
    //
    // It is also the only thing that asks the server whether this session is real, so a token
    // it will not accept ends the session HERE rather than rendering an empty editor around it
    // (see `hasIdentity`). A THROWN call is not that answer — a network blip or a deployment
    // without auth handlers must not sign anyone out — only a successful call that resolves to
    // no identity is.
    api
      .call<Me>("me")
      .then((identity) => {
        if (hasIdentity(identity)) { setMe(identity); return; }
        // Same handoff the expiry poll makes: to the sign-in page when the host configured
        // one, otherwise drop the token so the built-in Setup screen comes back.
        if (SIGN_IN_URL) redirectToSignIn();
        else { clearConfig(); setCfg((c) => ({ ...c, token: "" })); }
      })
      .catch(() => setMe({}));
    // Collections drive the nav + list/edit routes. An app that registers none (or an older
    // server without the handler) just leaves the nav as-is — a failure is non-fatal.
    api.call<CollectionMeta[]>("listCollections").then(setCollections).catch(() => setCollections([]));
    // Drives the per-type nav + list routes. A failure leaves it empty, which falls back to
    // the single pooled "Pages" tab — the layout before types had tabs of their own.
    api.listContentTypes().then(setContentTypes).catch(() => setContentTypes([]));
    // A server older than this handler leaves the monolingual default, which is the safe
    // way round: the i18n surface stays hidden rather than half-rendered.
    api.call<CmsCapabilities>("listCmsCapabilities").then(setCms).catch(() => setCms(DEFAULT_CAPABILITIES));
  }, [api, authValid]);

  if (!authValid) {
    // Configured external sign-in → hand off (the boot effect above navigates). Otherwise
    // fall back to the built-in Setup screen (paste a JWT).
    return SIGN_IN_URL ? null : <Setup cfg={cfg} onSave={(c) => { saveConfig(c); setCfg(c); }} />;
  }

  const value: AppContextValue = {
    api,
    cfg,
    me,
    isAdmin: (me?.roles ?? []).includes("admin"),
    collections,
    contentTypes,
    cms,
    error,
    setError,
    confirmNavigation,
    setNavGuard,
    reconfigure: () => {
      if (SIGN_IN_URL) { redirectToSignIn(); return; }
      setMe(null); setError(""); setCfg({ ...cfg, token: "" });
    },
  };
  return <AppContext value={value}>{children}</AppContext>;
}

function Setup({ cfg, onSave }: { cfg: Config; onSave: (c: Config) => void }) {
  const [c, setC] = useState(cfg);
  return (
    <div className="mx-auto mt-[14vh] w-full max-w-[520px] px-6">
      <div className="rounded-panel border border-border bg-surface-card px-10 py-8 shadow-[0_24px_60px_rgba(30,20,10,0.08)]">
        {/* `SETUP_TITLE`, not `BRAND.title`: this screen has always read "… cms editor", and
            the default has to render byte-identical to before the brand seam existed. */}
        <h1 className="mb-4 text-display text-fg">
          {BRAND.name} <span className="text-fg-subtle">{SETUP_TITLE}</span>
        </h1>
        {/* Two screens, because there are two things a deployment can leave unanswered. When
            the shell declared a backend there is nothing to point at — asking for a URL that
            is already known invites someone to type the mount path instead of the origin and
            get a stream of "non-JSON response" back. */}
        <p className="mb-6 text-sm text-fg-muted">
          {BACKEND ? (
            <>Paste an editor/reviewer JWT to sign in.</>
          ) : (
            <>
              Point at your Worker and paste an editor/reviewer JWT. CORS must allow this origin (<code>CORS_ORIGINS</code>).
            </>
          )}
        </p>
        <div className="flex flex-col gap-4">
          {BACKEND ? null : (
            <>
              <Input label="Worker base URL" value={c.baseUrl} onChange={(baseUrl) => setC({ ...c, baseUrl })} placeholder="https://your-worker.workers.dev" />
              <Input label="Tenant" value={c.tenant} onChange={(tenant) => setC({ ...c, tenant })} placeholder="main" />
            </>
          )}
          <Input label="Bearer token (editor or reviewer)" value={c.token} onChange={(token) => setC({ ...c, token })} placeholder="eyJ…" />
          <Button className="mt-2 w-full" onPress={() => onSave(c)} isDisabled={(!BACKEND && !c.baseUrl) || !c.token}>
            Connect
          </Button>
        </div>
      </div>
    </div>
  );
}
