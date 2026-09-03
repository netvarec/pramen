// One widget area's contents (`/widgets/:name`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { Notice } from "../components";
import { WidgetAreaEditor } from "../furniture";

export default createPage()
  .params({ name: "string" })
  .route("/widgets/:name")
  .render(function WidgetAreaRoute({ params }) {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    // The nav hides these on a server without the handlers, but a BOOKMARK does not —
    // without this the screen mounts fully interactive and every call 404s. The
    // `/schema` routes already gated on their own capability; these did not.
    if (!cms.siteFurniture) return <Notice>This deployment's CMS does not provide site furniture.</Notice>;
    return (
      <WidgetAreaEditor
        api={api}
        key={params.name}
        name={params.name}
        canEdit={cms.canEdit}
        onBack={() => navigate("widgets")}
        onDeleted={() => navigate("widgets")}
        onError={setError}
      />
    );
  });
