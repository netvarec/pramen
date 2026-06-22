#!/usr/bin/env bun
// Publish @pramen/* to npm, skipping any package whose current version is already
// on the registry. Idempotent — safe to re-run after a partial failure, and lets
// a newly-added package join the set without forcing a version bump of the rest.
// In CI this runs under OIDC trusted publishing (no token); see release.yml.
//
// Dependency order: a package is published after anything it depends on
// (auth -> server; react -> client). `npm publish` rewrites each `workspace:*`
// to the concrete workspace version on the way out.

import { $ } from "bun";

const PKGS = ["packages/client", "packages/server", "packages/react", "packages/auth", "packages/admin"];

for (const dir of PKGS) {
  const { name, version } = JSON.parse(await Bun.file(`${dir}/package.json`).text());
  const view = await $`npm view ${name}@${version} version`.quiet().nothrow();
  if (view.exitCode === 0 && view.stdout.toString().trim() === version) {
    console.log(`skip    ${name}@${version} (already published)`);
    continue;
  }
  console.log(`publish ${name}@${version}`);
  await $`npm publish --provenance`.cwd(dir);
}
