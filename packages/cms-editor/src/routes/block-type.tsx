// One block type's builder (`/schema/blocks/:slug`); `new` creates one.

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { Notice } from "../components";
import { BlockTypeEditor, useStableError } from "../schema-builder";

export default createPage()
  .params({ slug: "string" })
  .route("/schema/blocks/:slug")
  .render(function BlockTypeRoute({ params }) {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    const onError = useStableError(setError);
    if (!cms.canEdit) return <Notice>Authoring types needs an editor role.</Notice>;
    return (
      <BlockTypeEditor
        api={api}
        // Keyed on the slug so switching between two types REMOUNTS the form: buzola renders
        // the same component instance across a params-only change, and the draft state
        // belongs to one type.
        key={params.slug}
        slug={params.slug}
        onSaved={(slug) => navigate("block-type", { params: { slug } })}
        onBack={() => navigate("schema")}
        onError={onError}
      />
    );
  });
