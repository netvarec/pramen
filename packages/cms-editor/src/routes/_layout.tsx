// Root layout: the persistent chrome (top bar + tab nav + global error banner) wrapped
// around every route via <Outlet />. Tab highlighting is derived from the current path,
// so a deep link or refresh lands with the right tab lit.

import { Outlet, useNavigate, useRoute } from "@buzola/router";
import { Button } from "@podoba/react";
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

  const tabCls = (key: string) =>
    active === key ? "bg-surface-muted text-fg" : "text-fg-muted";

  return (
    <>
      <div className="sticky top-0 z-10 flex items-center gap-4 bg-surface px-7 py-4">
        <span className="text-[15px] font-bold tracking-[0.01em] text-fg">
          pramen <span className="font-normal text-fg-subtle">· cms</span>
        </span>
        <span className="flex-1" />
        <nav className="flex items-center gap-0.5">
          <Button variant="ghost" size="sm" className={tabCls("pages")} onPress={() => navigate("home")}>Pages</Button>
          <Button variant="ghost" size="sm" className={tabCls("media")} onPress={() => navigate("media")}>Media</Button>
          {isAdmin ? (
            <Button variant="ghost" size="sm" className={tabCls("users")} onPress={() => navigate("users")}>Users</Button>
          ) : null}
          <Button variant="ghost" size="sm" className={tabCls("settings")} onPress={() => navigate("settings")}>Settings</Button>
        </nav>
        <span className="ml-3 text-fg-subtle">{cfg.tenant}</span>
        <Button variant="ghost" size="sm" onPress={reconfigure}>sign out</Button>
      </div>
      {error ? (
        <div className="mx-7 mt-2 rounded-lg border border-danger bg-surface-card px-4 py-2.5 text-sm text-danger">{error}</div>
      ) : null}
      <Outlet />
    </>
  );
}
