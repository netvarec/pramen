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
