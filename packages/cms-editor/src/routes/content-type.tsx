// One content type's builder (`/schema/content/:slug`); `new` creates one.

import { createPage, useNavigate, useRouter } from "@buzola/router";
import { useApp } from "../app-context";
import { Notice } from "../components";
import { useI18n } from "../i18n";
import { ContentTypeEditor } from "../schema-builder";

export default createPage()
  .params({ slug: "string" })
  .route("/schema/content/:slug")
  .render(function ContentTypeBuilderRoute({ params }) {
    const { api, cms, setError, refreshContentTypes } = useApp();
    const navigate = useNavigate();
    const { t } = useI18n();
    const router = useRouter();
    if (!cms.canEdit) return <Notice>{t("schema.needsEditor")}</Notice>;
    return (
      <ContentTypeEditor
        api={api}
        codeDefinedTypes={cms.codeDefinedTypes}
        typeDeletion={cms.typeDeletion}
        onDeleted={() => { refreshContentTypes(); navigate("schema"); }}
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
        backHref={router.buildPagePath("schema")}
        onError={setError}
      />
    );
  });
