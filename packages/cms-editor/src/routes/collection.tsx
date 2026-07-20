// Collection list route (`/collections/:slug`). Generic over any registered collection —
// resolves the CollectionMeta from the app context and renders its rows. Opening a row (or
// "+ New") navigates to the item route.

import { createPage, useNavigate } from "@buzola/router";
import { Button } from "@podoba/react";
import { useApp } from "../app-context";
import { CollectionList } from "../components";

export default createPage()
  .params({ slug: "string" })
  .route("/collections/:slug")
  .render(function CollectionListRoute({ params }) {
    const { api, collections, setError } = useApp();
    const navigate = useNavigate();
    const def = collections.find((c) => c.slug === params.slug);

    if (!def) {
      // Collections load async; before they arrive (or for a bad slug) show a neutral state.
      return (
        <div className="mx-auto flex max-w-[1200px] items-center gap-2 px-7 pt-8">
          <p className="text-fg-subtle">{collections.length === 0 ? "Loading…" : `Unknown collection: ${params.slug}`}</p>
          {collections.length > 0 ? <Button variant="ghost" size="sm" onPress={() => navigate("home")}>← Pages</Button> : null}
        </div>
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
