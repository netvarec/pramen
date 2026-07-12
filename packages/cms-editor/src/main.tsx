import { BuzolaProvider } from "@buzola/router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { pageRegistry, routes } from "virtual:buzola/routes";
import { AppProvider } from "./app-context";
import { css } from "./styles";

const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

const el = document.getElementById("app");
if (el)
  createRoot(el).render(
    <StrictMode>
      <AppProvider>
        <BuzolaProvider routes={routes} pageRegistry={pageRegistry} />
      </AppProvider>
    </StrictMode>,
  );
