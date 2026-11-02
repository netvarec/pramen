#!/usr/bin/env bun
// Wait until every @pramen/* package of a release can actually be INSTALLED, then exit 0.
//
//   bun scripts/verify-release.ts               # the version on disk (after `bun run bump`)
//   bun scripts/verify-release.ts 0.0.93        # an explicit version
//   bun scripts/verify-release.ts --timeout=900 # seconds to keep polling (default 900)
//
// "Published" has stages on npm, and only when all of them are through is it installable:
//   1. the run log says `+ @pramen/<name>@<version>` (npm accepted the upload);
//   2. the version document (`/<name>/<version>`, what `npm view` reads) lists it;
//   3. the packument (`/<name>`, what `npm install`/`bun add` resolve a range against) lists it;
//   4. the tarball it points at answers 200.
// Under npm's async publish ("Your package is being processed") stage 2 can come minutes
// before stage 4: in 0.0.93 the version documents of all ten packages were up while three
// tarballs (cms-editor, admin, analytics) still answered 404, and a check that stopped at
// `npm view` reported the release complete. A consumer bumping in that window gets an
// install failure. So this checks the install packument lists the version, downloads the
// tarball, and compares its SHA-1 with the `dist.shasum` the registry published (the same
// value the run log prints as `shasum:`).
//
// Polls, because a 404 shortly after publishing is normal. A shasum MISMATCH is not lag
// and fails at once.

import { PUBLISH_PKGS } from "./packages";

const REGISTRY = "https://registry.npmjs.org";
const POLL_MS = 20_000;
/** Per request. A stalled connection becomes a pending result and is retried next round,
 * instead of holding the whole round (and the deadline check) forever. */
const REQUEST_MS = 60_000;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA1 = /^[0-9a-f]{40}$/;

// --- arguments: one optional version, one optional `--timeout=<s>`, nothing else -----------
let version: string | undefined;
let timeoutSec = 900;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--timeout=")) {
    timeoutSec = Number(arg.slice("--timeout=".length));
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error(`--timeout must be a positive number of seconds, got ${JSON.stringify(arg)}`);
  } else if (SEMVER.test(arg) && version === undefined) {
    version = arg;
  } else {
    throw new Error(`unexpected argument ${JSON.stringify(arg)}; usage: verify-release.ts [X.Y.Z] [--timeout=<seconds>]`);
  }
}

// --- the release set, which must be in lockstep on disk -------------------------------------
const names: string[] = [];
const onDisk = new Set<string>();
for (const dir of PUBLISH_PKGS) {
  const pkg = (await Bun.file(`${dir}/package.json`).json()) as { name: string; version: string };
  names.push(pkg.name);
  onDisk.add(pkg.version);
}
if (version === undefined) {
  if (onDisk.size !== 1) throw new Error(`packages are not in lockstep on disk (${[...onDisk].join(", ")}); pass the version to verify explicitly`);
  version = [...onDisk][0];
}

type Check = { ok: true } | { ok: false; reason: string; fatal?: boolean };

/** `dist.shasum`, or `undefined` if the object has no usable one. */
function shasumOf(entry: { dist?: { shasum?: unknown } } | undefined): string | undefined {
  const shasum = String(entry?.dist?.shasum ?? "");
  return SHA1.test(shasum) ? shasum : undefined;
}

/** The tarball url, or `undefined` if the object has no usable one. */
function tarballOf(entry: { dist?: { tarball?: unknown } } | undefined): URL | undefined {
  try {
    return new URL(String(entry?.dist?.tarball));
  } catch {
    return undefined;
  }
}

const get = (url: string | URL, headers?: Record<string, string>) => fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_MS) });

/** A non-200 answer's body is never read; release the connection it holds. */
async function notOk(res: Response, what: string): Promise<Check> {
  await res.body?.cancel();
  return { ok: false, reason: `${what} ${res.status}` };
}

async function check(name: string): Promise<Check> {
  // The packument in the abbreviated form installers request: does a resolve find it?
  const packument = await get(`${REGISTRY}/${name}`, { accept: "application/vnd.npm.install-v1+json" });
  if (packument.status !== 200) return notOk(packument, "packument");
  const listed = ((await packument.json()) as { versions?: Record<string, { dist?: { tarball?: unknown; shasum?: unknown } }> }).versions?.[version as string];
  if (!listed) return { ok: false, reason: "packument does not list it yet" };

  const doc = await get(`${REGISTRY}/${name}/${version}`);
  if (doc.status !== 200) return notOk(doc, "version document");
  const entry = (await doc.json()) as { dist?: { tarball?: unknown; shasum?: unknown } };
  const shasum = shasumOf(entry);
  const tarball = tarballOf(entry);
  if (!shasum || !tarball) return { ok: false, reason: "version document has no usable dist.tarball/dist.shasum" };
  if (shasumOf(listed) !== shasum) return { ok: false, fatal: true, reason: `packument shasum ${shasumOf(listed)} != version document shasum ${shasum}` };

  const tgz = await get(tarball);
  if (tgz.status !== 200) return notOk(tgz, "tarball");
  const sha1 = new Bun.CryptoHasher("sha1").update(await tgz.arrayBuffer()).digest("hex");
  if (sha1 !== shasum) return { ok: false, fatal: true, reason: `tarball shasum ${sha1} != dist.shasum ${shasum}` };
  return { ok: true };
}

const deadline = Date.now() + timeoutSec * 1000;
const pending = new Set(names);
console.log(`verifying ${names.length} packages at ${version} (packument lists it, tarball 200 + shasum), up to ${timeoutSec}s`);
for (;;) {
  // Only what is still pending: a verified tarball does not need downloading again.
  const results = await Promise.all(
    [...pending].map(async (name) => ({ name, result: await check(name).catch((e: Error) => ({ ok: false, reason: e?.message ?? String(e) }) as Check) })),
  );
  const stamp = new Date().toISOString().slice(11, 19);
  for (const { name, result } of results) {
    if (result.ok) pending.delete(name);
    else console.log(`${stamp}Z ${name.padEnd(22)} ${result.reason}`);
  }
  if (pending.size === 0) {
    console.log(`${stamp}Z all ${names.length} packages at ${version} are listed, and their tarballs answer 200 and match their shasum`);
    process.exit(0);
  }
  const fatal = results.find((r) => !r.result.ok && r.result.fatal);
  if (fatal) {
    console.error(`${fatal.name}: a shasum mismatch is not publish lag; stop and investigate.`);
    process.exit(1);
  }
  const left = deadline - Date.now();
  if (left <= 0) {
    console.error(`still pending after ${timeoutSec}s: ${[...pending].join(", ")}. Check the run log for an \`npm error\` on those packages.`);
    process.exit(1);
  }
  // Sleep the remainder when less than a full interval is left, so the last poll still runs.
  await Bun.sleep(Math.min(POLL_MS, left));
}
