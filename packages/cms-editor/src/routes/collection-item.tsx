// Collection item route (`/collections/:slug/:id`). `:id` == "new" is the create form;
// any other value edits that row. Both render through the generic CollectionEditor
// (FieldForm over the collection's field schema). All navigation returns to the list.

import { createPage, useNavigate } from "@buzola/router";
import { Button } from "@podoba/react";
import { useApp } from "../app-context";
import { CollectionEditor } from "../components";

export default createPage()
  .params({ slug: "string", id: "string" })
  .route("/collections/:slug/:id")
  .render(function CollectionItemRoute({ params }) {
    const { api, collections, setError } = useApp();
    const navigate = useNavigate();
    const def = collections.find((c) => c.slug === params.slug);
    const backToList = () => navigate("collection", { params: { slug: params.slug } });

    if (!def) {
      return (
        <div className="mx-auto flex max-w-[1200px] items-center gap-2 px-7 pt-8">
          <p className="text-fg-subtle">{collections.length === 0 ? "Loading…" : `Unknown collection: ${params.slug}`}</p>
          {collections.length > 0 ? <Button variant="ghost" size="sm" onPress={() => navigate("home")}>← Pages</Button> : null}
        </div>
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
        onError={setError}
      />
    );
  });
