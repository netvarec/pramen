// Account settings route (`/settings`).

import { createPage } from "@buzola/router";
import { useApp } from "../app-context";
import { SettingsView } from "../components";

export default createPage()
  .route("/settings")
  .render(function Settings() {
    const { api, cfg, me, setError, reconfigure } = useApp();
    return <SettingsView api={api} cfg={cfg} me={me} onSignOut={reconfigure} onError={setError} />;
  });
