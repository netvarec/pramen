#!/usr/bin/env bun
// Wait until every @pramen/* package of a release can actually be INSTALLED, then exit 0.
//
//   bun scripts/verify-release.ts            # the version on disk (after `bun run bump`)
//   bun scripts/verify-release.ts 0.0.93     # an explicit version
//   bun scripts/verify-release.ts --timeout=900
//
// "Published" has three stages on npm, and only the last one is installable:
//   1. the run log says `+ @pramen/<name>@<version>` (npm accepted the upload);
//   2. the version document (`/<name>/<version>`, what `npm view` reads) lists it;
//   3. the tarball it points at answers 200.
// Under npm's async publish ("Your package is being processed") stage 2 can come minutes
// before stage 3: in 0.0.93 the version documents of all ten packages were up while three
// tarballs (cms-editor, admin, analytics) still answered 404, and a check that stopped at
// `npm view` reported the release complete. A consumer bumping in that window gets an
// install failure. So this downloads each tarball and compares its SHA-1 with the
// `dist.shasum` the registry published (the same value the run log prints as `shasum:`).
//
// Polls, because a 404 shortly after publishing is normal. A shasum MISMATCH is not lag
// and fails at once.

import { PUBLISH_PKGS } from "./packages";

const REGISTRY = "https://registry.npmjs.org";
const POLL_MS = 20_000;

const args = process.argv.slice(2);
const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const timeoutSec = timeoutArg ? Number(timeoutArg.slice("--timeout=".length)) : 900;
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error(`--timeout must be a positive number of seconds, got ${JSON.stringify(timeoutArg)}`);

const packages: { name: string; version: string }[] = [];
for (const dir of PUBLISH_PKGS) {
  const { name, version } = (await Bun.file(`${dir}/package.json`).json()) as { name: string; version: string };
  packages.push({ name, version });
}
const version = args.find((a) => !a.startsWith("--")) ?? packages[0]?.version;
if (!version) throw new Error("no version given and none found on disk");

type Check = { ok: true } | { ok: false; reason: string; fatal?: boolean };

const SHA1 = /^[0-9a-f]{40}$/;

/** The two `dist` fields this needs, or `undefined` if the document lacks a usable one. */
function parseDist(body: { dist?: { tarball?: unknown; shasum?: unknown } }): { tarball: URL; shasum: string } | undefined {
  const shasum = String(body.dist?.shasum ?? "");
  if (!SHA1.test(shasum)) return undefined;
  try {
    return { tarball: new URL(String(body.dist?.tarball)), shasum };
  } catch {
    return undefined;
  }
}

async function check(name: string): Promise<Check> {
  // `/` stays literal in the version document's path; npm answers it either way.
  const doc = await fetch(`${REGISTRY}/${name}/${version}`);
  if (doc.status !== 200) return { ok: false, reason: `version document ${doc.status}` };
  const dist = parseDist((await doc.json()) as { dist?: { tarball?: unknown; shasum?: unknown } });
  if (!dist) return { ok: false, reason: "version document has no usable dist.tarball/dist.shasum" };
  const tgz = await fetch(dist.tarball);
  if (tgz.status !== 200) return { ok: false, reason: `tarball ${tgz.status}` };
  const sha1 = new Bun.CryptoHasher("sha1").update(await tgz.arrayBuffer()).digest("hex");
  if (sha1 !== dist.shasum) return { ok: false, fatal: true, reason: `tarball shasum ${sha1} != dist.shasum ${dist.shasum}` };
  return { ok: true };
}

const deadline = Date.now() + timeoutSec * 1000;
console.log(`verifying ${packages.length} packages at ${version} (tarball 200 + shasum), up to ${timeoutSec}s`);
for (;;) {
  const results = await Promise.all(packages.map(async ({ name }) => ({ name, result: await check(name).catch((e: Error) => ({ ok: false, reason: e.message }) as Check) })));
  const pending = results.filter((r) => !r.result.ok);
  const stamp = new Date().toISOString().slice(11, 19);
  if (pending.length === 0) {
    console.log(`${stamp}Z all ${packages.length} tarballs at ${version} answer 200 and match their shasum`);
    process.exit(0);
  }
  for (const { name, result } of pending) if (!result.ok) console.log(`${stamp}Z ${name.padEnd(22)} ${result.reason}`);
  const fatal = pending.find((r) => !r.result.ok && r.result.fatal);
  if (fatal) {
    console.error(`${fatal.name}: shasum mismatch is not publish lag; stop and investigate.`);
    process.exit(1);
  }
  if (Date.now() + POLL_MS > deadline) {
    console.error(`still pending after ${timeoutSec}s: ${pending.map((r) => r.name).join(", ")}. Check the run log for an \`npm error\` on those packages.`);
    process.exit(1);
  }
  await Bun.sleep(POLL_MS);
}
