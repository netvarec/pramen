// Security regressions for the Worker + Durable Object pair, driven through the REAL
// makeWorker and the REAL PramenDO class (cloudflare:workers shimmed), DO SQLite and D1
// both on bun:sqlite, KV in a Map. Three findings:
//
//  - The store is operator config. An anonymous `x-pramen-store` header used to pick the
//    store, so a caller signed up a victim's username on the store where it was free and
//    had the OTHER store's refreshSession reissue the victim's roles (anonymous to admin).
//  - Hard revocation reaches an OPEN /live socket: the denylist and a not-before instant
//    are re-checked per frame and before every push, not only at the upgrade.
//  - armDrain keeps an earlier pending alarm, so a steady stream of enqueuing requests
//    can no longer postpone the tenant's outbox drain forever.

import { afterAll, beforeAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";

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

// Bun's Response refuses status 101, which a WebSocket upgrade answers with. Swap in a
// subclass that records the socket instead, and restore the real one afterwards.
const RealResponse = globalThis.Response;
const RealWebSocketPair = (globalThis as Record<string, unknown>).WebSocketPair;
class UpgradeResponse extends RealResponse {
  webSocket?: unknown;
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    if (init?.status === 101) {
      super(body, { ...init, status: 200, headers: { "x-upgraded": "1" } });
      this.webSocket = init.webSocket;
    } else super(body, init);
  }
}
type FakeWs = {
  att: unknown;
  sent: string[];
  closed: [number | undefined, string | undefined] | null;
  serializeAttachment(a: unknown): void;
  deserializeAttachment(): unknown;
  send(m: string): void;
  close(c?: number, r?: string): void;
  accept(): void;
};
const fakeWs = (): FakeWs => ({
  att: null,
  sent: [],
  closed: null,
  serializeAttachment(a) {
    this.att = structuredClone(a);
  },
  deserializeAttachment() {
    return this.att;
  },
  send(m) {
    this.sent.push(m);
  },
  close(c, r) {
    this.closed ??= [c, r];
  },
  accept() {},
});
beforeAll(() => {
  globalThis.Response = UpgradeResponse as unknown as typeof Response;
  (globalThis as Record<string, unknown>).WebSocketPair = class {
    0 = fakeWs();
    1 = fakeWs();
  };
});
afterAll(() => {
  globalThis.Response = RealResponse;
  (globalThis as Record<string, unknown>).WebSocketPair = RealWebSocketPair;
  setSystemTime();
});

const { makeWorker } = await import("../packages/server/src/worker");
const { pramenDO } = await import("../packages/server/src/durable-object");
const { Entity, defineSchema } = await import("../packages/server/src/sdk/schema");
const { mutation, query } = await import("../packages/server/src/sdk/handlers");
const { role, policy, allow } = await import("../packages/server/src/sdk/acl");
const { Kv, denySession, setSessionNotBefore } = await import("../packages/server/src/runtime/kv");
const { authHandlers, authSchema } = await import("../packages/auth/src/index");

const SECRET = "secfix-server-secret-0123456789";

// --- harness -----------------------------------------------------------------

function makeKv() {
  const m = new Map<string, string>();
  return {
    get: async (k: string, t?: string) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)!) : m.get(k)!) : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async (o: { prefix?: string } = {}) => ({
      keys: [...m.keys()].filter((k) => k.startsWith(o.prefix ?? "")).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function makeD1(db: Database) {
  return {
    withSession: () => {
      const prep = (sql: string, params: unknown[] = []) => ({
        sql,
        params,
        bind: (...p: unknown[]) => prep(sql, p),
        all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
      });
      return {
        prepare: (sql: string) => prep(sql),
        getBookmark: () => null,
        batch: async (stmts: { sql: string; params: unknown[] }[]) => {
          db.transaction(() => {
            for (const s of stmts) db.prepare(s.sql).run(...(s.params as never[]));
          })();
        },
      };
    },
  };
}

/** A DurableObjectState over bun:sqlite, with Cloudflare's single-slot alarm (setAlarm
 * replaces the pending one) and the hibernatable-socket list. */
function makeState(db: Database) {
  let depth = 0;
  const sockets: FakeWs[] = [];
  const alarm = { at: null as number | null };
  const state = {
    storage: {
      sql: { exec: (sql: string, ...params: unknown[]) => ({ toArray: () => db.prepare(sql).all(...(params as never[])) }) },
      transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
        const sp = `sp${depth++}`;
        db.exec(`SAVEPOINT ${sp}`);
        try {
          const r = await fn();
          db.exec(`RELEASE ${sp}`);
          return r;
        } catch (e) {
          db.exec(`ROLLBACK TO ${sp}`);
          db.exec(`RELEASE ${sp}`);
          throw e;
        } finally {
          depth--;
        }
      },
      setAlarm: async (at: number) => void (alarm.at = at),
      getAlarm: async () => alarm.at,
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    acceptWebSocket: (ws: FakeWs) => void sockets.push(ws),
    getWebSockets: () => sockets,
    waitUntil: () => {},
  };
  return { state, sockets, alarm };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setup(app: any, extraEnv: Record<string, string> = {}) {
  const KV = makeKv();
  const d1db = new Database(":memory:");
  const PramenDO = pramenDO(app);
  const dos = new Map<string, { inst: InstanceType<typeof PramenDO>; db: Database; sockets: FakeWs[]; alarm: { at: number | null } }>();
  const doEnv = { AUTH_SECRET: SECRET, KV, ...extraEnv } as never;
  const doFor = (id: string) => {
    let d = dos.get(id);
    if (!d) {
      const db = new Database(":memory:");
      const { state, sockets, alarm } = makeState(db);
      d = { inst: new PramenDO(state as never, doEnv), db, sockets, alarm };
      dos.set(id, d);
    }
    return d;
  };
  const PRAMEN = { idFromName: (n: string) => n, get: (id: string) => ({ fetch: (r: Request) => doFor(id).inst.fetch(r) }) };
  const env = { AUTH_SECRET: SECRET, KV, DB: makeD1(d1db), PRAMEN, FILES: {}, ...extraEnv } as never;
  const ectx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
  const worker = makeWorker(app);
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await worker.fetch(
      new Request(`https://app.example${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
      env,
      ectx,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const upgrade = (token: string) =>
    worker.fetch(new Request(`https://app.example/live?token=${token}`, { headers: { Upgrade: "websocket" } }), env, ectx);
  return { call, upgrade, d1db, doFor, kv: new Kv(KV as never), worker, env, ectx };
}

const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hs256(payload: Record<string, unknown>): Promise<string> {
  const h = b64u(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64u(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${h}.${p}.${b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${h}.${p}`))))}`;
}
const claims = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
const nowS = () => Math.floor(Date.now() / 1000);

// --- the store is operator config --------------------------------------------

describe("x-pramen-store is ignored unless the operator opts in", () => {
  const app = {
    schema: defineSchema({ ...authSchema }),
    handlers: {
      ...authHandlers,
      adminOnly: query(async () => ({ secret: "admin-only" }), { auth: ["admin"] }),
      whichStore: query(async (ctx) => ({ store: ctx.store, identity: ctx.identity })),
    },
    acl: [],
    routes: [
      {
        method: "POST",
        path: "/hook",
        handler: async (req: Request, _env: unknown, ctx: { callPrivileged(o: unknown): Promise<Response> }) => {
          const opts = (await req.json()) as Record<string, unknown>;
          return ctx.callPrivileged({ name: "whichStore", ...opts });
        },
      },
    ],
  } as never;

  test("forward: a D1 signup of a DO admin's username lands on the DO and is refused", async () => {
    const { call, doFor, d1db } = setup(app);
    expect((await call("/rpc/signup", { username: "victim-admin", password: "victim-real-pw-1" })).status).toBe(200);
    doFor("main").db.exec(`UPDATE auth_users SET roles = '["admin"]' WHERE username = 'victim-admin'`);

    const viaHeader = await call("/rpc/signup", { username: "victim-admin", password: "attacker-pw-1" }, { "x-pramen-store": "d1" });
    expect(viaHeader.status).toBe(400); // username taken: the header did not move it to D1
    // Nothing ever touched D1 (the auth_users table there was never even created).
    expect(d1db.prepare("SELECT name FROM sqlite_master WHERE name = 'auth_users'").all()).toEqual([]);
  });

  test("reverse: on PRAMEN_STORE=d1, `x-pramen-store: do` cannot force the DO", async () => {
    const { call, d1db } = setup(app, { PRAMEN_STORE: "d1" });
    expect((await call("/rpc/signup", { username: "victim-admin", password: "victim-real-pw-1" })).status).toBe(200);
    d1db.exec(`UPDATE auth_users SET roles = '["admin"]' WHERE username = 'victim-admin'`);
    const viaHeader = await call("/rpc/signup", { username: "victim-admin", password: "attacker-pw-1" }, { "x-pramen-store": "do" });
    expect(viaHeader.status).toBe(400);
  });

  test("the full chain no longer escalates: the attacker never gets a token to refresh", async () => {
    const { call, doFor } = setup(app);
    await call("/rpc/signup", { username: "victim-admin", password: "victim-real-pw-1" });
    doFor("main").db.exec(`UPDATE auth_users SET roles = '["admin"]' WHERE username = 'victim-admin'`);
    const d1 = await call("/rpc/signup", { username: "victim-admin", password: "attacker-pw-1" }, { "x-pramen-store": "d1" });
    expect(d1.body?.result?.token).toBeUndefined();
  });

  test("/rpc and a route's callPrivileged both follow PRAMEN_STORE when the header is not allowed", async () => {
    const { call } = setup(app);
    expect((await call("/rpc/whichStore", null, { "x-pramen-store": "d1" })).body.result.store).toBe("do");
    expect((await call("/hook", {}, { "x-pramen-store": "d1" })).body.result.store).toBe("do");
    const d1 = setup(app, { PRAMEN_STORE: "d1" });
    expect((await d1.call("/rpc/whichStore", null, { "x-pramen-store": "do" })).body.result.store).toBe("d1");
    expect((await d1.call("/hook", {}, { "x-pramen-store": "do" })).body.result.store).toBe("d1");
  });

  test("PRAMEN_STORE_HEADER=allow restores per-request selection (local dev, tests)", async () => {
    const { call } = setup(app, { PRAMEN_STORE_HEADER: "allow" });
    expect((await call("/rpc/whichStore", null, { "x-pramen-store": "d1" })).body.result.store).toBe("d1");
    expect((await call("/hook", {}, { "x-pramen-store": "d1" })).body.result.store).toBe("d1");
    expect((await call("/rpc/whichStore", null)).body.result.store).toBe("do");
  });

  test("callPrivileged forwards userId and keeps an explicit roles: [] on both stores", async () => {
    for (const extra of [{}, { PRAMEN_STORE: "d1" }]) {
      const { call } = setup(app, extra);
      const withUser = await call("/hook", { roles: [], userId: "ada" });
      expect(withUser.body.result.identity).toEqual({ roles: [], userId: "ada" });
      const plain = await call("/hook", {});
      expect(plain.body.result.identity).toEqual({ roles: ["admin"] });
    }
  });

  test("refreshSession on the operator's store still works for the real account", async () => {
    const { call } = setup(app);
    const signup = await call("/rpc/signup", { username: "ada", password: "ada-real-pw-1" });
    const refreshed = await call("/rpc/refreshSession", {}, { authorization: `Bearer ${signup.body.result.token}` });
    expect(refreshed.status).toBe(200);
    expect(claims(refreshed.body.result.token).sub).toBe("ada");
  });
});

// --- revocation reaches an open socket -----------------------------------------

describe("hard revocation reaches an open /live socket", () => {
  const app = {
    schema: defineSchema({ items: Entity((t) => ({ id: t.id(), by: t.text() })) }),
    acl: [role("user", [policy("ir", "items", "read", allow()), policy("ic", "items", "create", allow())])],
    handlers: {
      addItem: mutation(
        async (ctx) => {
          await ctx.db.insert("items", { by: String(ctx.identity?.userId) });
          return { by: ctx.identity?.userId ?? null };
        },
        { auth: "authenticated" },
      ),
      countItems: query(async (ctx) => ctx.db.count({ from: "items" }), { auth: "authenticated" }),
    },
  } as never;

  const open = async (h: ReturnType<typeof setup>, token: string): Promise<FakeWs> => {
    const res = await h.upgrade(token);
    expect(res.headers.get("x-upgraded")).toBe("1");
    const sockets = h.doFor("main").sockets;
    return sockets[sockets.length - 1]!;
  };
  const frame = (h: ReturnType<typeof setup>, ws: FakeWs, msg: unknown) => h.doFor("main").inst.webSocketMessage(ws as never, JSON.stringify(msg));
  const rows = (h: ReturnType<typeof setup>) => h.doFor("main").db.query("SELECT by FROM items ORDER BY id").all() as { by: string }[];

  test("a denied user's call frame is refused and the socket closed 4401", async () => {
    const h = setup(app);
    const bob = await open(h, await hs256({ sub: "bob", roles: ["user"], iat: nowS(), exp: nowS() + 3600 }));
    await denySession(h.kv, "bob", 3600);
    await frame(h, bob, { type: "call", id: "c1", name: "addItem", input: {} });
    expect(rows(h)).toEqual([]);
    expect(JSON.parse(bob.sent.at(-1)!)).toMatchObject({ type: "error", id: "c1", code: "unauthorized", error: "session revoked" });
    expect(bob.closed).toEqual([4401, "session revoked"]);
  });

  test("an exp-less token is revoked just the same (no TTL ever forces a reconnect)", async () => {
    const h = setup(app);
    const carol = await open(h, await hs256({ sub: "carol", roles: ["user"] }));
    await denySession(h.kv, "carol", 3600);
    await frame(h, carol, { type: "call", id: "k1", name: "addItem", input: {} });
    expect(rows(h)).toEqual([]);
    expect(carol.closed?.[0]).toBe(4401);
  });

  test("a revoked subscriber gets no further pushes: the next broadcast closes it", async () => {
    const h = setup(app);
    const bob = await open(h, await hs256({ sub: "bob", roles: ["user"], iat: nowS(), exp: nowS() + 3600 }));
    await frame(h, bob, { type: "subscribe", id: "s1", name: "countItems", input: null });
    expect(bob.sent.map((m) => JSON.parse(m))).toEqual([{ type: "data", id: "s1", result: 0 }]);
    await denySession(h.kv, "bob", 3600);
    const dave = await hs256({ sub: "dave", roles: ["user"], iat: nowS(), exp: nowS() + 3600 });
    expect((await h.call("/rpc/addItem", {}, { authorization: `Bearer ${dave}` })).status).toBe(200);
    expect(bob.sent).toHaveLength(1); // no push carrying dave's write
    expect(bob.closed).toEqual([4401, "session revoked"]);
  });

  test("an unrevoked socket keeps working alongside", async () => {
    const h = setup(app);
    const eve = await open(h, await hs256({ sub: "eve", roles: ["user"], iat: nowS(), exp: nowS() + 3600 }));
    await frame(h, eve, { type: "subscribe", id: "s1", name: "countItems", input: null });
    await frame(h, eve, { type: "call", id: "c1", name: "addItem", input: {} });
    expect(eve.closed).toBeNull();
    expect(rows(h)).toEqual([{ by: "eve" }]);
    expect(eve.sent.map((m) => JSON.parse(m).type)).toEqual(["data", "result", "data"]);
  });

  test("a not-before instant revokes older tokens on HTTP, the upgrade and an open socket, newer ones survive", async () => {
    const h = setup(app);
    const old = await hs256({ sub: "fay", roles: ["user"], iat: nowS() - 120, exp: nowS() + 3600 });
    const fayWs = await open(h, old);
    await setSessionNotBefore(h.kv, "fay", nowS() - 60, 3600);

    const http = await h.call("/rpc/addItem", {}, { authorization: `Bearer ${old}` });
    expect(http.status).toBe(401);
    expect(http.body).toMatchObject({ error: "session revoked", code: "unauthorized" });
    expect((await h.upgrade(old)).status).toBe(401);
    await frame(h, fayWs, { type: "call", id: "c1", name: "addItem", input: {} });
    expect(fayWs.closed).toEqual([4401, "session revoked"]);

    const fresh = await hs256({ sub: "fay", roles: ["user"], iat: nowS(), exp: nowS() + 3600 });
    expect((await h.call("/rpc/addItem", {}, { authorization: `Bearer ${fresh}` })).status).toBe(200);
    const freshWs = await open(h, fresh);
    await frame(h, freshWs, { type: "call", id: "c2", name: "addItem", input: {} });
    expect(freshWs.closed).toBeNull();
    expect(rows(h)).toEqual([{ by: "fay" }, { by: "fay" }]);

    // A token with no iat cannot prove it is newer than the instant: fail closed.
    const noIat = await hs256({ sub: "fay", roles: ["user"], exp: nowS() + 3600 });
    expect((await h.call("/rpc/addItem", {}, { authorization: `Bearer ${noIat}` })).status).toBe(401);
  });
});

// --- the drain alarm is not a trailing debounce ----------------------------------

describe("armDrain keeps an earlier pending alarm", () => {
  const app = {
    schema: defineSchema({ items: Entity((t) => ({ id: t.id(), by: t.text() })) }),
    acl: [role("anonymous", [policy("ic", "items", "create", allow())])],
    handlers: {
      enqueue: mutation(async (ctx) => {
        await ctx.tasks.enqueue({ kind: "noop", payload: {} });
        return null;
      }),
    },
    tasks: { noop: async () => {} },
  } as never;

  test("a stream of enqueues 40 ms apart does not push the alarm back", async () => {
    const h = setup(app);
    const t0 = 1_900_000_000_000;
    setSystemTime(new Date(t0));
    expect((await h.call("/rpc/enqueue", null)).status).toBe(200);
    const alarm = h.doFor("main").alarm;
    expect(alarm.at).toBe(t0 + 50);
    for (let i = 1; i <= 10; i++) {
      setSystemTime(new Date(t0 + i * 40));
      expect((await h.call("/rpc/enqueue", null)).status).toBe(200);
      expect(alarm.at).toBe(t0 + 50); // the first drain stays due 50 ms after the first enqueue
    }
    setSystemTime();
  });

  test("a later pending alarm (a backed-off retry) is pulled in to now + 50", async () => {
    const h = setup(app);
    const t0 = 1_900_000_000_000;
    setSystemTime(new Date(t0));
    const alarm = h.doFor("main").alarm;
    alarm.at = t0 + 600_000;
    expect((await h.call("/rpc/enqueue", null)).status).toBe(200);
    expect(alarm.at).toBe(t0 + 50);
    setSystemTime();
  });
});
