// The widget-areas list (`/widgets`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { WidgetAreasView } from "../furniture";

export default createPage()
  .route("/widgets")
  .render(function WidgetsRoute() {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    return <WidgetAreasView api={api} canEdit={cms.canEdit} onOpen={(name) => navigate("widget-area", { params: { name } })} onError={setError} />;
  });
