// One content type's page list (`/types/:slug`). The pooled list at `/` is what a
// single-type deployment wants; the moment a deployment declares two (pages AND articles,
// say) that list stops being a list of anything in particular — same column, same rows,
// nothing to tell a landing page from a news item. This route is that list scoped to one
// type, and `_layout` gives each type a tab pointing at it.

import { createPage, useNavigate } from "@buzola/router";
import { Button } from "@podoba/react";
import { useApp } from "../app-context";
import { Notice, PageList, pagesHidden } from "../components";

export default createPage()
  .params({ slug: "string" })
  .route("/types/:slug")
  .render(function ContentTypeRoute({ params }) {
    const { contentTypes, contentTypesFailed, refreshContentTypes, api, setError } = useApp();
    const navigate = useNavigate();
    const type = (contentTypes ?? []).find((t) => t.slug === params.slug);
    const back = <Button variant="ghost" size="sm" onPress={() => navigate("home")}>← Back</Button>;

    // This route IS the block/page builder, so a deployment that hides it hides this too —
    // otherwise the flag is bypassed by typing the URL, or by a stale link.
    if (pagesHidden()) return <Notice action={back}>The page builder is not enabled on this deployment.</Notice>;

    // `null` = listContentTypes has not answered yet; `failed` = it answered with an error and
    // this screen cannot name its own type. The two used to collapse into an empty array, so a
    // 5xx (or a session outside `editorRoles ∪ reviewerRoles`, which cannot call
    // listContentTypes at all) sat on "Loading…" forever with the way back suppressed.
    if (contentTypesFailed) {
      return <Notice action={<Button variant="ghost" size="sm" onPress={refreshContentTypes}>Retry</Button>}>Couldn&apos;t load the content types.</Notice>;
    }
    if (contentTypes === null) return <Notice>Loading…</Notice>;
    // Nothing is fetched for a slug that is not a content type — the list would be empty and
    // the heading unlabelled, and both round trips are wasted.
    if (!type) return <Notice action={back}>Unknown content type: {params.slug}</Notice>;

    return (
      <PageList
        api={api}
        // Keyed on the slug so switching tabs REMOUNTS the list: buzola renders the same
        // component instance across a params-only change, and PageList holds the rows,
        // the paging offset and any open create-modal — all of which belong to one type.
        key={type.slug}
        type={type}
        onOpen={(p) => navigate("page", { params: { pageId: p.id } })}
        onError={setError}
      />
    );
  });
