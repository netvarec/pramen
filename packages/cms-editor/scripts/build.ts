// Build the CMS visual editor SPA into self-contained assets:
//
//   dist/editor.js    the whole app (Bun bundles it; no chunks, no bare imports)
//   dist/editor.css   the whole design system (Tailwind + podoba tokens + the web font,
//                     inlined as a data: URI so the stylesheet references nothing else)
//   dist/panel-*.js   three shims that hand a PANEL bundle the editor's own React — see
//                     `panelGlobals()` below and `src/panel-runtime.ts`
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
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { exportableNames, panelShimSource, PANEL_GLOBAL_SHIMS } from "../src/panel-globals";
import { PANEL_RUNTIME_GLOBAL } from "../src/panel-runtime";

const root = new URL("..", import.meta.url).pathname;
const dist = `${root}dist`;
const entry = `${root}src/main.tsx`;
const watch = process.argv.includes("--watch");

/** Which chrome the PREVIEW shell asks for — `--layout=topbar` to see the Graphic Standard
 * bar instead of the default sidebar. A dev-loop flag, not a build input: it only reaches
 * the preview's inline config below, which is the same global a real shell writes. */
const previewLayout = process.argv.find((a) => a.startsWith("--layout="))?.slice("--layout=".length) ?? "";

/** The web font, as CSS with the binary inlined.
 *
 * @podoba/tokens ships `fonts.css` next to `./fonts/*.woff2` and relies on the consumer's
 * bundler resolving that relative url. We have no consumer bundler here — `editor.css` is
 * emitted as an opaque asset and re-hosted (fingerprinted, moved into `_astro/`) by whoever
 * serves it, which would break any relative reference. Inlining costs ~68KB of base64 and
 * makes the stylesheet a single file that works wherever it lands. */
async function fontCss(): Promise<string> {
  const dir = `${root}node_modules/@podoba/tokens/src`;
  const css = await readFile(`${dir}/fonts.css`, "utf8");
  const refs = [...css.matchAll(/url\(['"]?\.\/(fonts\/[^'")]+)['"]?\)/g)];
  let out = css;
  for (const [match, rel] of refs) {
    const bytes = await readFile(`${dir}/${rel}`);
    out = out.replace(match, `url('data:font/woff2;base64,${bytes.toString("base64")}')`);
  }
  return out;
}

// Design system = podoba (Tailwind v4). app.css @imports tailwindcss + the podoba token
// vars + @theme, so the compiled output is self-contained.
//
// The font block goes AFTER it, not before. Both files declare `--font-sans` on `:root`, so
// the later one wins — and fonts.css's whole job is to point that token at the real
// typeface. The old index.html linked them the other way round, which meant the bundled
// NC Fontina was loaded and then never used.
async function styles(): Promise<void> {
  const out = `${dist}/editor.css`;
  const args = ["@tailwindcss/cli", "-i", `${root}src/app.css`, "-o", out];
  if (!watch) args.push("--minify");
  const proc = Bun.spawn(["bunx", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error("tailwind build failed");
  await writeFile(out, `${await Bun.file(out).text()}\n${await fontCss()}`);
}

// --- panel globals -----------------------------------------------------------------------
//
// Three tiny modules the shell's import map points `react`, `react-dom` and
// `react/jsx-runtime` at, so a PANEL bundle (a project's own React screen, built separately
// with those three marked external) links against the React the editor already loaded rather
// than shipping a second copy. The generator lives in `src/panel-globals.ts` — typechecked,
// and exercised end to end by `test/cms-editor-panel-globals.test.ts`; this only supplies the
// namespaces to read the export lists off, which is the half that has to happen HERE, at the
// moment the editor's own React is resolved.

async function panelGlobals(): Promise<void> {
  for (const shim of PANEL_GLOBAL_SHIMS) {
    const names = exportableNames(await import(shim.specifier));
    if (names.length === 0) throw new Error(`panel globals: ${shim.specifier} exported nothing to re-export`);
    await writeFile(`${dist}/${shim.file}`, panelShimSource(shim, names, PANEL_RUNTIME_GLOBAL));
  }
  console.log(`built ${PANEL_GLOBAL_SHIMS.map((s) => `dist/${s.file}`).join(" + ")}`);
}

async function build(): Promise<void> {
  await styles();
  await panelGlobals();
  const out = await Bun.build({
    entrypoints: [entry],
    outdir: dist,
    target: "browser",
    minify: !watch,
    sourcemap: watch ? "linked" : "none",
    // A STABLE name, not a content hash. The host's bundler emits this file as an asset and
    // fingerprints it there; hashing here as well would mean the filename changed on every
    // build and no import specifier could name it.
    naming: { entry: "editor.[ext]" },
    // Scans src/routes, (re)generates src/buzola.gen.ts, and resolves the
    // `virtual:buzola/routes` import in main.tsx.
    plugins: [buzolaPlugin({ root })],
  });
  if (!out.success) {
    for (const log of out.logs) console.error(log);
    throw new Error("build failed");
  }
  console.log("built dist/editor.js + dist/editor.css");
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
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
