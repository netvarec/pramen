// Build the CMS visual editor SPA into self-contained assets:
//
//   dist/editor.js    the whole app (Bun bundles it; no chunks, no bare imports)
//   dist/editor.css   the whole design system (Tailwind + podoba tokens + the web font,
//                     inlined as a data: URI so the stylesheet references nothing else)
//   dist/panel-*.js   four shims that hand a PANEL bundle the editor's own React — see
//                     `src/panel-globals.ts` and `src/panel-runtime.ts`
//
// The build itself is `buildEditor` in `src/build-editor.ts`; this script is the in-repo caller
// that produces the published `dist/`. It lives there rather than here because a HOST needs to
// run the same build against its own podoba and its own stylesheet — a sealed bundle is what
// drove one deployment to rebuild us out of `src/` with 70 string replacements.
//
// Deliberately NOT an index.html. The editor is served by a SHELL its host renders — an
// injected Astro route in @pramen/cms-astro, the dev preview below — and the shell is what
// knows where the editor is mounted, which backend it talks to and what the page is called.
// A baked index.html could not know any of that: it hard-coded root-absolute asset paths
// (`/editor.js`), so it only worked at the origin root, and its companion `config.js` was a
// hand-edited untyped global that 404'd silently the moment it was served from anywhere
// else. Two stable filenames instead, which a host's own bundler fingerprints and serves.
//
// --watch rebuilds on change and serves a preview shell on http://localhost:5175.

import { buzolaPlugin } from "@buzola/bun-plugin";
import { rm } from "node:fs/promises";
import { extname } from "node:path";
import { buildEditor } from "../src/build-editor";

const root = new URL("..", import.meta.url).pathname;
const dist = `${root}dist`;
const watch = process.argv.includes("--watch");

/** Which chrome the PREVIEW shell asks for — `--layout=topbar` to see the Graphic Standard
 * bar instead of the default sidebar. A dev-loop flag, not a build input: it only reaches
 * the preview's inline config below, which is the same global a real shell writes. */
const previewLayout = process.argv.find((a) => a.startsWith("--layout="))?.slice("--layout=".length) ?? "";

/** Build the published `dist/`.
 *
 * The work itself lives in `src/build-editor.ts`, which is the same build exposed as an API so
 * a HOST can run it against its own podoba, its own Tailwind entry and its own screen header
 * (see `buildEditor`). Called with no options beyond the output directory, it is this: the
 * self-contained bundle, its stylesheet with podoba's font inlined, and the four panel shims.
 *
 * `buzolaPlugin` is handed over rather than assumed, because it is the one part a host cannot
 * run: it regenerates `src/buzola.gen.ts` by scanning `src/routes`, and it is a devDependency.
 * For anyone building from the published package the generated table is already correct and
 * `buildEditor` resolves the virtual module to it.
 */
async function build(): Promise<void> {
  await buildEditor({
    outdir: dist,
    minify: !watch,
    sourcemap: watch,
    plugins: [buzolaPlugin({ root })],
  });
  console.log("built dist/editor.js + dist/editor.css + the panel shims");
}

await rm(dist, { recursive: true, force: true });
await build();

if (watch) {
  // The preview's own shell — the same four things every shell owes the bundle: the
  // stylesheet, the import map that resolves a panel bundle's React against the editor's,
  // the mount node carrying `data-base-path`, and the module script. Served at the origin
  // root with an empty prefix, which is the standalone shape; the prefixed mount is what
  // @pramen/cms-astro injects, and `test/cms-editor-mount.test.ts` exercises it against a
  // real Router rather than leaving it to a dev server nobody runs under a prefix.
  //
  // The import map is here even though the preview declares no panels: it must precede every
  // module script in the document, so it is not something a shell can add later when one
  // appears, and a dev loop that points `window.PRAMEN_CMS_EDITOR.panels` at a local build
  // should work without editing this file.
  const shell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pramen · cms editor</title>
    <link rel="stylesheet" href="/editor.css" />
    <script type="importmap">
      {"imports":{"react":"/panel-react.js","react-dom":"/panel-react-dom.js","react/jsx-runtime":"/panel-jsx-runtime.js","react/jsx-dev-runtime":"/panel-jsx-dev-runtime.js"}}
    </script>
  </head>
  <body>
    <div id="app" data-base-path=""></div>
    <script>window.PRAMEN_CMS_EDITOR=${JSON.stringify(previewLayout ? { layout: previewLayout } : {})};</script>
    <script type="module" src="/editor.js"></script>
  </body>
</html>
`;
  const { watch: fsWatch } = await import("node:fs");
  let pending = false;
  fsWatch(`${root}src`, { recursive: true }, (_event, filename) => {
    // The build regenerates buzola.gen.ts; ignore that write so it can't self-trigger.
    if (filename && filename.includes("buzola.gen")) return;
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      build().catch((e) => console.error(e));
    }, 80);
  });
  Bun.serve({
    port: 5175,
    fetch(req) {
      const path = new URL(req.url).pathname;
      // Extensionless paths are client routes — serve the shell so a deep link or refresh
      // boots the SPA and lets the router resolve the path.
      if (!extname(path)) return new Response(shell, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response(Bun.file(`${dist}${path}`));
    },
  });
  console.log("watching src/ — preview on http://localhost:5175");
}
