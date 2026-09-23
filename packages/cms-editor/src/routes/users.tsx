// Users management route (`/users`) — admin only. The tab is hidden for non-admins, but
// the route guards independently (a direct deep link by a non-admin gets a notice, and
// the server enforces the ACL regardless).

import { createPage, useNavigate } from "@buzola/router";
import { Button } from "@podoba/react";
import { useApp } from "../app-context";
import { CONTENT } from "../chrome";
import { UsersView } from "../components";
import { useI18n } from "../i18n";

export default createPage()
  .route("/users")
  .render(function Users() {
    const { api, me, isAdmin, setError } = useApp();
    const navigate = useNavigate();
    const { t } = useI18n();

    if (me === null) return <div className={`${CONTENT} pt-8`}><p className="text-fg-subtle">{t("common.loading")}</p></div>;
    if (!isAdmin) {
      return (
        <div className={`${CONTENT} flex items-center gap-2 pt-8`}>
          <p className="text-fg-subtle">{t("users.adminsOnly")}</p>
          <Button variant="ghost" size="sm" onPress={() => navigate("home")}>{t("pages.backToPages")}</Button>
        </div>
      );
    }
    return <UsersView api={api} me={me} onError={setError} />;
  });
