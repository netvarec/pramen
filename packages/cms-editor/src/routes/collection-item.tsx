// Collection item route (`/collections/:slug/:id`). `:id` == "new" is the create form;
// any other value edits that row. Both render through the generic CollectionEditor
// (FieldForm over the collection's field schema). All navigation returns to the list.

import { createPage, useNavigate, useRouter } from "@buzola/router";
import { Button } from "@podoba/react";
import { useApp } from "../app-context";
import { useI18n } from "../i18n";
import { CollectionEditor, Notice } from "../components";

export default createPage()
  .params({ slug: "string", id: "string" })
  .route("/collections/:slug/:id")
  .render(function CollectionItemRoute({ params }) {
    const { api, collections, collectionsReady, setError } = useApp();
    const navigate = useNavigate();
    const { t } = useI18n();
    const router = useRouter();
    const def = collections.find((c) => c.slug === params.slug);
    const backToList = () => navigate("collection", { params: { slug: params.slug } });

    if (!def) {
      return (
        <Notice action={collectionsReady ? <Button variant="ghost" size="sm" onPress={() => navigate("home")}>{t("pages.backShort")}</Button> : undefined}>
          {!collectionsReady ? t("common.loading") : t("collection.unknown", { slug: params.slug })}
        </Notice>
      );
    }
    return (
      <CollectionEditor
        api={api}
        def={def}
        id={params.id === "new" ? null : params.id}
        onSaved={backToList}
        onDeleted={backToList}
        onBack={backToList}
        backHref={router.buildPagePath("collection", { slug: params.slug })}
        onError={setError}
      />
    );
  });
