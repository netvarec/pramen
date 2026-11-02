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
// tarball it names, and compares the bytes with both digests the packument published: the
// SHA-1 `dist.shasum` (what the run log prints as `shasum:`) and the sha512 `dist.integrity`
// installers verify.
//
// Polls, because a 404 shortly after publishing is normal. A shasum MISMATCH is not lag
// and fails at once.

import { PUBLISH_PKGS } from "./packages";

const REGISTRY = "https://registry.npmjs.org";
const POLL_MS = 20_000;
/** Per ROUND, shared by every request in it and capped at the time left, so a stalled
 * connection becomes a pending result instead of holding the round past the deadline. */
const ROUND_MS = 60_000;
/** A version as the tags spell it (`v0.0.93`) or as npm does (`0.0.93`, `0.3.0-beta.1`). */
const VERSION = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const SHA1 = /^[0-9a-f]{40}$/;

// --- arguments: one optional version, one optional `--timeout=<s>`, nothing else -----------
let version: string | undefined;
let timeoutSec = 900;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--timeout=")) {
    timeoutSec = Number(arg.slice("--timeout=".length));
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error(`--timeout must be a positive number of seconds, got ${JSON.stringify(arg)}`);
  } else if (VERSION.test(arg) && version === undefined) {
    version = VERSION.exec(arg)?.[1];
  } else {
    throw new Error(`unexpected argument ${JSON.stringify(arg)}; usage: verify-release.ts [X.Y.Z | vX.Y.Z] [--timeout=<seconds>] (no build metadata)`);
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

/** A version's entry in the install packument: the only fields this reads. */
type DistEntry = { dist?: { tarball?: unknown; shasum?: unknown; integrity?: unknown } };

const SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

/** The entry's tarball and digests, or `undefined` while any of them is not usable yet. */
function distOf(entry: DistEntry): { tarball: URL; shasum: string; integrity: string } | undefined {
  const shasum = String(entry.dist?.shasum ?? "");
  const integrity = String(entry.dist?.integrity ?? "");
  if (!SHA1.test(shasum) || !SHA512.test(integrity)) return undefined;
  try {
    return { tarball: new URL(String(entry.dist?.tarball)), shasum, integrity };
  } catch {
    return undefined;
  }
}

/** A non-200 answer's body is never read; release its connection without letting a failed
 * cancel replace the status in the report. */
function notOk(res: Response, what: string): Check {
  res.body?.cancel().catch(() => {});
  return { ok: false, reason: `${what} ${res.status}` };
}

async function check(name: string, signal: AbortSignal): Promise<Check> {
  // The packument in the abbreviated form installers request: does a resolve find it? Its
  // entry also names the tarball and its digests, so no second metadata request is needed.
  const packument = await fetch(`${REGISTRY}/${name}`, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal });
  if (packument.status !== 200) return notOk(packument, "packument");
  const listed = ((await packument.json()) as { versions?: Record<string, DistEntry> }).versions?.[version as string];
  if (!listed) return { ok: false, reason: "packument does not list it yet" };
  // An incomplete entry is lag, never a mismatch: only well-formed digests are compared.
  const dist = distOf(listed);
  if (!dist) return { ok: false, reason: "packument entry has no usable dist.tarball/shasum/integrity yet" };

  const tgz = await fetch(dist.tarball, { signal });
  if (tgz.status !== 200) return notOk(tgz, "tarball");
  const bytes = await tgz.arrayBuffer();
  const sha1 = new Bun.CryptoHasher("sha1").update(bytes).digest("hex");
  if (sha1 !== dist.shasum) return { ok: false, fatal: true, reason: `tarball sha1 ${sha1} != dist.shasum ${dist.shasum}` };
  const sha512 = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
  if (sha512 !== dist.integrity) return { ok: false, fatal: true, reason: `tarball ${sha512} != dist.integrity ${dist.integrity}` };
  return { ok: true };
}

const deadline = Date.now() + timeoutSec * 1000;
const pending = new Set(names);
console.log(`verifying ${names.length} packages at ${version} (packument lists it, tarball 200 + sha1 + sha512), up to ${timeoutSec}s`);
for (;;) {
  // Only what is still pending: a verified tarball does not need downloading again.
  const signal = AbortSignal.timeout(Math.max(1_000, Math.min(ROUND_MS, deadline - Date.now())));
  const results = await Promise.all(
    [...pending].map(async (name) => ({ name, result: await check(name, signal).catch((e: Error) => ({ ok: false, reason: e?.message ?? String(e) }) as Check) })),
  );
  const stamp = new Date().toISOString().slice(11, 19);
  for (const { name, result } of results) {
    if (result.ok) pending.delete(name);
    else console.log(`${stamp}Z ${name.padEnd(22)} ${result.reason}`);
  }
  if (pending.size === 0) {
    console.log(`${stamp}Z all ${names.length} packages at ${version} are listed, and their tarballs answer 200 and match shasum + integrity`);
    process.exit(0);
  }
  const fatal = results.find((r) => !r.result.ok && r.result.fatal);
  if (fatal) {
    console.error(`${fatal.name}: a digest mismatch is not publish lag; stop and investigate.`);
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
