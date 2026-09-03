// One menu's tree editor (`/menus/:name`).

import { createPage, useNavigate } from "@buzola/router";
import { useApp } from "../app-context";
import { MenuEditor } from "../furniture";
import { useStableError } from "../schema-builder";

export default createPage()
  .params({ name: "string" })
  .route("/menus/:name")
  .render(function MenuRoute({ params }) {
    const { api, cms, collections, setError } = useApp();
    const navigate = useNavigate();
    const onError = useStableError(setError);
    return (
      <MenuEditor
        api={api}
        key={params.name}
        name={params.name}
        canEdit={cms.canEdit}
        collections={collections}
        onBack={() => navigate("menus")}
        onDeleted={() => navigate("menus")}
        onError={onError}
      />
    );
  });
