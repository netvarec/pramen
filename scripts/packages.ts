// Single source of truth for the publishable @pramen/* packages. Both bump.ts
// (lockstep version bump) and publish.ts (ordered publish) consume this list, so
// they can't drift apart — a package added to one but not the other was exactly
// how cms/cms-astro/cms-editor got left out of releases.
//
// Order is dependency order: a package appears after anything it depends on
// (react -> client; auth -> server; cms -> server). publish.ts relies on this;
// bump.ts is order-insensitive (it only edits version literals).

import { Glob } from "bun";

export const PUBLISH_PKGS = [
  "packages/client",
  "packages/server",
  "packages/react",
  "packages/auth",
  "packages/cms",
  "packages/cms-astro",
  "packages/cms-editor",
  "packages/admin",
];

/** Fail loudly if any non-private @pramen/* workspace is missing from PUBLISH_PKGS,
 * so a newly added package can't be silently skipped at release time. Apps/tools
 * opt out of publishing by setting `"private": true`. */
export async function assertNoPackageDrift(): Promise<void> {
  const listed = new Set(PUBLISH_PKGS);
  const missing: string[] = [];
  for await (const manifest of new Glob("packages/*/package.json").scan(".")) {
    const dir = manifest.replace(/\/package\.json$/, "");
    const pkg = JSON.parse(await Bun.file(manifest).text());
    if (pkg.private) continue;
    if (!listed.has(dir)) missing.push(`${pkg.name} (${dir})`);
  }
  if (missing.length) {
    console.error(`publishable package(s) missing from scripts/packages.ts PUBLISH_PKGS:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
}
