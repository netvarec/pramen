// The example's editor, built with the Graphic Standard theme (`@pramen/cms-theme-gs`).
//
//   bun run --cwd example/site build:admin-gs
//   PRAMEN_ADMIN_THEME=gs bun run --cwd example/site dev
//
// What a host project's build script looks like: its own podoba and React (`designSystem`, this
// site, which installs podoba 0.0.42 for the theme), its own Tailwind entry (`editor.css` here,
// which imports the theme's CSS), and the theme's slots with two of them replaced by project
// modules that extend the theme rather than fork it (`nav.ts`, `home.tsx`). The output goes to
// `public/admin-gs/`, which `astro.config.mjs` serves as `editorAssets` under the env switch.

import { buildEditor } from "@pramen/cms-editor/build";
import { gsEditor } from "@pramen/cms-theme-gs/build";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");

await buildEditor({
  outdir: resolve(site, "public/admin-gs"),
  designSystem: site,
  ...gsEditor({
    styles: resolve(here, "editor.css"),
    slots: { nav: resolve(here, "nav.ts"), home: resolve(here, "home.tsx") },
  }),
});
console.log("built public/admin-gs with the GS theme");
