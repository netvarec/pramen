// Smoke test for the CLI — runs commands via the shell and checks output.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const run = (...args: string[]) => {
  const p = Bun.spawnSync(["bun", "scripts/cli.ts", ...args], { cwd: ROOT });
  return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
};

describe("pramen cli", () => {
  test("help", () => {
    const { out } = run("help");
    expect(out).toContain("Usage: pramen <command>");
    expect(out).toContain("schema");
  });

  test("schema sql prints CREATE TABLE", () => {
    const { out } = run("schema", "sql", "--app", "example/app.ts");
    expect(out).toContain(`CREATE TABLE IF NOT EXISTS "notes"`);
    expect(out).toContain(`CREATE TABLE IF NOT EXISTS "users"`);
  });

  test("schema hash is stable hex", () => {
    const a = run("schema", "hash", "--app", "example/app.ts").out.trim();
    const b = run("schema", "hash", "--app", "example/app.ts").out.trim();
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(a).toBe(b);
  });

  test("token mints a 3-part JWT", () => {
    const tok = run("token", "alice", "author", "--tenant", "main").out.trim();
    expect(tok.split(".").length).toBe(3);
  });

  test("help lists the migrations commands", () => {
    const { out } = run("help");
    expect(out).toContain("migrations list");
    expect(out).toContain("migrations status");
  });

  test("migrations list prints the example app's declared ids, in order", () => {
    const { out, code } = run("migrations", "list", "--app", "example/app.ts");
    expect(code).toBe(0);
    const ids = out.trim().split("\n").map((l) => l.split("  ")[0]);
    expect(ids).toEqual(["2026-09-03-backfill-note-meta", "2026-09-03-normalize-signup-status"]);
    expect(out).toContain("(partition: default)");
  });

  test("the runtime CLI carries no CMS command", () => {
    // @pramen/cms is optional, so its codegen lives in its own `pramen-cms` bin.
    const { out } = run("help");
    expect(out).not.toContain("cms");
  });

  test("unknown command exits non-zero", () => {
    const { code } = run("frobnicate");
    expect(code).not.toBe(0);
  });

  test("init scaffolds a working (non-deny-all) ACL", () => {
    const dir = mkdtempSync(join(tmpdir(), "pramen-init-"));
    const modules = join(dir, "node_modules");
    try {
      const { out, code } = run("init", dir);
      expect(code).toBe(0);
      expect(out).toContain("app.ts");
      const appTs = readFileSync(join(dir, "app.ts"), "utf8");
      // CLI2 regression guard: the old scaffold shipped `const acl: never[] = []`,
      // which denies every request. The scaffold must grant something on first run.
      expect(appTs).not.toContain("acl: never[] = []");
      expect(appTs).toContain('role("anonymous"');
      expect(appTs).toContain("allow()");
      // The scaffold deliberately ships no package.json (the CLI tells you to run
      // `bun add @pramen/server` next), so `@pramen/server` would otherwise resolve
      // only via Bun auto-install — i.e. against the LAST PUBLISHED package, over the
      // network. That made this test assert on npm rather than on the working tree,
      // and fail outright whenever the auto-install cache was cold. Link the repo's
      // node_modules (where @pramen/server -> packages/server) so it loads THIS
      // checkout, offline.
      symlinkSync(join(ROOT, "node_modules"), modules, "dir");
      // The scaffolded app must load and produce valid DDL (proves the ACL DSL is wired).
      const sql = run("schema", "sql", "--app", join(dir, "app.ts"));
      expect(sql.err).toBe("");
      expect(sql.out).toContain(`CREATE TABLE IF NOT EXISTS "notes"`);
    } finally {
      // Unlink the symlink explicitly before removing the temp dir, so a recursive
      // delete can never walk into the repo's real node_modules.
      try {
        unlinkSync(modules);
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pramen-cms cli", () => {
  const runCms = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", "packages/cms/src/cli.ts", ...args], { cwd: ROOT });
    return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
  };

  test("help describes the types command", () => {
    const { out } = runCms("help");
    expect(out).toContain("Usage: pramen-cms <command>");
    expect(out).toContain("types");
  });

  test("types fails clearly when it cannot reach an instance", () => {
    // Port 1 is never a pramen instance — the point is a CLI error naming the bin,
    // not an unhandled fetch rejection with a stack trace.
    const { err, code } = runCms("types", "--url", "http://127.0.0.1:1");
    expect(code).not.toBe(0);
    expect(err).toContain("pramen-cms: types");
  });

  test("unknown command exits non-zero", () => {
    expect(runCms("frobnicate").code).not.toBe(0);
  });

  test("--flag=value is accepted, and an unknown flag is rejected", () => {
    // `--out=path` matched nothing, so the module printed to stdout and exited 0 — a green
    // regenerate-and-diff CI with no file written. A misspelled flag did the same.
    const eq = runCms("types", "--url=http://127.0.0.1:1");
    expect(eq.code).not.toBe(0);
    expect(eq.err).toContain("cannot reach http://127.0.0.1:1"); // the =value form was read
    const unknown = runCms("types", "--outt", "/tmp/x");
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain("unknown flag --outt");
  });

  test("a flag with no value is an error, not a silent default", () => {
    // `--out` with an empty $OUT used to print to stdout and exit 0; `--tenant --out x`
    // used to set tenant to "--out".
    const { err, code } = runCms("types", "--out");
    expect(code).not.toBe(0);
    expect(err).toContain("--out needs a value");
  });
});
