// End-to-end suite. Generates wrangler.jsonc from oblaka, boots one wrangler-dev
// server against fresh local state, and runs every suite against it (each on its
// own tenant). Run with `bun test`.

import { afterAll, beforeAll, describe, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runAcl } from "./suites/acl";
import { runCellAcl } from "./suites/cell-acl";
import { runD1 } from "./suites/d1";
import { runFiles } from "./suites/files";
import { runExtras } from "./suites/extras";
import { runAdmin } from "./suites/admin";
import { runAuth } from "./suites/auth";
import { runResolver } from "./suites/resolver";
import { runRelation } from "./suites/relation";
import { runLive } from "./suites/live";
import { runQuery } from "./suites/query";
import { runPagination } from "./suites/pagination";
import { runAggregate } from "./suites/aggregate";
import { runAclOperators } from "./suites/acl-operators";
import { runRegistry } from "./suites/registry";
import { runRecovery } from "./suites/recovery";
import { runKv } from "./suites/kv";
import { runClient } from "./suites/client";
import { runHardening } from "./suites/hardening";

const ROOT = join(import.meta.dir, "..");
const PORT = 8788;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}/live`;

let server: ReturnType<typeof Bun.spawn> | undefined;

async function waitForReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not become ready in time");
}

beforeAll(async () => {
  // Generate wrangler.jsonc from the oblaka source of truth.
  Bun.spawnSync(["bunx", "oblaka", "oblaka.ts"], { cwd: ROOT });
  // Fresh local DO state so suites are deterministic (e.g. resolver "before authoring").
  rmSync(join(ROOT, ".wrangler"), { recursive: true, force: true });

  server = Bun.spawn(["bunx", "wrangler", "dev", "--port", String(PORT)], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForReady(60_000);
}, 90_000);

afterAll(() => {
  server?.kill();
});

describe("pramen e2e", () => {
  test("acl + write rules + per-identity live", () => runAcl(BASE, WS), 30_000);
  test("cell-level ACL (per-row field visibility)", () => runCellAcl(BASE), 30_000);
  test("D1-backed store (Worker + D1, no DO)", () => runD1(BASE), 30_000);
  test("file storage (R2 upload/download + signed urls + ACL)", () => runFiles(BASE), 30_000);
  test("extras: json column + ctx.env + CORS", () => runExtras(BASE), 30_000);
  test("admin data API (generic per-tenant CRUD, admin-gated)", () => runAdmin(BASE), 30_000);
  test("@pramen/auth (signup/login issue verifiable tokens)", () => runAuth(BASE), 30_000);
  test("dynamic resolvers", () => runResolver(BASE), 30_000);
  test("relations + nested ACL", () => runRelation(BASE), 30_000);
  test("query expressiveness (operators, OR/AND, offset)", () => runQuery(BASE), 30_000);
  test("cursor pagination", () => runPagination(BASE), 30_000);
  test("count + aggregates", () => runAggregate(BASE), 30_000);
  test("operators in ACL where rules", () => runAclOperators(BASE), 30_000);
  test("tenant registry", () => runRegistry(BASE), 30_000);
  test("admin recovery endpoint (auth + validation)", () => runRecovery(BASE), 30_000);
  test("ctx.kv (global cross-tenant config)", () => runKv(BASE), 30_000);
  test("@pramen/client (typed RPC + live subscription)", () => runClient(BASE), 30_000);
  test("live queries + row-level invalidation", () => runLive(BASE, WS), 30_000);
  test("hardening: input validation + safe errors", () => runHardening(BASE), 30_000);
});
