// Build the CMS visual editor SPA: bundle src/main.tsx -> dist/ + dist/index.html.
// A standalone React app (talks to the CMS over HTTP + CORS). --watch rebuilds on
// change and serves a preview on http://localhost:5175.

import { buzolaPlugin } from "@buzola/bun-plugin";
import { rm, mkdir, writeFile, copyFile, cp } from "node:fs/promises";
import { extname } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = `${root}dist`;
const entry = `${root}src/main.tsx`;
const watch = process.argv.includes("--watch");

const html = (jsName: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pramen · cms editor</title>
    <link rel="stylesheet" href="/fonts.css" />
    <link rel="stylesheet" href="/app.css" />
    <!-- Runtime config, loaded before the app so window.PRAMEN_CMS_EDITOR is set at boot.
         A default config.js ships in dist; a host overrides it to set e.g. signInUrl or
         the wordmark. The <title> below is the pre-hydration fallback — the app re-applies
         the configured brand on boot, since this file is baked before any config exists. -->
    <script src="/config.js"></script>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/${jsName}"></script>
  </body>
</html>
`;

// Default runtime config — hosts override /config.js to configure the editor (e.g. an
// external sign-in URL). Shipped so the <script src="/config.js"> never 404s.
const DEFAULT_CONFIG_JS = `// Runtime configuration for the pramen CMS editor. Override this file in your host app —
// no rebuild needed. Every field is optional:
//
//   window.PRAMEN_CMS_EDITOR = {
//     // Send unauthenticated / expired sessions to your own sign-in page instead of the
//     // built-in Setup screen (?setup=1 still forces Setup, to paste a first-admin JWT):
//     signInUrl: "/signin/",
//     // The wordmark in the topbar, on the Setup screen and in the browser tab. Set this
//     // when you deploy the editor for a client — the default says "pramen", which is the
//     // framework's name, not theirs. \`suffix: null\` drops the "· cms" half.
//     brand: { name: "Acme", suffix: "cms" },
//     hidePages: true,                                  // collections-only deployments
//     extraNav: [{ label: "Curation", href: "/curate" }],
//   };
window.PRAMEN_CMS_EDITOR = window.PRAMEN_CMS_EDITOR || {};
`;

// Design system = podoba (Tailwind v4). app.css @imports tailwindcss + the podoba
// token vars + @theme, so dist/app.css is self-contained (no separate tokens.css).
// The NC Fontina web font ships as CSS + a woff2 in @podoba/tokens; copy both to dist/
// and <link> fonts.css directly so its `url('./fonts/…')` stays relative to dist/.
async function styles(): Promise<void> {
  const args = ["@tailwindcss/cli", "-i", `${root}src/app.css`, "-o", `${dist}/app.css`];
  if (!watch) args.push("--minify");
  const proc = Bun.spawn(["bunx", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error("tailwind build failed");
  await cp(`${root}node_modules/@podoba/tokens/src/fonts`, `${dist}/fonts`, { recursive: true });
  await copyFile(`${root}node_modules/@podoba/tokens/src/fonts.css`, `${dist}/fonts.css`);
}

async function build(): Promise<void> {
  await styles();
  const out = await Bun.build({
    entrypoints: [entry],
    outdir: dist,
    target: "browser",
    minify: !watch,
    sourcemap: watch ? "linked" : "none",
    naming: "[dir]/[name].[hash].[ext]",
    // Scans src/routes, (re)generates src/buzola.gen.ts, and resolves the
    // `virtual:buzola/routes` import in main.tsx.
    plugins: [buzolaPlugin({ root })],
  });
  if (!out.success) {
    for (const log of out.logs) console.error(log);
    throw new Error("build failed");
  }
  const js = out.outputs.find((o) => o.path.endsWith(".js"));
  if (!js) throw new Error("no js output");
  const jsName = js.path.split("/").pop()!;
  await writeFile(`${dist}/index.html`, html(jsName));
  // Written only when ABSENT. `dist/config.js` is the documented configuration surface — a
  // host edits it in place, and in `--watch` this function re-runs on every save, so an
  // unconditional write silently threw away the wordmark someone was in the middle of
  // previewing. The `rm -rf dist` below still gives a clean build the default every time.
  const configPath = `${dist}/config.js`;
  const kept = await Bun.file(configPath).exists();
  if (!kept) await writeFile(configPath, DEFAULT_CONFIG_JS);
  console.log(`built dist/${jsName} + index.html${kept ? " (kept your config.js)" : " + config.js"}`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build();

if (watch) {
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
      const url = new URL(req.url);
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      // Extensionless paths are client routes — fall back to index.html so a deep
      // link or refresh boots the SPA and lets the router resolve the path.
      if (!extname(path)) return new Response(Bun.file(`${dist}/index.html`));
      return new Response(Bun.file(`${dist}${path}`));
    },
  });
  console.log("watching src/ — preview on http://localhost:5175");
}
