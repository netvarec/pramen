// One vocabulary's terms (`/taxonomies/:slug`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { Notice } from "../components";
import { TaxonomyEditor } from "../furniture";

export default createPage()
  .params({ slug: "string" })
  .route("/taxonomies/:slug")
  .render(function TaxonomyRoute({ params }) {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    // The nav hides these on a server without the handlers, but a BOOKMARK does not —
    // without this the screen mounts fully interactive and every call 404s. The
    // `/schema` routes already gated on their own capability; these did not.
    if (!cms.siteFurniture) return <Notice>This deployment's CMS does not provide site furniture.</Notice>;
    return (
      <TaxonomyEditor
        api={api}
        key={params.slug}
        slug={params.slug}
        canEdit={cms.canEdit}
        onBack={() => navigate("taxonomies")}
        onDeleted={() => navigate("taxonomies")}
        onError={setError}
      />
    );
  });
