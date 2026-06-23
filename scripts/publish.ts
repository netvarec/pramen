#!/usr/bin/env bun
// Publish @pramen/* to npm, skipping any package whose current version is already
// on the registry. Idempotent — safe to re-run after a partial failure, and lets
// a newly-added package join the set without forcing a version bump of the rest.
// In CI this runs under OIDC trusted publishing (no token); see release.yml.
//
// Dependency order: a package is published after anything it depends on
// (auth -> server; react -> client).
//
// IMPORTANT: `npm publish` does NOT understand the `workspace:*` protocol — that's a
// bun/pnpm/yarn feature. Plain `npm` ships the manifest verbatim, so a `workspace:*`
// dep would land on the registry literally and make the package uninstallable (this
// shipped broken in 0.0.1–0.0.6 for @pramen/react and @pramen/auth). We rewrite every
// `workspace:` range to the concrete sibling version on disk before publishing, then
// restore the original manifest so the working tree is untouched.

import { $ } from "bun";

const PKGS = ["packages/client", "packages/server", "packages/react", "packages/auth", "packages/admin"];

const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"] as const;

// Map every in-repo package name -> its current version, to resolve `workspace:` ranges.
const versions = new Map<string, string>();
for (const dir of PKGS) {
  const { name, version } = JSON.parse(await Bun.file(`${dir}/package.json`).text());
  versions.set(name, version);
}

/** Turn a `workspace:` range into a concrete npm range using the sibling's version.
 * Mirrors how pnpm/bun rewrite on publish: `workspace:*` -> the exact version. */
function resolveWorkspace(range: string, depName: string): string {
  const v = versions.get(depName);
  if (!v) throw new Error(`workspace dep ${depName} is not one of the published @pramen/* packages`);
  const spec = range.slice("workspace:".length);
  if (spec === "" || spec === "*") return v; // exact pin (lockstep)
  if (spec === "^" || spec === "~") return spec + v; // caret/tilde of the sibling version
  return spec; // explicit range written after `workspace:` (e.g. workspace:^1.2.3)
}

/** Rewrite any `workspace:` deps in a parsed manifest. Returns true if it changed. */
function rewriteWorkspaceDeps(pkg: Record<string, unknown>): boolean {
  let changed = false;
  for (const field of DEP_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [dep, range] of Object.entries(deps)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        deps[dep] = resolveWorkspace(range, dep);
        changed = true;
      }
    }
  }
  return changed;
}

for (const dir of PKGS) {
  const manifestPath = `${dir}/package.json`;
  const original = await Bun.file(manifestPath).text();
  const pkg = JSON.parse(original);
  const { name, version } = pkg;

  const view = await $`npm view ${name}@${version} version`.quiet().nothrow();
  if (view.exitCode === 0 && view.stdout.toString().trim() === version) {
    console.log(`skip    ${name}@${version} (already published)`);
    continue;
  }

  // Rewrite workspace: deps -> concrete versions, publish, then restore the manifest.
  const rewritten = rewriteWorkspaceDeps(pkg);
  if (rewritten) await Bun.write(manifestPath, JSON.stringify(pkg, null, 2) + "\n");
  try {
    console.log(`publish ${name}@${version}`);
    await $`npm publish --provenance`.cwd(dir);
  } finally {
    if (rewritten) await Bun.write(manifestPath, original); // leave the working tree clean
  }
}
