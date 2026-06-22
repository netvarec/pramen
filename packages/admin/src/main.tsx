// SPA entry: inject the inline stylesheet and mount the admin dashboard.

import { render } from "preact";
import { App } from "./app";
import { css } from "./styles";

const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

render(<App />, document.getElementById("app")!);
