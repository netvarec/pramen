// Home route (`/`): the page list. Opening a page navigates to /pages/:pageId.

import { createPage, useNavigate } from "@buzola/router";
import { useEffect } from "react";
import { useApp } from "../app-context";
import { PageList, pagesHidden, splitsByType } from "../components";

export default createPage()
  .route("/")
  .render(function Home() {
    const { api, setError, collections, contentTypes, cms } = useApp();
    const navigate = useNavigate();

    // Collections-only deployment: `/` is the Pages list, so land on the first
    // collection instead. Without this, hiding the tab still leaves the landing page
    // showing an empty page list — and still fetching pages, which errors outright on a
    // deployment that never spread cmsSchema.
    const hidePages = pagesHidden();
    const firstCollection = collections[0]?.slug;
    // With more than one content type each gets its own tab and its own list (`/types/:slug`),
    // so the pooled list here has no tab of its own to be reached from and would just be a
    // fourth way to see the same rows. Land on the first type instead. One type (or none, on a
    // server too old to answer) keeps the pooled list — that IS the whole CMS there.
    const splitByType = splitsByType(contentTypes, cms, hidePages);
    // A content type must have a non-empty slug (the server refuses one), but this is data
    // from a server this build does not control, and an empty slug builds `/types/` — a path
    // the router drops the empty segment from, so it matches nothing. Skip such a type rather
    // than redirect into a route that cannot match.
    const firstType = (contentTypes ?? []).find((t) => t.slug !== "")?.slug;
    // ONE condition for the redirect and for the bail below. Gated differently, a split
    // deployment whose first type has no usable slug redirected nowhere and rendered nothing:
    // a permanently blank `/`, which the wordmark leads straight back to.
    const toType = splitByType && firstType !== undefined ? firstType : undefined;

    useEffect(() => {
      if (hidePages && firstCollection) navigate("collection", { params: { slug: firstCollection }, replace: true });
      else if (toType !== undefined) navigate("type", { params: { slug: toType }, replace: true });
    }, [hidePages, firstCollection, toType, navigate]);

    // `hidePages` means this deployment has no block/page builder at all, so `/` never falls
    // through to the page list here — fetching pages is exactly what the flag says not to do
    // (on a deployment that never spread `cmsSchema` it errors outright). It hands off to the
    // first collection, or says so when there is none to hand off to.
    // (Nothing rendered when there is no collection either: `collections` is empty both while
    // it loads and when a deployment registers none, so any message here would be wrong half
    // the time. The layout's chrome is still on screen — the tabs are the way out.)
    if (hidePages) return null;
    if (toType !== undefined) return null;
    // Not answered yet ≠ "this deployment has one type". Rendering the pooled list before
    // `listContentTypes` lands paints — and fetches — the very screen the split exists to
    // retire, then redirects away from it a round trip later.
    if (contentTypes === null) return null;

    return <PageList api={api} onOpen={(p) => navigate("page", { params: { pageId: p.id } })} onError={setError} />;
  });
