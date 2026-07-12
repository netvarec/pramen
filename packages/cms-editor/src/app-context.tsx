// App-wide context for the routed editor: the HTTP client, the persisted config, the
// signed-in identity (`me`), and a global error sink rendered by the root layout. Also
// owns the pre-route config gate — when there's no base URL + token yet, it renders the
// Setup screen instead of mounting the router at all.

import { createContext, use, useEffect, useMemo, useState } from "react";
import { Api, loadConfig, saveConfig, type Config } from "./api";

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
  const api = useMemo(() => new Api(cfg), [cfg]);
  const configured = Boolean(cfg.baseUrl && cfg.token);

  useEffect(() => {
    if (!configured) return;
    // `me` gates the Users tab + drives Settings — a failing call is fine (leaves it {}).
    api.call<Me>("me").then(setMe).catch(() => setMe({}));
  }, [api, configured]);

  if (!configured) {
    return <Setup cfg={cfg} onSave={(c) => { saveConfig(c); setCfg(c); }} />;
  }

  const value: AppContextValue = {
    api,
    cfg,
    me,
    isAdmin: (me?.roles ?? []).includes("admin"),
    error,
    setError,
    reconfigure: () => { setMe(null); setError(""); setCfg({ ...cfg, token: "" }); },
  };
  return <AppContext value={value}>{children}</AppContext>;
}

function Setup({ cfg, onSave }: { cfg: Config; onSave: (c: Config) => void }) {
  const [c, setC] = useState(cfg);
  return (
    <div className="setup">
      <h1>
        pramen <span className="dim">· cms editor</span>
      </h1>
      <p className="muted">Point at your Worker and paste an editor/reviewer JWT. CORS must allow this origin (`CORS_ORIGINS`).</p>
      <label className="field">
        <span className="lbl">Worker base URL</span>
        <input value={c.baseUrl} onChange={(e) => setC({ ...c, baseUrl: e.target.value })} placeholder="https://your-worker.workers.dev" />
      </label>
      <label className="field">
        <span className="lbl">Tenant</span>
        <input value={c.tenant} onChange={(e) => setC({ ...c, tenant: e.target.value })} placeholder="main" />
      </label>
      <label className="field">
        <span className="lbl">Bearer token (editor or reviewer)</span>
        <input value={c.token} onChange={(e) => setC({ ...c, token: e.target.value })} placeholder="eyJ…" />
      </label>
      <button className="primary" onClick={() => onSave(c)} disabled={!c.baseUrl || !c.token}>
        Connect
      </button>
    </div>
  );
}
