// Users management route (`/users`) — admin only. The tab is hidden for non-admins, but
// the route guards independently (a direct deep link by a non-admin gets a notice, and
// the server enforces the ACL regardless).

import { createPage, useNavigate } from "@buzola/router";
import { Button } from "@podoba/react";
import { useApp } from "../app-context";
import { UsersView } from "../components";

export default createPage()
  .route("/users")
  .render(function Users() {
    const { api, me, isAdmin, setError } = useApp();
    const navigate = useNavigate();

    if (me === null) return <div className="mx-auto max-w-[1200px] px-7 pt-8"><p className="text-fg-subtle">Loading…</p></div>;
    if (!isAdmin) {
      return (
        <div className="mx-auto flex max-w-[1200px] items-center gap-2 px-7 pt-8">
          <p className="text-fg-subtle">Admins only.</p>
          <Button variant="ghost" size="sm" onPress={() => navigate("home")}>← back to pages</Button>
        </div>
      );
    }
    return <UsersView api={api} me={me} onError={setError} />;
  });
