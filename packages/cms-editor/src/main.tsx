import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { css } from "./styles";

const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

const el = document.getElementById("app");
if (el) createRoot(el).render(<StrictMode><App /></StrictMode>);
