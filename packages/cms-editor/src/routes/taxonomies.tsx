// The vocabularies list (`/taxonomies`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { TaxonomiesView } from "../furniture";

export default createPage()
  .route("/taxonomies")
  .render(function TaxonomiesRoute() {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    return <TaxonomiesView api={api} canEdit={cms.canEdit} onOpen={(slug) => navigate("taxonomy", { params: { slug } })} onError={setError} />;
  });
