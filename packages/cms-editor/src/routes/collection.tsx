// Collection list route (`/collections/:slug`). Generic over any registered collection —
// resolves the CollectionMeta from the app context and renders its rows. Opening a row (or
// "+ New") navigates to the item route.

import { createPage, useNavigate } from "@buzola/router";
import { Button } from "@podoba/react";
import { useApp } from "../app-context";
import { useI18n } from "../i18n";
import { CollectionList, Notice } from "../components";

export default createPage()
  .params({ slug: "string" })
  .route("/collections/:slug")
  .render(function CollectionListRoute({ params }) {
    const { api, collections, collectionsReady, setError } = useApp();
    const navigate = useNavigate();
    const { t } = useI18n();
    const def = collections.find((c) => c.slug === params.slug);

    if (!def) {
      // Collections load async; before they arrive (or for a bad slug) show a neutral state.
      return (
        <Notice action={collectionsReady ? <Button variant="ghost" size="sm" onPress={() => navigate("home")}>{t("pages.backShort")}</Button> : undefined}>
          {!collectionsReady ? t("common.loading") : t("collection.unknown", { slug: params.slug })}
        </Notice>
      );
    }
    return (
      <CollectionList
        api={api}
        def={def}
        onOpen={(id) => navigate("collection-item", { params: { slug: def.slug, id } })}
        onNew={() => navigate("collection-item", { params: { slug: def.slug, id: "new" } })}
        onError={setError}
      />
    );
  });
