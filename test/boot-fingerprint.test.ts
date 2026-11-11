// The steady-state boot is one read (#100). A cold isolate on an unchanged D1 store used to
// re-run migrate(), the data-migration ledger, the outbox DDL and every bootstrap reconciler,
// ~40 sequential round trips before the first handler. The boot now records a fingerprint of
// what it converges from code and, while it (and migrate's own schema hash) matches, skips
// the lot.
//
// Pinned here: what goes into the fingerprint and what must keep it from being recorded, the
// claim that stops a concurrent boot of other code from being vouched for, and the real
// Worker and DO boots over SQLite, counting the statements a cold isolate sends.

import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema, Entity } from "../packages/server/src/sdk/schema";
import { createApp } from "../packages/server/src/sdk/app";
import type { BootstrapFn } from "../packages/server/src/sdk/handlers";
import { bootFingerprint, bootFingerprintMatches, claimFullBoot, recordBootFingerprint } from "../packages/server/src/runtime/boot-fingerprint";
import { migrate } from "../packages/server/src/runtime/migrate";
import { makeWorker } from "../packages/server/src/worker";
import { DEV_FILES_SECRET, DEV_SECRET } from "../packages/server/src/runtime/dev-token";
import { cmsSchema, cmsBootstrap, defineBlockType, defineContentType } from "../packages/cms/src/index";
import { bunSqliteDriver } from "./sqlite-driver";

// The DO extends `cloudflare:workers`' DurableObject; shim it like secfix-server-do does.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const FP_READ = `SELECT key, value FROM _pramen_meta WHERE key IN (?, ?)`;
const notesA = defineSchema({ notes: Entity((t) => ({ id: t.id(), body: t.text() })) });
const notesB = defineSchema({ notes: Entity((t) => ({ id: t.id(), body: t.text(), title: t.text() })) });
const tagged = (fingerprint?: string): BootstrapFn => Object.assign(async () => {}, fingerprint === undefined ? {} : { fingerprint });
const rich = defineBlockType("rich_text", [{ name: "body", type: "richtext" }] as const, { name: "Text" });
const image = defineBlockType("image", [{ name: "image", type: "media" }] as const, { name: "Image" });
const article = defineContentType("article", { name: "Article", regions: [{ name: "content", allowedTypes: ["rich_text"] }] });

describe("bootFingerprint", () => {
  const base = { schema: notesA, migrations: [{ id: "m1" }], bootstrap: [tagged("a")] };

  test("is stable for the same inputs and changes with each of them", async () => {
    const fp = (await bootFingerprint(base)).value;
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect((await bootFingerprint(base)).value).toBe(fp);
    expect((await bootFingerprint({ ...base, schema: notesB })).value).not.toBe(fp);
    expect((await bootFingerprint({ ...base, migrations: [{ id: "m1" }, { id: "m2" }] })).value).not.toBe(fp);
    expect((await bootFingerprint({ ...base, bootstrap: [tagged("b")] })).value).not.toBe(fp);
    expect((await bootFingerprint({ ...base, bootstrap: [tagged("a"), tagged()] })).value).not.toBe(fp);
  });

  test("a reconciler without a fingerprint is listed to run on every boot", async () => {
    const always = tagged();
    expect((await bootFingerprint({ ...base, bootstrap: [tagged("a"), always] })).alwaysRun).toEqual([always]);
    expect((await bootFingerprint(base)).alwaysRun).toEqual([]);
  });

  test("a partition DO keeps its own keys", async () => {
    expect(await bootFingerprint(base)).toMatchObject({ key: "boot_fingerprint", schemaKey: "schema_hash" });
    expect(await bootFingerprint({ ...base, partition: "default" })).toMatchObject({ key: "boot_fingerprint:default", schemaKey: "schema_hash:default" });
  });

  test("matches only when BOTH the fingerprint and migrate's schema hash do", async () => {
    const driver = bunSqliteDriver(new Database(":memory:"));
    const fp = await bootFingerprint(base);
    // No _pramen_meta yet: "no", not a throw.
    expect(await bootFingerprintMatches(driver, fp)).toBe(false);
    await migrate(driver, notesA);
    const claim = await claimFullBoot(driver, fp);
    expect(await bootFingerprintMatches(driver, fp)).toBe(false); // a claim is not a fingerprint
    await recordBootFingerprint(driver, fp, claim);
    expect(await bootFingerprintMatches(driver, fp)).toBe(true);
    // Older code (pre-#100) migrates to another shape and rewrites only schema_hash.
    await migrate(driver, notesB);
    expect(await bootFingerprintMatches(driver, fp)).toBe(false);
  });

  test("a boot whose claim was taken over by a later boot records nothing", async () => {
    const driver = bunSqliteDriver(new Database(":memory:"));
    await migrate(driver, notesA);
    const v2 = await bootFingerprint(base);
    const v1 = await bootFingerprint({ ...base, bootstrap: [tagged("old")] });
    const c2 = await claimFullBoot(driver, v2);
    const c1 = await claimFullBoot(driver, v1); // the other release starts its full boot later
    await recordBootFingerprint(driver, v2, c2); // v2 finishes first: its claim is gone
    expect(await bootFingerprintMatches(driver, v2)).toBe(false);
    await recordBootFingerprint(driver, v1, c1);
    expect(await bootFingerprintMatches(driver, v1)).toBe(true);
  });
});

describe("cmsBootstrap declares a fingerprint", () => {
  test("the same definitions give the same fingerprint; a change gives another", () => {
    const fp = cmsBootstrap({ blockTypes: [rich], contentTypes: [article] }).fingerprint;
    expect(typeof fp).toBe("string");
    expect(cmsBootstrap({ blockTypes: [rich], contentTypes: [article] }).fingerprint).toBe(fp);
    const renamed = defineBlockType("rich_text", [{ name: "body", type: "richtext" }] as const, { name: "Rich text" });
    expect(cmsBootstrap({ blockTypes: [renamed], contentTypes: [article] }).fingerprint).not.toBe(fp);
    expect(cmsBootstrap({ blockTypes: [rich], contentTypes: [article] }, { owner: "other" }).fingerprint).not.toBe(fp);
    // An absent key says nothing about the table; an empty array sweeps it. Different writes.
    expect(cmsBootstrap({ contentTypes: [article] }).fingerprint).not.toBe(cmsBootstrap({ blockTypes: [], contentTypes: [article] }).fingerprint);
  });

  test("a failed definition is reported with markIncomplete, not thrown, after the rest converged", async () => {
    const schema = defineSchema({ ...cmsSchema });
    const writes: string[] = [];
    // A Db whose insert into cms_block_types fails, as a UNIQUE race between two cold isolates would.
    const db = {
      find: async () => [],
      insert: async (table: string, row: Record<string, unknown>) => {
        if (table === "cms_block_types") throw new Error("UNIQUE constraint failed");
        writes.push(`${table}.${String(row.slug)}`);
        return row;
      },
      update: async () => null,
    };
    const reasons: string[] = [];
    await cmsBootstrap({ blockTypes: [rich], contentTypes: [article] })({
      db, driver: {} as never, schema, partition: "default", env: {}, markIncomplete: (r: string) => reasons.push(r),
    } as never);
    expect(reasons).toEqual([expect.stringContaining("1 definition(s) failed")]);
    expect(writes).toContain("cms_content_types.article");
  });
});

// --- The real Worker boot, over a fake D1 backed by bun:sqlite ----------------------------

function sqliteD1(sqlite: Database, log: string[], sessions: unknown[] = []) {
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      sql,
      bind: (...p: unknown[]) => ((params = p), stmt),
      all: async () => {
        log.push(sql);
        const q = sqlite.prepare(sql);
        try {
          return { results: q.all(...(params as never[])) };
        } catch {
          q.run(...(params as never[]));
          return { results: [] };
        }
      },
      run: async () => stmt.all(),
    };
    return stmt;
  };
  const session = {
    prepare,
    getBookmark: () => null,
    batch: async (stmts: { all: () => Promise<unknown> }[]) => {
      for (const s of stmts) await s.all();
    },
  };
  return { withSession: (start: unknown) => (sessions.push(start), session), prepare, batch: session.batch } as unknown as D1Database;
}

function makeKv() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => ({ keys: [...m.keys()].map((name) => ({ name })), list_complete: true }),
  };
}

const ectx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
const cms = defineSchema({ ...cmsSchema });

/** A NEW makeWorker = a new isolate (the boot memo lives in its closure). Returns the D1
 * statements the request sent; the `ping` handler itself sends none. */
async function coldIsolate(sqlite: Database, app: Record<string, unknown>, opts: { schema?: ReturnType<typeof defineSchema>; env?: Record<string, string>; sessions?: unknown[] } = {}) {
  const log: string[] = [];
  const schema = opts.schema ?? cms;
  const { query } = createApp(schema);
  const worker = makeWorker({ schema, handlers: { ping: query(() => "pong") }, ...app } as never);
  const env = { PRAMEN_STORE: "d1", DB: sqliteD1(sqlite, log, opts.sessions), KV: makeKv(), FILES: {}, AUTH_SECRET: DEV_SECRET, FILES_SECRET: DEV_FILES_SECRET, ...opts.env };
  const res = await worker.fetch(new Request("http://localhost/rpc/ping", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), env as never, ectx);
  expect(res.status).toBe(200);
  return log;
}

describe("Worker D1 boot (#100)", () => {
  test("the first boot runs in full; a later cold isolate on the unchanged store reads one row, on the primary", async () => {
    const sqlite = new Database(":memory:");
    const app = { bootstrap: [cmsBootstrap({ blockTypes: [rich], contentTypes: [article] })] };
    expect((await coldIsolate(sqlite, app)).length).toBeGreaterThan(20);
    const sessions: unknown[] = [];
    expect(await coldIsolate(sqlite, app, { sessions })).toEqual([FP_READ]);
    expect(sessions).toContain("first-primary");
    expect(sqlite.prepare(`SELECT slug FROM cms_block_types`).all()).toEqual([{ slug: "rich_text" }]);
  });

  test("a changed declaration runs the full boot once, then reads one row again", async () => {
    const sqlite = new Database(":memory:");
    await coldIsolate(sqlite, { bootstrap: [cmsBootstrap({ blockTypes: [rich], contentTypes: [article] })] });
    const changed = { bootstrap: [cmsBootstrap({ blockTypes: [rich, image], contentTypes: [article] })] };
    expect((await coldIsolate(sqlite, changed)).length).toBeGreaterThan(5);
    expect((sqlite.prepare(`SELECT slug FROM cms_block_types ORDER BY slug`).all() as { slug: string }[]).map((r) => r.slug)).toEqual(["image", "rich_text"]);
    expect(await coldIsolate(sqlite, changed)).toEqual([FP_READ]);
  });

  test("a reconciler without a fingerprint still runs on every boot, the rest is skipped", async () => {
    const sqlite = new Database(":memory:");
    let runs = 0;
    const app = { bootstrap: [cmsBootstrap({ blockTypes: [rich] }), (async () => void runs++) as BootstrapFn] };
    await coldIsolate(sqlite, app);
    expect(await coldIsolate(sqlite, app)).toEqual([FP_READ]);
    expect(runs).toBe(2);
  });

  test("a reconciler that throws or marks itself incomplete leaves no fingerprint; the next cold isolate retries in full", async () => {
    for (const how of ["throw", "mark"] as const) {
      const sqlite = new Database(":memory:");
      let fail = true;
      const flaky: BootstrapFn = Object.assign(
        async (ctx: Parameters<BootstrapFn>[0]) => {
          if (!fail) return;
          if (how === "throw") throw new Error("not yet");
          ctx.markIncomplete?.("not yet");
        },
        { fingerprint: "flaky-v1" },
      );
      await coldIsolate(sqlite, { bootstrap: [flaky] });
      fail = false;
      expect((await coldIsolate(sqlite, { bootstrap: [flaky] })).length).toBeGreaterThan(1);
      expect(await coldIsolate(sqlite, { bootstrap: [flaky] })).toEqual([FP_READ]);
    }
  });

  test("a new data migration runs the full boot (and applies it once)", async () => {
    const sqlite = new Database(":memory:");
    await coldIsolate(sqlite, { migrations: [] });
    let applied = 0;
    const app = { migrations: [{ id: "backfill-1", up: async () => void applied++ }] };
    expect((await coldIsolate(sqlite, app)).length).toBeGreaterThan(1);
    expect(await coldIsolate(sqlite, app)).toEqual([FP_READ]);
    expect(applied).toBe(1);
  });

  test("a skipped destructive diff records no fingerprint until it is allowed", async () => {
    const sqlite = new Database(":memory:");
    await coldIsolate(sqlite, {}, { schema: notesB });
    // Dropping `title` is destructive: skipped without the flag, so every boot stays full.
    expect((await coldIsolate(sqlite, {}, { schema: notesA })).length).toBeGreaterThan(1);
    expect((await coldIsolate(sqlite, {}, { schema: notesA })).length).toBeGreaterThan(1);
    await coldIsolate(sqlite, {}, { schema: notesA, env: { PRAMEN_ALLOW_DESTRUCTIVE: "true" } });
    expect(await coldIsolate(sqlite, {}, { schema: notesA })).toEqual([FP_READ]);
  });

  test("PRAMEN_FULL_BOOT=true ignores a matching fingerprint", async () => {
    const sqlite = new Database(":memory:");
    const app = { bootstrap: [cmsBootstrap({ blockTypes: [rich] })] };
    await coldIsolate(sqlite, app);
    // A code-defined row someone deleted by hand: the fingerprint can't see it...
    sqlite.exec(`DELETE FROM cms_block_types`);
    expect(await coldIsolate(sqlite, app)).toEqual([FP_READ]);
    expect(sqlite.prepare(`SELECT slug FROM cms_block_types`).all()).toEqual([]);
    // ...a forced full boot brings it back.
    await coldIsolate(sqlite, app, { env: { PRAMEN_FULL_BOOT: "true" } });
    expect(sqlite.prepare(`SELECT slug FROM cms_block_types`).all()).toEqual([{ slug: "rich_text" }]);
  });
});

// --- DO parity: the same fast path on a Durable Object's first fetch --------------------

/** A NEW DO instance over the same SQLite file = a new DO lifetime on the same storage. The
 * storage transaction rolls back on a throw (SAVEPOINT), like Cloudflare's. */
async function coldDo(sqlite: Database, app: Record<string, unknown>, opts: { partition?: string } = {}) {
  const log: string[] = [];
  const { query } = createApp(cms);
  const full = { schema: cms, handlers: { ping: query(() => "pong") }, ...app } as never;
  let depth = 0;
  const state = {
    storage: {
      sql: {
        exec: (sql: string, ...params: unknown[]) => {
          log.push(sql);
          return { toArray: () => sqlite.prepare(sql).all(...(params as never[])) };
        },
      },
      transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
        const sp = `sp${depth++}`;
        sqlite.exec(`SAVEPOINT ${sp}`);
        try {
          const r = await fn();
          sqlite.exec(`RELEASE ${sp}`);
          return r;
        } catch (e) {
          sqlite.exec(`ROLLBACK TO ${sp}`);
          sqlite.exec(`RELEASE ${sp}`);
          throw e;
        } finally {
          depth--;
        }
      },
      setAlarm: async () => {},
      getAlarm: async () => null,
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    acceptWebSocket: () => {},
    getWebSockets: () => [],
    waitUntil: () => {},
  };
  const { pramenDO } = await import("../packages/server/src/durable-object");
  const PramenDO = pramenDO(full);
  const inst = new PramenDO(state as never, { AUTH_SECRET: DEV_SECRET, FILES_SECRET: DEV_FILES_SECRET, KV: makeKv() } as never);
  const req = new Request("http://localhost/rpc/ping", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json", ...(opts.partition ? { "x-pramen-partition": opts.partition } : {}) },
  });
  const worker = makeWorker(full);
  const PRAMEN = { idFromName: (n: string) => n, get: () => ({ fetch: (r: Request) => (opts.partition ? inst.fetch(req) : inst.fetch(r)) }) };
  const res = await worker.fetch(req, { AUTH_SECRET: DEV_SECRET, FILES_SECRET: DEV_FILES_SECRET, KV: makeKv(), PRAMEN, FILES: {} } as never, ectx);
  expect(res.status).toBe(200);
  // The DO also records its tenant in the registry on every lifetime (`registered`); that is
  // not the boot, so only the boot's own statements are compared.
  return log.filter((sql) => !sql.includes("'registered'") && !/INSERT OR REPLACE INTO _pramen_meta \(key, value\) VALUES \(\?, \?\), /.test(sql));
}

describe("Durable Object boot (#100)", () => {
  test("a later DO lifetime on the unchanged store reads one row", async () => {
    const sqlite = new Database(":memory:");
    const app = { bootstrap: [cmsBootstrap({ blockTypes: [rich] })] };
    expect((await coldDo(sqlite, app)).length).toBeGreaterThan(20);
    expect(await coldDo(sqlite, app)).toEqual([FP_READ]);
    expect(sqlite.prepare(`SELECT key FROM _pramen_meta WHERE key LIKE 'boot_fingerprint%'`).all()).toEqual([{ key: "boot_fingerprint:default" }]);
  });

  test("one failing definition does not roll back the ones that converged, and records no fingerprint", async () => {
    const sqlite = new Database(":memory:");
    // Make the `rich_text` insert fail (a trigger stands in for a UNIQUE race): the reconciler
    // must still keep `image` and `article`, which a throw inside the DO transaction would undo.
    await coldDo(sqlite, {});
    sqlite.exec(`CREATE TRIGGER no_rich BEFORE INSERT ON cms_block_types WHEN NEW.slug = 'rich_text' BEGIN SELECT RAISE(ABORT, 'nope'); END`);
    sqlite.exec(`DELETE FROM _pramen_meta WHERE key = 'boot_fingerprint:default'`);
    const app = { bootstrap: [cmsBootstrap({ blockTypes: [rich, image], contentTypes: [article] })] };
    await coldDo(sqlite, app);
    expect((sqlite.prepare(`SELECT slug FROM cms_block_types ORDER BY slug`).all() as { slug: string }[]).map((r) => r.slug)).toEqual(["image"]);
    expect(sqlite.prepare(`SELECT slug FROM cms_content_types`).all()).toEqual([{ slug: "article" }]);
    expect(await coldDo(sqlite, app)).not.toEqual([FP_READ]);
  });

  test("a non-default partition DO keeps its own fingerprint and runs no reconcilers", async () => {
    const sqlite = new Database(":memory:");
    let runs = 0;
    const app = { bootstrap: [(async () => void runs++) as BootstrapFn] };
    await coldDo(sqlite, app, { partition: "audit" });
    expect(await coldDo(sqlite, app, { partition: "audit" })).toEqual([FP_READ]);
    expect(runs).toBe(0);
    expect(sqlite.prepare(`SELECT key FROM _pramen_meta WHERE key LIKE 'boot_fingerprint%'`).all()).toEqual([{ key: "boot_fingerprint:audit" }]);
  });
});
