// Home route (`/`): the page list. Opening a page navigates to /pages/:pageId.

import { createPage, useNavigate } from "@buzola/router";
import { useEffect, useState } from "react";
import { useApp } from "../app-context";
import { PageList, errMsg } from "../components";
import type { BlockType, Page } from "../types";

export default createPage()
  .route("/")
  .render(function Home() {
    const { api, setError } = useApp();
    const navigate = useNavigate();
    const [pages, setPages] = useState<Page[]>([]);
    const [blockTypes, setBlockTypes] = useState<BlockType[]>([]);

    const refreshPages = () => api.listPages().then(setPages).catch((e) => setError(errMsg(e)));
    useEffect(() => {
      refreshPages();
      api.listBlockTypes().then(setBlockTypes).catch((e) => setError(errMsg(e)));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api]);

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
