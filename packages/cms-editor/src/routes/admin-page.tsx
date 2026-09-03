// A custom admin page (`/apps/:slug`) — Block Kit, rendered inside the editor's own chrome.
//
// Routed BY THE EDITOR, which is the point: an `extraNav` link has to open a new tab,
// because `_404.tsx` registers the catch-all `/:__notFound+` and a same-tab click on an
// unmounted editor lands on the in-app 404. A registered page has a real route, so it is
// part of the admin rather than a link out of it.

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { AdminPageView } from "../blockkit";
import { Notice } from "../components";
import { useStableError } from "../schema-builder";
import { Button } from "@podoba/react";

export default createPage()
  .params({ slug: "string" })
  .route("/apps/:slug")
  .render(function AdminPageRoute({ params }) {
    const { api, adminPages, setError } = useApp();
    const navigate = useNavigate();
    const onError = useStableError(setError);
    const def = adminPages.find((p) => p.slug === params.slug);

    // `listAdminPages` is role-FILTERED server-side, so an absent slug means either "still
    // loading" or "not yours / not registered" — and the two are told apart by whether the
    // list has arrived at all, exactly as the collection route does it.
    if (!def) {
      return (
        <Notice action={adminPages.length > 0 ? <Button variant="ghost" size="sm" onPress={() => navigate("home")}>← Pages</Button> : undefined}>
          {adminPages.length === 0 ? "Loading…" : `Unknown page: ${params.slug}`}
        </Notice>
      );
    }
    // Keyed on the slug so switching between two pages REMOUNTS the view: buzola renders the
    // same component instance across a params-only change, and the blocks, the form values
    // and any toast all belong to one page.
    return <AdminPageView api={api} key={def.slug} slug={def.slug} label={def.label} onError={onError} />;
  });
