// The vocabularies list (`/taxonomies`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { Notice } from "../components";
import { TaxonomiesView } from "../furniture";

export default createPage()
  .route("/taxonomies")
  .render(function TaxonomiesRoute() {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    // The nav hides these on a server without the handlers, but a BOOKMARK does not —
    // without this the screen mounts fully interactive and every call 404s. The
    // `/schema` routes already gated on their own capability; these did not.
    if (!cms.siteFurniture) return <Notice>This deployment's CMS does not provide site furniture.</Notice>;
    return <TaxonomiesView api={api} canEdit={cms.canEdit} onOpen={(slug) => navigate("taxonomy", { params: { slug } })} onError={setError} />;
  });
