// The steady-state boot is one read (#100). A cold isolate on an unchanged D1 store used to
// re-run migrate(), the data-migration ledger, the outbox DDL and every bootstrap reconciler,
// ~40 sequential round trips before the first handler. The boot now records a fingerprint of
// what it converges from code and, while it matches, skips the lot.
//
// Pinned here: what goes into the fingerprint (and what must NOT let it be recorded), and the
// real Worker boot over a SQLite-backed fake D1, counting the statements a cold isolate sends.

import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema, Entity } from "../packages/server/src/sdk/schema";
import { createApp } from "../packages/server/src/sdk/app";
import type { BootstrapFn } from "../packages/server/src/sdk/handlers";
import { bootFingerprint, readBootFingerprint, writeBootFingerprint } from "../packages/server/src/runtime/boot-fingerprint";
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

const schemaA = defineSchema({ notes: Entity((t) => ({ id: t.id(), body: t.text() })) });
const schemaB = defineSchema({ notes: Entity((t) => ({ id: t.id(), body: t.text(), title: t.text() })) });
const tagged = (fingerprint?: string): BootstrapFn => Object.assign(async () => {}, fingerprint === undefined ? {} : { fingerprint });

describe("bootFingerprint", () => {
  const base = { schema: schemaA, migrations: [{ id: "m1" }], bootstrap: [tagged("a")] };

  test("is stable for the same inputs and changes with each of them", () => {
    const fp = bootFingerprint(base).value;
    expect(bootFingerprint(base).value).toBe(fp);
    expect(bootFingerprint({ ...base, schema: schemaB }).value).not.toBe(fp);
    expect(bootFingerprint({ ...base, migrations: [{ id: "m1" }, { id: "m2" }] }).value).not.toBe(fp);
    expect(bootFingerprint({ ...base, bootstrap: [tagged("b")] }).value).not.toBe(fp);
    expect(bootFingerprint({ ...base, bootstrap: [tagged("a"), tagged()] }).value).not.toBe(fp);
  });

  test("a reconciler without a fingerprint is listed to run on every boot", () => {
    const always = tagged();
    const fp = bootFingerprint({ ...base, bootstrap: [tagged("a"), always] });
    expect(fp.alwaysRun).toEqual([always]);
    expect(bootFingerprint(base).alwaysRun).toEqual([]);
  });

  test("a partition DO keeps its own key", () => {
    expect(bootFingerprint(base).key).toBe("boot_fingerprint");
    expect(bootFingerprint({ ...base, partition: "audit" }).key).toBe("boot_fingerprint:audit");
  });

  test("reading before _pramen_meta exists is 'none', not a throw", async () => {
    const driver = bunSqliteDriver(new Database(":memory:"));
    expect(await readBootFingerprint(driver, "boot_fingerprint")).toBeUndefined();
    driver.exec(`CREATE TABLE _pramen_meta (key TEXT PRIMARY KEY, value TEXT)`, []);
    const fp = bootFingerprint(base);
    await writeBootFingerprint(driver, fp);
    expect(await readBootFingerprint(driver, fp.key)).toBe(fp.value);
  });
});

describe("cmsBootstrap declares a fingerprint", () => {
  const rich = defineBlockType("rich_text", [{ name: "body", type: "richtext" }] as const, { name: "Text" });
  const article = defineContentType("article", { name: "Article", regions: [{ name: "content", allowedTypes: ["rich_text"] }] });

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

  test("a definition that fails to reconcile makes the reconciler throw at the end (no fingerprint over a half-converged store)", async () => {
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
    const fn = cmsBootstrap({ blockTypes: [rich], contentTypes: [article] });
    await expect(fn({ db, driver: {} as never, schema, partition: "default", env: {} } as never)).rejects.toThrow("1 definition(s) failed");
    // ...after doing what it could: the content type still landed.
    expect(writes).toContain("cms_content_types.article");
  });
});

// --- The real Worker boot, over a fake D1 backed by bun:sqlite ----------------------------

function sqliteD1(sqlite: Database, log: string[]) {
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
  return { withSession: () => session, prepare, batch: session.batch } as unknown as D1Database;
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

describe("Worker D1 boot (#100)", () => {
  const schema = defineSchema({ ...cmsSchema });
  const { query } = createApp(schema);
  const rich = defineBlockType("rich_text", [{ name: "body", type: "richtext" }] as const, { name: "Text" });
  const article = defineContentType("article", { name: "Article", regions: [{ name: "content", allowedTypes: ["rich_text"] }] });

  async function coldIsolate(sqlite: Database, app: Record<string, unknown>) {
    const log: string[] = [];
    // A NEW makeWorker = a new isolate: the boot memo lives in its closure.
    const worker = makeWorker({ schema, handlers: { ping: query(() => "pong") }, ...app } as never);
    const env = { PRAMEN_STORE: "d1", DB: sqliteD1(sqlite, log), KV: makeKv(), FILES: {}, AUTH_SECRET: DEV_SECRET, FILES_SECRET: DEV_FILES_SECRET };
    const res = await worker.fetch(new Request("http://localhost/rpc/ping", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), env as never, ectx);
    expect(res.status).toBe(200);
    // Statements the boot and the handler sent; the handler itself sends none.
    return log;
  }

  test("the first boot runs in full; a later cold isolate on the unchanged store reads one row", async () => {
    const sqlite = new Database(":memory:");
    const app = { bootstrap: [cmsBootstrap({ blockTypes: [rich], contentTypes: [article] })] };
    const first = await coldIsolate(sqlite, app);
    expect(first.length).toBeGreaterThan(20);
    const second = await coldIsolate(sqlite, app);
    expect(second).toEqual([`SELECT value FROM _pramen_meta WHERE key = ?`]);
    // And it really converged the first time: the declared types are there.
    expect(sqlite.prepare(`SELECT slug FROM cms_block_types`).all()).toEqual([{ slug: "rich_text" }]);
  });

  test("a changed declaration runs the full boot once, then reads one row again", async () => {
    const sqlite = new Database(":memory:");
    await coldIsolate(sqlite, { bootstrap: [cmsBootstrap({ blockTypes: [rich], contentTypes: [article] })] });
    const image = defineBlockType("image", [{ name: "image", type: "media" }] as const, { name: "Image" });
    const changed = { bootstrap: [cmsBootstrap({ blockTypes: [rich, image], contentTypes: [article] })] };
    expect((await coldIsolate(sqlite, changed)).length).toBeGreaterThan(5);
    expect((sqlite.prepare(`SELECT slug FROM cms_block_types ORDER BY slug`).all() as { slug: string }[]).map((r) => r.slug)).toEqual(["image", "rich_text"]);
    expect(await coldIsolate(sqlite, changed)).toHaveLength(1);
  });

  test("a reconciler without a fingerprint still runs on every boot, the rest is skipped", async () => {
    const sqlite = new Database(":memory:");
    let runs = 0;
    const counted: BootstrapFn = async () => void runs++;
    const app = { bootstrap: [cmsBootstrap({ blockTypes: [rich] }), counted] };
    await coldIsolate(sqlite, app);
    const second = await coldIsolate(sqlite, app);
    expect(runs).toBe(2);
    expect(second).toEqual([`SELECT value FROM _pramen_meta WHERE key = ?`]);
  });

  test("a failing reconciler leaves no fingerprint, so the next cold isolate retries in full", async () => {
    const sqlite = new Database(":memory:");
    let fail = true;
    const flaky: BootstrapFn = Object.assign(async () => {
      if (fail) throw new Error("not yet");
    }, { fingerprint: "flaky-v1" });
    const app = { bootstrap: [flaky] };
    await coldIsolate(sqlite, app);
    fail = false;
    expect((await coldIsolate(sqlite, app)).length).toBeGreaterThan(1);
    expect(await coldIsolate(sqlite, app)).toHaveLength(1);
  });

  test("a new data migration runs the full boot (and applies it)", async () => {
    const sqlite = new Database(":memory:");
    await coldIsolate(sqlite, { migrations: [] });
    let applied = 0;
    const app = { migrations: [{ id: "backfill-1", up: async () => void applied++ }] };
    expect((await coldIsolate(sqlite, app)).length).toBeGreaterThan(1);
    expect(applied).toBe(1);
    expect(await coldIsolate(sqlite, app)).toHaveLength(1);
    expect(applied).toBe(1);
  });
});

// --- DO parity: the same fast path on a Durable Object's first fetch --------------------

describe("Durable Object boot (#100)", () => {
  const schema = defineSchema({ ...cmsSchema });
  const { query } = createApp(schema);
  const rich = defineBlockType("rich_text", [{ name: "body", type: "richtext" }] as const, { name: "Text" });

  /** A NEW DO instance over the same SQLite file = a new DO lifetime on the same storage. */
  async function coldDo(sqlite: Database, app: Record<string, unknown>) {
    const log: string[] = [];
    const full = { schema, handlers: { ping: query(() => "pong") }, ...app } as never;
    const state = {
      storage: {
        sql: {
          exec: (sql: string, ...params: unknown[]) => {
            log.push(sql);
            return { toArray: () => sqlite.prepare(sql).all(...(params as never[])) };
          },
        },
        transaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
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
    const env = { AUTH_SECRET: DEV_SECRET, FILES_SECRET: DEV_FILES_SECRET, KV: makeKv() } as never;
    const inst = new PramenDO(state as never, env);
    const worker = makeWorker(full);
    const PRAMEN = { idFromName: (n: string) => n, get: () => ({ fetch: (r: Request) => inst.fetch(r) }) };
    const res = await worker.fetch(
      new Request("http://localhost/rpc/ping", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
      { ...(env as object), PRAMEN, FILES: {} } as never,
      ectx,
    );
    expect(res.status).toBe(200);
    return log;
  }

  test("a later DO lifetime on the unchanged store reads one row", async () => {
    const sqlite = new Database(":memory:");
    const app = { bootstrap: [cmsBootstrap({ blockTypes: [rich] })] };
    expect((await coldDo(sqlite, app)).length).toBeGreaterThan(20);
    // The DO also records its tenant in the registry on every lifetime (`registered`); that is
    // not the boot, so only the boot's own statements are compared.
    const second = (await coldDo(sqlite, app)).filter((sql) => !sql.includes("'registered'") && !/INSERT OR REPLACE INTO _pramen_meta \(key, value\) VALUES \(\?, \?\), /.test(sql));
    expect(second).toEqual([`SELECT value FROM _pramen_meta WHERE key = ?`]);
    expect(sqlite.prepare(`SELECT value FROM _pramen_meta WHERE key = 'boot_fingerprint:default'`).all()).toHaveLength(1);
  });
});
