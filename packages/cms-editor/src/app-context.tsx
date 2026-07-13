// App-wide context for the routed editor: the HTTP client, the persisted config, the
// signed-in identity (`me`), and a global error sink rendered by the root layout. Also
// owns the pre-route config gate — when there's no base URL + token yet, it renders the
// Setup screen instead of mounting the router at all.

import { Button, Input } from "@podoba/react";
import { createContext, use, useEffect, useMemo, useState } from "react";
import { Api, clearConfig, isTokenExpired, loadConfig, saveConfig, type Config } from "./api";

declare global {
  interface Window {
    /** Runtime config set by the host's /config.js (see @pramen/cms-editor build). */
    PRAMEN_CMS_EDITOR?: { signInUrl?: string };
  }
}

/** External sign-in URL, if the host configured one via /config.js. When set, an
 * unauthenticated OR expired session is redirected here instead of the built-in Setup
 * screen — for deployments whose auth (magic-link, SSO, …) lives on a separate page. */
const SIGN_IN_URL: string | undefined = typeof window !== "undefined" ? window.PRAMEN_CMS_EDITOR?.signInUrl : undefined;

/** Drop the stale session and hand off to the external sign-in page. */
function redirectToSignIn(): void {
  clearConfig();
  location.replace(SIGN_IN_URL!);
}

export interface Me {
  userId?: string;
  roles?: string[];
  [k: string]: unknown;
}

interface AppContextValue {
  api: Api;
  cfg: Config;
  me: Me | null;
  isAdmin: boolean;
  error: string;
  setError: (s: string) => void;
  /** Sign out — drop the token so the config gate falls back to Setup. */
  reconfigure: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = use(AppContext);
  if (!v) throw new Error("useApp must be used within <AppProvider>");
  return v;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [cfg, setCfg] = useState<Config>(loadConfig());
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  // A usable session = a base URL + a token that is NOT expired. An expired token counts as
  // no session: otherwise the editor mounts and every RPC 403s into an error banner.
  const authValid = Boolean(cfg.baseUrl && cfg.token) && !isTokenExpired(cfg.token);
  const api = useMemo(() => new Api(cfg, SIGN_IN_URL ? redirectToSignIn : undefined), [cfg]);

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
    api.call<Me>("me").then(setMe).catch(() => setMe({}));
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
    error,
    setError,
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
        <h1 className="mb-4 text-display text-fg">
          pramen <span className="text-fg-subtle">· cms editor</span>
        </h1>
        <p className="mb-6 text-sm text-fg-muted">
          Point at your Worker and paste an editor/reviewer JWT. CORS must allow this origin (<code>CORS_ORIGINS</code>).
        </p>
        <div className="flex flex-col gap-4">
          <Input label="Worker base URL" value={c.baseUrl} onChange={(baseUrl) => setC({ ...c, baseUrl })} placeholder="https://your-worker.workers.dev" />
          <Input label="Tenant" value={c.tenant} onChange={(tenant) => setC({ ...c, tenant })} placeholder="main" />
          <Input label="Bearer token (editor or reviewer)" value={c.token} onChange={(token) => setC({ ...c, token })} placeholder="eyJ…" />
          <Button className="mt-2 w-full" onPress={() => onSave(c)} isDisabled={!c.baseUrl || !c.token}>
            Connect
          </Button>
        </div>
      </div>
    </div>
  );
}
