// Home route (`/`): the page list. Opening a page navigates to /pages/:pageId.

import { createPage, useNavigate } from "@buzola/router";
import { useEffect, useState } from "react";
import { useApp } from "../app-context";
import { PageList, errMsg } from "../components";
import type { BlockType, Page } from "../types";

export default createPage()
  .route("/")
  .render(function Home() {
    const { api, setError, collections } = useApp();
    const navigate = useNavigate();
    const [pages, setPages] = useState<Page[]>([]);
    const [blockTypes, setBlockTypes] = useState<BlockType[]>([]);

    // Collections-only deployment: `/` is the Pages list, so land on the first
    // collection instead. Without this, hiding the tab still leaves the landing page
    // showing an empty page list — and still fetching pages, which errors outright on a
    // deployment that never spread cmsSchema.
    const hidePages = typeof window !== "undefined" && window.PRAMEN_CMS_EDITOR?.hidePages === true;
    const firstCollection = collections[0]?.slug;

    useEffect(() => {
      if (hidePages && firstCollection) navigate("collection", { params: { slug: firstCollection }, replace: true });
    }, [hidePages, firstCollection, navigate]);

    const refreshPages = () => api.listPages().then(setPages).catch((e) => setError(errMsg(e)));
    useEffect(() => {
      if (hidePages) return;
      refreshPages();
      api.listBlockTypes().then(setBlockTypes).catch((e) => setError(errMsg(e)));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, hidePages]);

    if (hidePages && firstCollection) return null;

    return (
      <PageList
        api={api}
        pages={pages}
        blockTypes={blockTypes}
        onOpen={(p) => navigate("page", { params: { pageId: p.id } })}
        onCreated={refreshPages}
        onError={setError}
      />
    );
  });
