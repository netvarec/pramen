// The menus list (`/menus`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { MenusView } from "../furniture";

export default createPage()
  .route("/menus")
  .render(function MenusRoute() {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    return <MenusView api={api} canEdit={cms.canEdit} onOpen={(name) => navigate("menu", { params: { name } })} onError={setError} />;
  });
