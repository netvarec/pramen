// Redirects (`/redirects`) — one screen, because a redirect is a row.

import { createPage } from "@buzola/router";
import { useApp } from "../app-context";
import { Notice } from "../components";
import { t } from "../i18n";
import { RedirectsView } from "../furniture";

export default createPage()
  .route("/redirects")
  .render(function RedirectsRoute() {
    const { api, cms, setError } = useApp();
    // The nav hides these on a server without the handlers, but a BOOKMARK does not —
    // without this the screen mounts fully interactive and every call 404s. The
    // `/schema` routes already gated on their own capability; these did not.
    if (!cms.siteFurniture) return <Notice>{t("furniture.unavailable")}</Notice>;
    return <RedirectsView api={api} canEdit={cms.canEdit} onError={setError} />;
  });
