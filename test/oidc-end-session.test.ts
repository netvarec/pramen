// @pramen/auth: RP-Initiated Logout (`endSession`). Same fake-provider technique as
// oidc.test.ts: a real RS256 key, discovery, JWKS and token endpoint behind a stubbed fetch,
// plus an `end_session_endpoint` whose answer each test picks.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createOidcAuth } from "../packages/auth/src/oidc";

const ISSUER = "https://idp-logout.example.com";
const CLIENT_ID = "pramen-app";
const b64url = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  return btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const gen = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const keys = await gen();
const stranger = await gen();

async function idToken(claims: Record<string, unknown>, signer: CryptoKey = keys.privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ iss: ISSUER, aud: CLIENT_ID, exp: now + 300, iat: now, sid: "provider-session", ...claims })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

function harness(provider: { endSession?: boolean; issuer?: string; answer?: () => Response | Promise<Response> } = {}) {
  const store = new Map<string, string>();
  const asked = { nonce: "" };
  const calls: string[] = [];
  const KV = {
    get: async (k: string, type?: string) => { const v = store.get(k) ?? null; return v !== null && type === "json" ? JSON.parse(v) : v; },
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  };
  const jwk = crypto.subtle.exportKey("jwk", keys.publicKey);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: provider.issuer ?? ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
        ...(provider.endSession === false ? {} : { end_session_endpoint: `${ISSUER}/end-session` }),
      });
    }
    if (url.endsWith("/jwks")) return Response.json({ keys: [{ ...(await jwk), kid: "k1", alg: "RS256", use: "sig" }] });
    if (url.endsWith("/token")) return Response.json({ id_token: await idToken({ sub: "s1", email: "ada@acme.com", email_verified: true, nonce: asked.nonce }) });
    if (url.startsWith(`${ISSUER}/end-session`)) return (provider.answer ?? (() => new Response(null, { status: 200 })))();
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { KV: KV as unknown as KVNamespace, asked, calls, restore: () => { globalThis.fetch = original; } };
}

const env = (KV: KVNamespace) => ({ KV, AUTH_SECRET: "a-sufficiently-long-test-secret" }) as never;
const base = { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: "s3cret", redirectUri: "https://app.example.com/auth/oidc/callback", successRedirect: "https://app.example.com/signed-in" };
const upsert = { callPrivileged: async () => Response.json({ ok: true, result: { roles: ["user"], active: true } }) } as never;

let active: { restore: () => void } | null = null;
afterEach(() => { active?.restore(); active = null; });

async function signIn(h: ReturnType<typeof harness>, endSession: boolean): Promise<URLSearchParams> {
  const [start, callback] = createOidcAuth({ ...base, endSession }).routes;
  const started = await start!.handler(new Request("https://app.example.com/auth/oidc/start"), env(h.KV), {} as never);
  const authUrl = new URL(started.headers.get("location")!);
  h.asked.nonce = authUrl.searchParams.get("nonce")!;
  const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0]!;
  const res = await callback!.handler(new Request(`https://app.example.com/auth/oidc/callback?state=${encodeURIComponent(authUrl.searchParams.get("state")!)}&code=c`, { headers: { cookie } }), env(h.KV), upsert);
  return new URLSearchParams(new URL(res.headers.get("location")!).hash.slice(1));
}

const logoutRoute = (over: Record<string, unknown> = {}) => createOidcAuth({ ...base, endSession: true, ...over }).routes[2]!;
const post = (body: unknown, origin: string | null = "https://app.example.com") =>
  new Request("https://app.example.com/auth/oidc/logout", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });

describe("endSession: the sign-in fragment", () => {
  test("carries the ID token next to the session only when enabled", async () => {
    const h = harness(); active = h;
    const on = await signIn(h, true);
    expect(on.get("token")).toBeTruthy();
    expect(on.get("id_token")!.split(".")).toHaveLength(3);
    const off = await signIn(h, false);
    expect(off.get("token")).toBeTruthy();
    expect(off.has("id_token")).toBe(false);
  });

  test("off: two routes, as before; on: a third at the default path", () => {
    expect(createOidcAuth(base).routes).toHaveLength(2);
    const routes = createOidcAuth({ ...base, endSession: true }).routes;
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /auth/oidc/start", "GET /auth/oidc/callback", "POST /auth/oidc/logout"]);
    expect(createOidcAuth({ ...base, endSession: true, logoutPath: "/x/out" }).routes[2]!.path).toBe("/x/out");
  });
});

describe("endSession: the logout route", () => {
  test("a valid ID token ends the provider session server to server", async () => {
    const h = harness(); active = h;
    const res = await logoutRoute().handler(post({ idToken: await idToken({}) }), env(h.KV), {} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, provider: "signed_out" });
    const ended = new URL(h.calls.find((u) => u.startsWith(`${ISSUER}/end-session`))!);
    expect(ended.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(ended.searchParams.get("id_token_hint")!.split(".")).toHaveLength(3);
  });

  test("an EXPIRED but genuine ID token from a still-possible session signs out", async () => {
    const h = harness(); active = h;
    const now = Math.floor(Date.now() / 1000);
    // Issued 50 min ago, expired 45 min ago: within the default 1 h session TTL.
    const old = await idToken({ iat: now - 3000, exp: now - 2700 });
    expect(await (await logoutRoute().handler(post({ idToken: old }), env(h.KV), {} as never)).json()).toEqual({ ok: true, provider: "signed_out" });
  });

  test("a token older than any session it could belong to is refused (not a lasting capability)", async () => {
    const h = harness(); active = h;
    const now = Math.floor(Date.now() / 1000);
    const ancient = await idToken({ iat: now - 2 * 3600, exp: now - 2 * 3600 + 300 });
    const res = await logoutRoute().handler(post({ idToken: ancient }), env(h.KV), {} as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "stale_token" });
    // The window follows sessionTtlSeconds.
    const long = logoutRoute({ sessionTtlSeconds: 8 * 3600 });
    expect(await (await long.handler(post({ idToken: ancient }), env(h.KV), {} as never)).json()).toEqual({ ok: true, provider: "signed_out" });
    const noIat = await idToken({ iat: undefined });
    expect(await (await logoutRoute().handler(post({ idToken: noIat }), env(h.KV), {} as never)).json()).toEqual({ ok: false, error: "stale_token" });
  });

  test("only the app's own origin may ask; a missing Origin is refused too", async () => {
    const h = harness(); active = h;
    const token = await idToken({});
    for (const origin of ["https://evil.example.com", "http://app.example.com", null]) {
      const res = await logoutRoute().handler(post({ idToken: token }, origin), env(h.KV), {} as never);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: "forbidden_origin" });
    }
    expect(h.calls.some((u) => u.startsWith(`${ISSUER}/end-session`))).toBe(false);
  });

  test("a forged, foreign or missing token is refused and never reaches the provider", async () => {
    const h = harness(); active = h;
    const cases = [
      { idToken: await idToken({}, stranger.privateKey) },
      { idToken: await idToken({ aud: "someone-else" }) },
      { idToken: await idToken({ iss: "https://evil.example.com" }) },
      { idToken: "not.a.token" },
      {},
    ];
    for (const body of cases) {
      const res = await logoutRoute().handler(post(body), env(h.KV), {} as never);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "invalid_token" });
    }
    expect(h.calls.some((u) => u.startsWith(`${ISSUER}/end-session`))).toBe(false);
  });

  test("a provider without end_session_endpoint answers unsupported", async () => {
    // Its own issuer: discovery is cached per issuer for the isolate's life.
    const issuer = "https://idp-no-logout.example.com";
    const h = harness({ endSession: false, issuer }); active = h;
    const res = await createOidcAuth({ ...base, issuer, endSession: true }).routes[2]!.handler(post({ idToken: await idToken({ iss: issuer }) }), env(h.KV), {} as never);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ ok: false, error: "unsupported" });
  });

  test("a provider error is reported, logged without the token", async () => {
    const h = harness({ answer: () => new Response("nope", { status: 500 }) }); active = h;
    const log = spyOn(console, "error").mockImplementation(() => {});
    const token = await idToken({});
    const res = await logoutRoute().handler(post({ idToken: token }), env(h.KV), {} as never);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "provider_failed", status: 500 });
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    log.mockRestore();
  });

  test("an unreachable provider is a failure, never signed out", async () => {
    const h = harness({ answer: () => { throw new TypeError("network down"); } }); active = h;
    const log = spyOn(console, "error").mockImplementation(() => {});
    const res = await logoutRoute().handler(post({ idToken: await idToken({}) }), env(h.KV), {} as never);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "provider_failed", status: 0 });
    log.mockRestore();
  });

  test("a discovery failure is a non-OK answer, not a thrown 500 or a success", async () => {
    const issuer = "https://idp-down.example.com";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    active = { restore: () => { globalThis.fetch = original; } };
    const log = spyOn(console, "error").mockImplementation(() => {});
    const res = await createOidcAuth({ ...base, issuer, endSession: true }).routes[2]!.handler(post({ idToken: "a.b.c" }), env({} as KVNamespace), {} as never);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "server_error" });
    log.mockRestore();
  });

  test("a redirect from the provider counts as signed out", async () => {
    const h = harness({ answer: () => new Response(null, { status: 302, headers: { location: "https://app.example.com/" } }) }); active = h;
    expect(await (await logoutRoute().handler(post({ idToken: await idToken({}) }), env(h.KV), {} as never)).json()).toEqual({ ok: true, provider: "signed_out" });
  });
});
