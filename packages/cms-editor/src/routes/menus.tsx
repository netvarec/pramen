// The menus list (`/menus`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { MenusView } from "../furniture";
import { useStableError } from "../schema-builder";

export default createPage()
  .route("/menus")
  .render(function MenusRoute() {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    const onError = useStableError(setError);
    return <MenusView api={api} canEdit={cms.canEdit} onOpen={(name) => navigate("menu", { params: { name } })} onError={onError} />;
  });
