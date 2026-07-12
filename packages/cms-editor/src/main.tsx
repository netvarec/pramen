import { BuzolaProvider } from "@buzola/router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { pageRegistry, routes } from "virtual:buzola/routes";
import { AppProvider } from "./app-context";

// Styling is podoba: @podoba/tokens/variables.css + the compiled Tailwind (podoba
// preset) are <link>ed by index.html (see scripts/build.ts). No more inline CSS.

const el = document.getElementById("app");
if (el)
  createRoot(el).render(
    <StrictMode>
      <AppProvider>
        <BuzolaProvider routes={routes} pageRegistry={pageRegistry} />
      </AppProvider>
    </StrictMode>,
  );
