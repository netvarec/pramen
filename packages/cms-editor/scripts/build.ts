// Build the CMS visual editor SPA: bundle src/main.tsx -> dist/ + dist/index.html.
// A standalone React app (talks to the CMS over HTTP + CORS). --watch rebuilds on
// change and serves a preview on http://localhost:5175.

import { buzolaPlugin } from "@buzola/bun-plugin";
import { rm, mkdir, writeFile, copyFile } from "node:fs/promises";
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
    <link rel="stylesheet" href="/tokens.css" />
    <link rel="stylesheet" href="/app.css" />
    <!-- Runtime config, loaded before the app so window.PRAMEN_CMS_EDITOR is set at boot.
         A default config.js ships in dist; a host overrides it to set e.g. signInUrl. -->
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
const DEFAULT_CONFIG_JS = `// Runtime configuration for the pramen CMS editor. Override this file in your host app to
// point unauthenticated / expired sessions at an external sign-in page instead of the
// built-in Setup screen:
//   window.PRAMEN_CMS_EDITOR = { signInUrl: "/signin/" };
window.PRAMEN_CMS_EDITOR = window.PRAMEN_CMS_EDITOR || {};
`;

// Design system = podoba. Compile Tailwind (podoba preset) → dist/app.css and
// copy the podoba token CSS vars → dist/tokens.css; index.html <link>s both.
async function styles(): Promise<void> {
  await copyFile(`${root}node_modules/@podoba/tokens/src/variables.css`, `${dist}/tokens.css`);
  const args = ["tailwindcss", "-c", `${root}tailwind.config.ts`, "-i", `${root}src/app.css`, "-o", `${dist}/app.css`];
  if (!watch) args.push("--minify");
  const proc = Bun.spawn(["bunx", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error("tailwind build failed");
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
  await writeFile(`${dist}/config.js`, DEFAULT_CONFIG_JS);
  console.log(`built dist/${jsName} + index.html + config.js`);
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
