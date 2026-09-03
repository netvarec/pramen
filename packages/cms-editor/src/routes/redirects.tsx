// Redirects (`/redirects`) — one screen, because a redirect is a row.

import { createPage } from "@buzola/router";
import { useApp } from "../app-context";
import { RedirectsView } from "../furniture";

export default createPage()
  .route("/redirects")
  .render(function RedirectsRoute() {
    const { api, cms, setError } = useApp();
    return <RedirectsView api={api} canEdit={cms.canEdit} onError={setError} />;
  });
