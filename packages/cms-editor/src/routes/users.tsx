// Users management route (`/users`) — admin only. The tab is hidden for non-admins, but
// the route guards independently (a direct deep link by a non-admin gets a notice, and
// the server enforces the ACL regardless).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { UsersView } from "../components";

export default createPage()
  .route("/users")
  .render(function Users() {
    const { api, me, isAdmin, setError } = useApp();
    const navigate = useNavigate();

    if (me === null) return <div className="list-wrap"><p className="muted">Loading…</p></div>;
    if (!isAdmin) {
      return (
        <div className="list-wrap">
          <p className="muted">Admins only. <button className="ghost sm" onClick={() => navigate("home")}>← back to pages</button></p>
        </div>
      );
    }
    return <UsersView api={api} me={me} onError={setError} />;
  });
