// Build the admin SPA: bundle src/main.tsx -> dist/ and emit dist/index.html.
// This is an app, not a library, so `bun build` is the right tool here (it only
// mangles pure re-export barrels; app code bundles fine). Pass --watch to rebuild
// on change and serve a preview on http://localhost:5174.

import { rm, mkdir, writeFile, copyFile } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const dist = `${root}dist`;
const entry = `${root}src/main.tsx`;
const watch = process.argv.includes("--watch");

const html = (jsName: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pramen · admin</title>
    <link rel="stylesheet" href="./tokens.css" />
    <link rel="stylesheet" href="./app.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./${jsName}"></script>
  </body>
</html>
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
  });
  if (!out.success) {
    for (const log of out.logs) console.error(log);
    throw new Error("build failed");
  }
  const js = out.outputs.find((o) => o.path.endsWith(".js"));
  if (!js) throw new Error("no js output");
  const jsName = js.path.split("/").pop()!;
  await writeFile(`${dist}/index.html`, html(jsName));
  console.log(`built dist/${jsName} + index.html`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build();

if (watch) {
  const { watch: fsWatch } = await import("node:fs");
  let pending = false;
  fsWatch(`${root}src`, { recursive: true }, () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      build().catch((e) => console.error(e));
    }, 80);
  });
  Bun.serve({
    port: 5174,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      return new Response(Bun.file(`${dist}${path}`));
    },
  });
  console.log("watching src/ — preview on http://localhost:5174");
}
