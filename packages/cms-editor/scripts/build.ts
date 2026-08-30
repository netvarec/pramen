// Build the CMS visual editor SPA into TWO self-contained assets:
//
//   dist/editor.js    the whole app (Bun bundles it; no chunks, no bare imports)
//   dist/editor.css   the whole design system (Tailwind + podoba tokens + the web font,
//                     inlined as a data: URI so the stylesheet references nothing else)
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

const root = new URL("..", import.meta.url).pathname;
const dist = `${root}dist`;
const entry = `${root}src/main.tsx`;
const watch = process.argv.includes("--watch");

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

async function build(): Promise<void> {
  await styles();
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
  // The preview's own shell — the same three things every shell owes the bundle: the
  // stylesheet, the mount node carrying `data-base-path`, and the module script. Served at
  // the origin root with an empty prefix, which is the standalone shape; the prefixed mount
  // is what @pramen/cms-astro injects, and `test/cms-editor-mount.test.ts` exercises it
  // against a real Router rather than leaving it to a dev server nobody runs under a prefix.
  const shell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pramen · cms editor</title>
    <link rel="stylesheet" href="/editor.css" />
  </head>
  <body>
    <div id="app" data-base-path=""></div>
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
