// Media library route (`/media`).

import { createPage } from "@buzola/router";
import { useApp } from "../app-context";
import { MediaLibrary } from "../components";

export default createPage()
  .route("/media")
  .render(function Media() {
    const { api, setError } = useApp();
    return <MediaLibrary api={api} onError={setError} />;
  });
