#!/usr/bin/env bun
// Bump all @pramen/* package versions in lockstep, commit, and tag — then
// `git push --follow-tags` triggers the release workflow.
//
//   bun run bump patch          0.0.1 -> 0.0.2
//   bun run bump minor          0.0.1 -> 0.1.0
//   bun run bump major          0.0.1 -> 1.0.0
//   bun run bump 0.2.0-beta.1   explicit version
//   bun run bump patch --dry-run   show the plan, change nothing
//
// Versions are kept in lockstep (one version across all three). For independent
// per-package versions + changelogs, graduate to changesets.

import { $ } from "bun";

const PKGS = ["packages/server", "packages/client", "packages/react"];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const spec = args.find((a) => !a.startsWith("--"));

if (!spec) {
  console.error("usage: bun run bump <patch|minor|major|X.Y.Z> [--dry-run]");
  process.exit(1);
}

const cur = JSON.parse(await Bun.file(`${PKGS[0]}/package.json`).text()).version as string;
const m = cur.match(/^(\d+)\.(\d+)\.(\d+)/);
if (!m) {
  console.error(`current version is not semver: ${cur}`);
  process.exit(1);
}
const [maj, min, pat] = m.slice(1, 4).map(Number) as [number, number, number];

let next: string;
if (spec === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (spec === "minor") next = `${maj}.${min + 1}.0`;
else if (spec === "major") next = `${maj + 1}.0.0`;
else if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(spec)) next = spec;
else {
  console.error(`invalid version spec: ${spec}`);
  process.exit(1);
}

console.log(`pramen: ${cur} -> ${next}${dryRun ? "  (dry run)" : ""}`);
for (const dir of PKGS) console.log(`  ${dir}/package.json`);

if (dryRun) {
  console.log(`\nWould commit "release: v${next}" and tag v${next}.`);
  process.exit(0);
}

// Refuse to bump on a dirty tree — the version bump should be its own commit.
const dirty = (await $`git status --porcelain`.quiet()).stdout.toString().trim();
if (dirty) {
  console.error("working tree is not clean — commit or stash first, then bump.");
  process.exit(1);
}

const files: string[] = [];
for (const dir of PKGS) {
  const path = `${dir}/package.json`;
  const text = await Bun.file(path).text();
  // Replace only the top-level version literal — no JSON reformatting churn.
  await Bun.write(path, text.replace(/("version":\s*)"[^"]+"/, `$1"${next}"`));
  files.push(path);
}

await $`git add ${files}`;
await $`git commit -m ${`release: v${next}`}`;
await $`git tag ${`v${next}`}`;
console.log(`\nTagged v${next}. Push to publish:\n  git push --follow-tags`);
