// Smoke test for the CLI — runs commands via the shell and checks output.

import { describe, expect, test } from "bun:test";
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
});
