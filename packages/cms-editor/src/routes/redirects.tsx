// Redirects (`/redirects`) — one screen, because a redirect is a row.

import { createPage } from "@buzola/router";
import { useApp } from "../app-context";
import { RedirectsView } from "../furniture";
import { useStableError } from "../schema-builder";

export default createPage()
  .route("/redirects")
  .render(function RedirectsRoute() {
    const { api, cms, setError } = useApp();
    const onError = useStableError(setError);
    return <RedirectsView api={api} canEdit={cms.canEdit} onError={onError} />;
  });
