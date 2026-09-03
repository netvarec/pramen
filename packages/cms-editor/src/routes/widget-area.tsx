// One widget area's contents (`/widgets/:name`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { WidgetAreaEditor } from "../furniture";

export default createPage()
  .params({ name: "string" })
  .route("/widgets/:name")
  .render(function WidgetAreaRoute({ params }) {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
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
