// SPA entry: mount the admin dashboard. Styling is podoba — @podoba/tokens/variables.css
// + the compiled Tailwind (podoba preset) are <link>ed by index.html (see scripts/build.ts).

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
