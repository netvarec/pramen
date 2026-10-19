// Security regressions for the Worker's deployment-configuration guard (`misconfiguration`
// in packages/server/src/worker.ts), driven through the real makeWorker:
//
//  - Dev-only values (PRAMEN_DEV_SEED, the published DEV_SECRET / dev FILES_SECRET) on a
//    non-local host: the documented deploy rendered oblaka's LOCAL vars into production,
//    so an anonymous client signed in as the seeded admin or forged an admin token. The
//    Worker now refuses every request there (500), whatever the vars say about APP_URL.
//  - JWKS_URL without AUTH_AUDIENCE + AUTH_ISSUER: a token the same IdP minted for any other
//    client or directory authenticated, roles claim included. Refused the same way.
//
// Plus the not-before KV helpers and callPrivileged's identity on the DO path.

import { describe, expect, test } from "bun:test";
import { isLocalHost, makeWorker, misconfiguration, callPrivileged, type Env } from "../packages/server/src/worker";
import { DEV_FILES_SECRET, DEV_SECRET, signDevToken } from "../packages/server/src/runtime/dev-token";
import { Kv, isIdentityRevoked, isIssuedBeforeNotBefore, setSessionNotBefore, denySession } from "../packages/server/src/runtime/kv";

function makeKv() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => ({ keys: [...m.keys()].map((name) => ({ name })), list_complete: true }),
  };
}

/** A fake DO namespace that records what it was sent and answers ok. */
function fakeDo() {
  const seen: Request[] = [];
  return {
    seen,
    PRAMEN: { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => (seen.push(r), Response.json({ ok: true, result: "do-reached" })) }) },
  };
}

const app = { schema: {}, handlers: {} } as never;
const ectx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
const LOCAL_VARS = {
  AUTH_SECRET: DEV_SECRET,
  FILES_SECRET: DEV_FILES_SECRET,
  PRAMEN_DEV_SEED: "true",
  APP_URL: "http://localhost:8787",
};

async function hit(env: Record<string, unknown>, url: string, init: RequestInit = {}) {
  const { PRAMEN } = fakeDo();
  const res = await makeWorker(app).fetch(new Request(url, init), { KV: makeKv(), PRAMEN, FILES: {}, ...env } as never, ectx);
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe("isLocalHost", () => {
  test("by default only loopback is local", () => {
    for (const h of ["localhost", "127.0.0.1", "127.3.4.5", "[::1]", "pramen.localhost"]) expect(isLocalHost(h)).toBe(true);
    for (const h of ["app.example.com", "local-pramen.acme.workers.dev", "localhost.evil.com", "10.0.0.1", "192.168.1.20", "mac.local", "0.0.0.0", "[fd12::1]"]) {
      expect(isLocalHost(h)).toBe(false);
    }
  });

  test("with the LAN opt-in the private ranges are local too; public names never are", () => {
    for (const h of ["0.0.0.0", "10.0.0.1", "172.16.4.2", "172.31.255.1", "192.168.1.20", "169.254.3.3", "mac.local", "[fd12:3456::1]", "[fe80::1]"]) {
      expect(isLocalHost(h, { lan: true })).toBe(true);
    }
    for (const h of ["172.32.0.1", "192.169.1.1", "8.8.8.8", "abc.ngrok-free.app", "[2001:db8::1]", "10.0.0.1.evil.com"]) expect(isLocalHost(h, { lan: true })).toBe(false);
  });

  test("the local vars are refused on a LAN address unless PRAMEN_DEV_ALLOW_LAN=true", async () => {
    expect((await hit(LOCAL_VARS, "http://192.168.1.20:8787/rpc/login", { method: "POST" })).status).toBe(500);
    expect((await hit({ ...LOCAL_VARS, PRAMEN_DEV_ALLOW_LAN: "true" }, "http://192.168.1.20:8787/rpc/login", { method: "POST" })).status).not.toBe(500);
  });
});

describe("dev-only values on a deployed host", () => {
  test("the rendered local vars block is refused on a deployed host, every path included", async () => {
    for (const path of ["/rpc/login", "/admin/migrations?tenant=main", "/tenants", "/files/download?t=x", "/"]) {
      const r = await hit(LOCAL_VARS, `https://local-pramen.acme.workers.dev${path}`, { method: path.startsWith("/rpc") ? "POST" : "GET" });
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ ok: false, error: "server misconfigured", code: "internal" });
    }
  });

  test("each dev value on its own is enough", () => {
    const host = "app.example.com";
    expect(misconfiguration({ PRAMEN_DEV_SEED: "true", AUTH_SECRET: "real-secret-xxxxxxxx" } as Env, host)).toContain("PRAMEN_DEV_SEED");
    expect(misconfiguration({ AUTH_SECRET: DEV_SECRET } as Env, host)).toContain("AUTH_SECRET");
    expect(misconfiguration({ AUTH_SECRET: "real-secret-xxxxxxxx", FILES_SECRET: DEV_FILES_SECRET } as Env, host)).toContain("FILES_SECRET");
  });

  test("APP_URL=localhost in the vars does not make a deployed host local", () => {
    expect(misconfiguration({ AUTH_SECRET: DEV_SECRET, APP_URL: "http://localhost:8787" } as unknown as Env, "app.example.com")).not.toBeNull();
  });

  test("a forged dev-secret admin token gets nowhere on a deployed host", async () => {
    const forged = await signDevToken({ sub: "attacker", roles: ["admin"], tenants: ["*"] }, DEV_SECRET);
    const r = await hit({ AUTH_SECRET: DEV_SECRET }, "https://app.example.com/tenants", { headers: { authorization: `Bearer ${forged}` } });
    expect(r.status).toBe(500);
  });

  test("local dev keeps working with the same vars", async () => {
    for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787", "http://pramen.localhost"]) {
      const r = await hit(LOCAL_VARS, `${origin}/rpc/anything`, { method: "POST", body: "{}" });
      expect(r.status).toBe(200);
      expect(r.body?.result).toBe("do-reached");
    }
  });

  test("a production-shaped env is served normally", async () => {
    const r = await hit({ AUTH_SECRET: "a-real-production-secret-value" }, "https://app.example.com/rpc/anything", { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
  });

  test("the dev AUTH_SECRET is moot (and not refused) when JWKS_URL replaces HS256", () => {
    expect(misconfiguration({ AUTH_SECRET: DEV_SECRET, JWKS_URL: "https://idp/jwks", AUTH_AUDIENCE: "a", AUTH_ISSUER: "i" } as Env, "app.example.com")).toBeNull();
  });
});

// --- JWKS must be bound to this service -----------------------------------------

const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const kp = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k-shared" };
async function rs256(payload: Record<string, unknown>): Promise<string> {
  const h = b64u(enc.encode(JSON.stringify({ alg: "RS256", kid: "k-shared" })));
  const p = b64u(enc.encode(JSON.stringify(payload)));
  const s = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(s))}`;
}

describe("JWKS_URL requires AUTH_AUDIENCE and AUTH_ISSUER", () => {
  const JWKS = "https://idp.example/jwks";
  const ISS = "https://idp.example/MY-DIRECTORY/";
  const now = Math.floor(Date.now() / 1000);

  // Serve the key set without touching the network, for this describe only.
  const withJwks = async <T>(fn: () => Promise<T>): Promise<T> => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ keys: [jwk] })) as unknown as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  };

  test("JWKS_URL alone, or with only one of the two, refuses to serve (any host)", async () => {
    const foreignAdmin = await rs256({ iss: "https://idp.example/OTHER-DIRECTORY/", aud: "some-other-client", sub: "mallory", roles: ["admin"], exp: now + 300 });
    for (const extra of [{}, { AUTH_AUDIENCE: "this-service" }, { AUTH_ISSUER: ISS }]) {
      for (const origin of ["https://app.example.com", "http://localhost:8787"]) {
        const r = await withJwks(() => hit({ JWKS_URL: JWKS, ...extra }, `${origin}/tenants`, { headers: { authorization: `Bearer ${foreignAdmin}` } }));
        expect(r.status).toBe(500);
      }
    }
  });

  test("with both set, a foreign token is 401 and a token for this service works", async () => {
    const env = { JWKS_URL: JWKS, AUTH_AUDIENCE: "this-service", AUTH_ISSUER: ISS };
    const foreignAudience = await rs256({ iss: ISS, aud: "some-other-client", sub: "mallory", roles: ["admin"], exp: now + 300 });
    const foreignIssuer = await rs256({ iss: "https://idp.example/OTHER-DIRECTORY/", aud: "this-service", sub: "mallory", roles: ["admin"], exp: now + 300 });
    const mine = await rs256({ iss: ISS, aud: "this-service", sub: "ada", roles: ["admin"], exp: now + 300 });
    await withJwks(async () => {
      expect((await hit(env, "https://app.example.com/tenants", { headers: { authorization: `Bearer ${foreignAudience}` } })).status).toBe(401);
      expect((await hit(env, "https://app.example.com/tenants", { headers: { authorization: `Bearer ${foreignIssuer}` } })).status).toBe(401);
      expect((await hit(env, "https://app.example.com/tenants", { headers: { authorization: `Bearer ${mine}` } })).status).toBe(200);
    });
  });
});

// --- not-before helpers ----------------------------------------------------------

describe("session not-before", () => {
  test("revokes tokens issued before the instant, keeps the same second and later", async () => {
    const kv = new Kv(makeKv() as never);
    expect(await isIssuedBeforeNotBefore(kv, "ada", 100)).toBe(false); // nothing set
    await setSessionNotBefore(kv, "ada", 1000, 3600);
    expect(await isIssuedBeforeNotBefore(kv, "ada", 999)).toBe(true);
    expect(await isIssuedBeforeNotBefore(kv, "ada", 1000)).toBe(false);
    expect(await isIssuedBeforeNotBefore(kv, "ada", 1001)).toBe(false);
    expect(await isIssuedBeforeNotBefore(kv, "ada", undefined)).toBe(true); // no iat: fail closed
    expect(await isIssuedBeforeNotBefore(kv, "bob", 1)).toBe(false); // other users untouched
  });

  test("isIdentityRevoked combines the denylist and the instant; no userId is never revoked", async () => {
    const kv = new Kv(makeKv() as never);
    await setSessionNotBefore(kv, "ada", 1000, 3600);
    await denySession(kv, "bob", 3600);
    expect(await isIdentityRevoked(kv, { userId: "ada", iat: 999 })).toBe(true);
    expect(await isIdentityRevoked(kv, { userId: "ada", iat: 1000 })).toBe(false);
    expect(await isIdentityRevoked(kv, { userId: "bob", iat: 5000 })).toBe(true);
    expect(await isIdentityRevoked(kv, { roles: ["admin"] } as never)).toBe(false);
    expect(await isIdentityRevoked(kv, null)).toBe(false);
  });

  test("the entry carries a TTL clamped to KV's 60s minimum", async () => {
    const puts: unknown[] = [];
    const kv = new Kv({ ...makeKv(), put: async (_k: string, _v: string, o: unknown) => void puts.push(o) } as never);
    await setSessionNotBefore(kv, "ada", 1000, 5);
    expect(puts).toEqual([{ expirationTtl: 60 }]);
  });
});

// --- callPrivileged identity (DO path) -------------------------------------------

describe("callPrivileged identity on the DO path", () => {
  const identityOf = async (opts: Parameters<typeof callPrivileged>[1]) => {
    const { PRAMEN, seen } = fakeDo();
    await callPrivileged({ PRAMEN } as never, opts);
    return JSON.parse(seen[0]!.headers.get("x-pramen-identity")!);
  };

  test("defaults to admin, keeps an explicit [] and forwards userId", async () => {
    expect(await identityOf({ name: "x" })).toEqual({ roles: ["admin"] });
    expect(await identityOf({ name: "x", roles: [] })).toEqual({ roles: [] });
    expect(await identityOf({ name: "x", roles: ["__sys"], userId: "ada" })).toEqual({ roles: ["__sys"], userId: "ada" });
  });
});
