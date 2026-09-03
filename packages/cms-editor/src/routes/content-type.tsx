// One content type's builder (`/schema/content/:slug`); `new` creates one.

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { Notice } from "../components";
import { ContentTypeEditor } from "../schema-builder";

export default createPage()
  .params({ slug: "string" })
  .route("/schema/content/:slug")
  .render(function ContentTypeBuilderRoute({ params }) {
    const { api, cms, setError, refreshContentTypes } = useApp();
    const navigate = useNavigate();
    if (!cms.canEdit) return <Notice>Authoring types needs an editor role.</Notice>;
    return (
      <ContentTypeEditor
        api={api}
        codeDefinedTypes={cms.codeDefinedTypes}
        key={params.slug}
        slug={params.slug}
        onSaved={(slug) => {
          // The nav's per-type tabs come from `listContentTypes`, which the app context
          // fetched once at boot — without this a type created here has no tab until the
          // next full reload, which reads as "it didn't save".
          refreshContentTypes();
          navigate("content-type", { params: { slug } });
        }}
        onBack={() => navigate("schema")}
        onError={setError}
      />
    );
  });
