// The menus list (`/menus`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { Notice } from "../components";
import { MenusView } from "../furniture";

export default createPage()
  .route("/menus")
  .render(function MenusRoute() {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    // The nav hides these on a server without the handlers, but a BOOKMARK does not —
    // without this the screen mounts fully interactive and every call 404s. The
    // `/schema` routes already gated on their own capability; these did not.
    if (!cms.siteFurniture) return <Notice>This deployment's CMS does not provide site furniture.</Notice>;
    return <MenusView api={api} canEdit={cms.canEdit} onOpen={(name) => navigate("menu", { params: { name } })} onError={setError} />;
  });
