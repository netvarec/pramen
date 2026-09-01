// One content type's page list (`/types/:slug`). The pooled list at `/` is what a
// single-type deployment wants; the moment a deployment declares two (pages AND articles,
// say) that list stops being a list of anything in particular — same column, same rows,
// nothing to tell a landing page from a news item. This route is that list scoped to one
// type, and `_layout` gives each type a tab pointing at it.

import { createPage, useNavigate } from "@buzola/router";
import { Button } from "@podoba/react";
import { useEffect, useState } from "react";
import { useApp } from "../app-context";
import { PageList, errMsg } from "../components";
import type { BlockType, Page } from "../types";

export default createPage()
  .params({ slug: "string" })
  .route("/types/:slug")
  .render(function ContentTypeRoute({ params }) {
    const { api, contentTypes, setError } = useApp();
    const navigate = useNavigate();
    const [pages, setPages] = useState<Page[]>([]);
    const [blockTypes, setBlockTypes] = useState<BlockType[]>([]);
    const type = contentTypes.find((t) => t.slug === params.slug);

    // Filtered SERVER-side (`listPages` takes the slug), so this stays correct past the
    // handler's 100-row cap — narrowing a pooled fetch here would quietly drop the tail.
    // Keyed on the slug, not on `type`: the fetch must not wait on listContentTypes.
    const refreshPages = () => api.listPages(params.slug).then(setPages).catch((e) => setError(errMsg(e)));
    useEffect(() => {
      refreshPages();
      api.listBlockTypes().then(setBlockTypes).catch((e) => setError(errMsg(e)));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, params.slug]);

    // Content types load async; before they arrive (or for a bad slug) show a neutral state
    // rather than an unlabelled list — mirrors the collection route.
    if (!type) {
      return (
        <div className="mx-auto flex max-w-[1200px] items-center gap-2 px-7 pt-8">
          <p className="text-fg-subtle">{contentTypes.length === 0 ? "Loading…" : `Unknown content type: ${params.slug}`}</p>
          {contentTypes.length > 0 ? <Button variant="ghost" size="sm" onPress={() => navigate("home")}>← Back</Button> : null}
        </div>
      );
    }

    return (
      <PageList
        api={api}
        pages={pages}
        blockTypes={blockTypes}
        type={type}
        onOpen={(p) => navigate("page", { params: { pageId: p.id } })}
        onCreated={refreshPages}
        onError={setError}
      />
    );
  });
