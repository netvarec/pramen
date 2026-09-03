// The vocabularies list (`/taxonomies`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { TaxonomiesView } from "../furniture";
import { useStableError } from "../schema-builder";

export default createPage()
  .route("/taxonomies")
  .render(function TaxonomiesRoute() {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    const onError = useStableError(setError);
    return <TaxonomiesView api={api} canEdit={cms.canEdit} onOpen={(slug) => navigate("taxonomy", { params: { slug } })} onError={onError} />;
  });
