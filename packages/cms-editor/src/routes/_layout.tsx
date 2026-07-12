// Root layout: the persistent chrome (top bar + tab nav + global error banner) wrapped
// around every route via <Outlet />. Tab highlighting is derived from the current path,
// so a deep link or refresh lands with the right tab lit.

import { Outlet, useNavigate, useRoute } from "@buzola/router";
import { useApp } from "../app-context";

export default function RootLayout() {
  const { cfg, isAdmin, error, reconfigure } = useApp();
  const navigate = useNavigate();
  const { pathname } = useRoute();

  // "Pages" stays lit while editing a page (/pages/:id) too.
  const active = pathname.startsWith("/pages") || pathname === "/" ? "pages"
    : pathname.startsWith("/media") ? "media"
    : pathname.startsWith("/users") ? "users"
    : pathname.startsWith("/settings") ? "settings"
    : "";

  return (
    <>
      <div className="bar">
        <span className="brand">
          pramen <span className="dim">· cms</span>
        </span>
        <span className="grow" />
        <nav className="tabs nav" style={{ margin: 0 }}>
          <button className={active === "pages" ? "on" : ""} onClick={() => navigate("home")}>Pages</button>
          <button className={active === "media" ? "on" : ""} onClick={() => navigate("media")}>Media</button>
          {isAdmin ? (
            <button className={active === "users" ? "on" : ""} onClick={() => navigate("users")}>Users</button>
          ) : null}
          <button className={active === "settings" ? "on" : ""} onClick={() => navigate("settings")}>Settings</button>
        </nav>
        <span className="muted" style={{ marginLeft: 12 }}>{cfg.tenant}</span>
        <button className="ghost sm" onClick={reconfigure}>
          sign out
        </button>
      </div>
      {error ? <div className="banner err">{error}</div> : null}
      <Outlet />
    </>
  );
}
