// Security regressions for the deploy configuration: a remote deploy must never render
// oblaka's LOCAL env (a published AUTH_SECRET, the dev-account seed, CORS *), and the
// dev-account seed must not be part of the code a deploy ships.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join } from "node:path";
import defineOblaka from "../oblaka";
import { app, devUserBootstrap } from "../example/app";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

/** The env oblaka resolves for a script, parsed the way oblaka-iac's `commands/input.ts` does
 * (`--env`, else CLOUDFLARE_ENV, else "local"). Only the oblaka half of an `&&` chain counts:
 * `bun run deploy --env x` appends to the LAST command, which is wrangler. */
function oblakaEnvOf(script: string): { env: string; remote: boolean } {
  const oblakaCmd = script.split("&&")[0]!.trim().split(/\s+/);
  expect(oblakaCmd[0]).toBe("oblaka");
  const { values } = parseArgs({
    args: oblakaCmd.slice(1),
    allowPositionals: true,
    options: { env: { type: "string" }, "state-namespace": { type: "string" }, "dry-run": { type: "boolean" }, remote: { type: "boolean" } },
  });
  return { env: values.env ?? "local", remote: values.remote ?? false };
}

describe("remote scripts name a non-local env for oblaka itself", () => {
  for (const name of ["deploy", "plan"]) {
    test(name, () => {
      const { env, remote } = oblakaEnvOf(pkg.scripts[name]!);
      expect(remote).toBe(true);
      expect(env).not.toBe("local");
    });
  }
});

describe("oblaka.ts refuses to render the local env for --remote", () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
  });
  const render = (env: string) => (defineOblaka as unknown as (a: { env: string }) => { options: { vars: Record<string, string>; main: string } })({ env });

  test("local + --remote throws, so a missing --env fails the deploy", () => {
    process.argv = ["bun", "oblaka", "oblaka.ts", "--remote", "--state-namespace", "pramen-iac-state"];
    expect(() => render("local")).toThrow(/refusing to render the LOCAL env/);
  });

  test("a non-local render carries no dev secret, no dev seed, and the plain entry", () => {
    process.argv = ["bun", "oblaka", "oblaka.ts", "--remote", "--env", "production"];
    const w = render("production");
    expect(w.options.vars.AUTH_SECRET).toBeUndefined();
    expect(w.options.vars.PRAMEN_DEV_SEED).toBeUndefined();
    expect(w.options.main).toBe("./example/worker.ts");
  });

  test("local dev (no --remote) still renders the dev block and the dev entry", () => {
    process.argv = ["bun", "oblaka", "oblaka.ts"];
    const w = render("local");
    expect(w.options.vars.PRAMEN_DEV_SEED).toBe("true");
    expect(w.options.main).toBe("./example/dev-worker.ts");
  });
});

describe("the dev-account seed is not in the deployed app", () => {
  test("example/app.ts does not register devUserBootstrap; only the dev entry does", () => {
    expect(app.bootstrap).not.toContain(devUserBootstrap);
    const devEntry = readFileSync(join(ROOT, "example/dev-worker.ts"), "utf8");
    expect(devEntry).toContain("devUserBootstrap");
    const deployEntry = readFileSync(join(ROOT, "example/worker.ts"), "utf8");
    expect(deployEntry).not.toContain("devUserBootstrap");
  });
});

describe("the `pramen init` oblaka template has the same guard", () => {
  test("it refuses the local env for --remote", () => {
    const cli = readFileSync(join(ROOT, "packages/server/src/cli.ts"), "utf8");
    const template = cli.slice(cli.indexOf("const OBLAKA_TEMPLATE"));
    expect(template).toMatch(/env === "local" && argv\.includes\("--remote"\)/);
  });
});
