// Page editor route (`/pages/:pageId`). The inspector tab is carried in the URL as
// `?tab=` so a specific panel is deep-linkable and survives refresh; block selection
// stays local (it's a transient in-canvas overlay).

import { createPage, useNavigate } from "@buzola/router";
import { Button } from "@podoba/react";
import { useEffect, useState } from "react";
import { useApp } from "../app-context";
import { INSPECTOR_TABS, PageEditor, errMsg, type InspectorTab } from "../components";
import type { BlockType, Page } from "../types";

export default createPage()
  .params({ pageId: "string", tab: "?string" })
  .route("/pages/:pageId")
  .render(function PageEditorRoute({ params }) {
    const { api, setError } = useApp();
    const navigate = useNavigate();
    const [page, setPage] = useState<Page | null>(null);
    const [blockTypes, setBlockTypes] = useState<BlockType[]>([]);
    const [missing, setMissing] = useState(false);

    useEffect(() => {
      let live = true;
      setMissing(false);
      // No get-page-by-id handler; resolve the id against the page list.
      api.listPages()
        .then((rows) => {
          if (!live) return;
          const found = rows.find((p) => p.id === params.pageId) ?? null;
          setPage(found);
          setMissing(!found);
        })
        .catch((e) => setError(errMsg(e)));
      api.listBlockTypes().then((r) => live && setBlockTypes(r)).catch((e) => setError(errMsg(e)));
      return () => { live = false; };
    }, [api, params.pageId, setError]);

    const tab: InspectorTab = INSPECTOR_TABS.includes(params.tab as InspectorTab) ? (params.tab as InspectorTab) : "settings";
    const setTab = (t: InspectorTab) => navigate("page", { params: { pageId: params.pageId, tab: t }, replace: true });

    if (missing) {
      return (
        <div className="mx-auto flex max-w-[1200px] items-center gap-2 px-7 pt-8">
          <p className="text-fg-subtle">Page not found.</p>
          <Button variant="ghost" size="sm" onPress={() => navigate("home")}>← all pages</Button>
        </div>
      );
    }
    if (!page) return <div className="mx-auto max-w-[1200px] px-7 pt-8"><p className="text-fg-subtle">Loading…</p></div>;

    return (
      <PageEditor
        api={api}
        page={page}
        blockTypes={blockTypes}
        tab={tab}
        onTab={setTab}
        onBack={() => navigate("home")}
        onChange={setPage}
      />
    );
  });
