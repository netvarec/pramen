// One vocabulary's terms (`/taxonomies/:slug`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { TaxonomyEditor } from "../furniture";

export default createPage()
  .params({ slug: "string" })
  .route("/taxonomies/:slug")
  .render(function TaxonomyRoute({ params }) {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
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
