// One widget area's contents (`/widgets/:name`).

import { createPage, useNavigate, useRouter } from "@buzola/router";
import { useApp } from "../app-context";
import { Notice } from "../components";
import { t } from "../i18n";
import { WidgetAreaEditor } from "../furniture";

export default createPage()
  .params({ name: "string" })
  .route("/widgets/:name")
  .render(function WidgetAreaRoute({ params }) {
    const { api, cms, setError } = useApp();
    const navigate = useNavigate();
    const router = useRouter();
    // The nav hides these on a server without the handlers, but a BOOKMARK does not —
    // without this the screen mounts fully interactive and every call 404s. The
    // `/schema` routes already gated on their own capability; these did not.
    if (!cms.siteFurniture) return <Notice>{t("furniture.unavailable")}</Notice>;
    return (
      <WidgetAreaEditor
        api={api}
        key={params.name}
        name={params.name}
        canEdit={cms.canEdit}
        onBack={() => navigate("widgets")}
        backHref={router.buildPagePath("widgets")}
        onDeleted={() => navigate("widgets")}
        onError={setError}
      />
    );
  });
