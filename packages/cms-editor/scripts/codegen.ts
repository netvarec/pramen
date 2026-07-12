// Regenerate src/buzola.gen.ts from src/routes without a full build. The build does this
// automatically via the Bun plugin; run this to refresh the committed file after adding
// or renaming a route (the generated file is checked in so tsc resolves it build-free).

import { generate, resolveOptions } from "@buzola/codegen";

const root = new URL("..", import.meta.url).pathname;
const opts = await resolveOptions({ root });
const wrote = await generate(opts);
console.log(wrote ? `generated ${opts.outputPath}` : `already up to date: ${opts.outputPath}`);
