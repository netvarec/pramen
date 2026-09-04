// Page editor route (`/pages/:pageId`). The inspector tab is carried in the URL as
// `?tab=` so a specific panel is deep-linkable and survives refresh; block selection
// stays local (it's a transient in-canvas overlay).

import { createPage, useNavigate } from "@buzola/router";
import { Button } from "@podoba/react";
import { useEffect, useState } from "react";
import { useApp } from "../app-context";
import { Notice, PageEditor, errMsg, splitsByType, visibleTabs, type InspectorTab } from "../components";
import type { BlockType, Page } from "../types";

export default createPage()
  .params({ pageId: "string", tab: "?string" })
  .route("/pages/:pageId")
  .render(function PageEditorRoute({ params }) {
    const { api, cms, contentTypes, setError, setNavGuard } = useApp();
    const navigate = useNavigate();
    const [page, setPage] = useState<Page | null>(null);
    const [blockTypes, setBlockTypes] = useState<BlockType[]>([]);
    const [missing, setMissing] = useState(false);

    useEffect(() => {
      let live = true;
      setMissing(false);
      // By id. Resolving it against `listPages` instead meant the editor could not open a row
      // the list had just shown it: that list is capped, and since the editor lists ONE type
      // per tab it isn't even the same list — 150 newer pages of another type were enough to
      // push an article out of the pooled fetch and turn a click into "Page not found."
      api.getPageById(params.pageId)
        .then((found) => {
          if (!live) return;
          setPage(found ?? null);
          setMissing(!found);
        })
        .catch((e) => setError(errMsg(e)));
      api.listBlockTypes().then((r) => live && setBlockTypes(r)).catch((e) => setError(errMsg(e)));
      return () => { live = false; };
    }, [api, params.pageId, setError]);

    // Back goes to the list this page actually belongs to. `home` redirects to whichever type
    // sorts FIRST BY NAME on a split deployment, so "← all pages" from an article landed the
    // editor in some other type's list — with the `replace` overwriting `/`, so Back could not
    // undo it either. Falls back to `home` when the type is unknown (not loaded, or gone).
    const ownType = (contentTypes ?? []).find((t) => t.id === page?.typeId);
    const backToList = () => {
      if (splitsByType(contentTypes, cms) && ownType) navigate("type", { params: { slug: ownType.slug } });
      else navigate("home");
    };

    // The visible set comes from the server (`visibleTabs`), so a deep link to `?tab=i18n`
    // on a single-locale deployment falls back to settings — and the URL is REWRITTEN to
    // match. Rendering one tab under another tab's address means a refresh, a Back, or a
    // shared link all disagree with what is on screen; `setTab` already replaces without
    // adding a history entry, so reconciling costs nothing.
    const shown = visibleTabs(cms.multilingual, cms.siteFurniture);
    const tab: InspectorTab = shown.includes(params.tab as InspectorTab) ? (params.tab as InspectorTab) : "settings";
    const setTab = (t: InspectorTab) => navigate("page", { params: { pageId: params.pageId, tab: t }, replace: true });
    useEffect(() => {
      if (params.tab !== undefined && params.tab !== tab) setTab(tab);
    }, [params.tab, tab]);

    if (missing) {
      // No page ⇒ no type to go back to; `home` lands on the first list either way.
      return <Notice action={<Button variant="ghost" size="sm" onPress={() => navigate("home")}>← all pages</Button>}>Page not found.</Notice>;
    }
    if (!page) return <Notice>Loading…</Notice>;

    return (
      <PageEditor
        api={api}
        page={page}
        blockTypes={blockTypes}
        tab={tab}
        onTab={setTab}
        onBack={backToList}
        // Named for where it actually goes. On a per-type deployment `backToList` lands in
        // this page's OWN type list, and a button labelled "Pages" then named a pooled list
        // that deployment does not have.
        backLabel={splitsByType(contentTypes, cms) && ownType ? ownType.name : "Pages"}
        onChange={setPage}
        registerGuard={setNavGuard}
      />
    );
  });
