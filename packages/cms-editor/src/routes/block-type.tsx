// One block type's builder (`/schema/blocks/:slug`); `new` creates one.

import { createPage, useNavigate, useRouter } from "@buzola/router";
import { useApp } from "../app-context";
import { Notice } from "../components";
import { useI18n } from "../i18n";
import { BlockTypeEditor } from "../schema-builder";

export default createPage()
  .params({ slug: "string" })
  .route("/schema/blocks/:slug")
  .render(function BlockTypeRoute({ params }) {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    const { t } = useI18n();
    const router = useRouter();
    if (!cms.canEdit) return <Notice>{t("schema.needsEditor")}</Notice>;
    return (
      <BlockTypeEditor
        api={api}
        codeDefinedTypes={cms.codeDefinedTypes}
        typeDeletion={cms.typeDeletion}
        onDeleted={() => navigate("schema")}
        // Keyed on the slug so switching between two types REMOUNTS the form: buzola renders
        // the same component instance across a params-only change, and the draft state
        // belongs to one type.
        key={params.slug}
        slug={params.slug}
        onSaved={(slug) => navigate("block-type", { params: { slug } })}
        onBack={() => navigate("schema")}
        backHref={router.buildPagePath("schema")}
        onError={setError}
      />
    );
  });
