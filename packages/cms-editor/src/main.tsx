import { BuzolaProvider } from "@buzola/router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { pageRegistry, routes } from "virtual:buzola/routes";
import { AppProvider } from "./app-context";
import { DOCUMENT_TITLE } from "./brand";

// Styling is podoba: @podoba/tokens/variables.css + the compiled Tailwind (podoba
// preset) are <link>ed by index.html (see scripts/build.ts). No more inline CSS.

// The <title> in index.html is baked at build time, before any host config exists, so it
// can only be the default. Re-apply the configured wordmark once /config.js has been read —
// the static tag stays the pre-hydration fallback.
//
// `DOCUMENT_TITLE`, not `${BRAND.title} editor`: appending a fixed English noun to the one
// string this feature exists to hand over would put a foreign word in a rebranded client's
// tab, and `suffix: null` ("just our name") could never drop it.
document.title = DOCUMENT_TITLE;

const el = document.getElementById("app");
if (el)
  createRoot(el).render(
    <StrictMode>
      <AppProvider>
        <BuzolaProvider routes={routes} pageRegistry={pageRegistry} />
      </AppProvider>
    </StrictMode>,
  );
