// The types overview (`/schema`) — block types and content types, and the way into their
// builders.
//
// `/schema`, not `/types`: `/types/:slug` is already ONE content type's page list (the tab
// bar's per-type route), and a parent path meaning something entirely different from its
// children is the kind of collision that reads as a bug forever after. The nav label stays
// "Types", because that is what an editor is looking for.

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { Notice } from "../components";
import { TypesOverview } from "../schema-builder";

export default createPage()
  .route("/schema")
  .render(function SchemaRoute() {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();

    // Every handler behind this screen is editor-gated, so a reviewer-only session would
    // get a builder where each save 403s. The nav hides the tab for the same reason; this
    // is the deep-link half of it.
    if (!cms.canEdit) return <Notice>Authoring types needs an editor role.</Notice>;

    return (
      <TypesOverview
        api={api}
        onOpenBlockType={(slug) => navigate("block-type", { params: { slug } })}
        onOpenContentType={(slug) => navigate("content-type", { params: { slug } })}
        onError={setError}
      />
    );
  });
