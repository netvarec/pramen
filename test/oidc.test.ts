// @pramen/auth — the OIDC authorization-code + PKCE flow.
//
// Driven against a FAKE provider: a real RS256 key pair via WebCrypto, a discovery document,
// a JWKS, and a token endpoint, all served through a stubbed `fetch`. That exercises the
// parts that actually go wrong — signature and nonce verification, PKCE, single-use state,
// and the account-key rules — without a network or a real IdP.

import { afterEach, describe, expect, test } from "bun:test";
import { createOidcAuth, oidcHandlers, OIDC_UPSERT_HANDLER } from "../packages/auth/src/oidc";

const ISSUER = "https://idp.example.com";
const CLIENT_ID = "pramen-app";
const b64url = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  return btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

async function idToken(claims: Record<string, unknown>, signer: CryptoKey = keys.privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ iss: ISSUER, aud: CLIENT_ID, exp: now + 300, iat: now, ...claims })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

/** An in-memory KV + the fake provider, wired into a stubbed fetch. */
function harness(opts: { tokenResponse?: (nonce: string) => Promise<unknown> } = {}) {
  const store = new Map<string, string>();
  // The nonce the authorization request carried. A real provider echoes it into the ID
  // token; here it is captured from the redirect, because the callback consumes the stored
  // state BEFORE the exchange (that single-use delete is the point of the state).
  const asked = { nonce: "" };
  const KV = {
    get: async (k: string, type?: string) => { const v = store.get(k) ?? null; return v !== null && type === "json" ? JSON.parse(v) : v; },
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  };
  const seen: { tokenBody?: URLSearchParams } = {};
  const jwk = crypto.subtle.exportKey("jwk", keys.publicKey);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    }
    if (url.endsWith("/jwks")) return Response.json({ keys: [{ ...(await jwk), kid: "k1", alg: "RS256", use: "sig" }] });
    if (url.endsWith("/token")) {
      seen.tokenBody = new URLSearchParams(String(init?.body));
      return Response.json(await (opts.tokenResponse ?? (async (n: string) => ({ id_token: await idToken({ sub: "idp-sub-1", email: "ada@acme.com", email_verified: true, nonce: n }) })))(asked.nonce));
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { KV: KV as unknown as KVNamespace, store, seen, asked, restore: () => { globalThis.fetch = original; } };
}

const env = (KV: KVNamespace) => ({ KV, AUTH_SECRET: "a-sufficiently-long-test-secret" }) as never;
const opts = { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: "s3cret", redirectUri: "https://app.example.com/auth/oidc/callback", successRedirect: "https://app.example.com/signed-in" };

/** A privileged-call stub standing in for the users table. */
const upsert = (result: unknown = { roles: ["user"], active: true }) => ({ callPrivileged: async () => Response.json({ ok: true, result }) }) as never;

let active: { restore: () => void } | null = null;
afterEach(() => { active?.restore(); active = null; });

async function startThenCallback(h: ReturnType<typeof harness>, over: { state?: string; code?: string; ctx?: never } = {}) {
  const oidc = createOidcAuth(opts);
  const [start, callback] = oidc.routes;
  const started = await start!.handler(new Request("https://app.example.com/auth/oidc/start"), env(h.KV), {} as never);
  const authUrl = new URL(started.headers.get("location")!);
  h.asked.nonce = authUrl.searchParams.get("nonce")!;
  const state = over.state ?? authUrl.searchParams.get("state")!;
  const cb = new Request(`https://app.example.com/auth/oidc/callback?state=${encodeURIComponent(state)}&code=${over.code ?? "auth-code"}`);
  return { authUrl, res: await callback!.handler(cb, env(h.KV), over.ctx ?? upsert()) };
}

describe("createOidcAuth — the authorization request", () => {
  test("redirects to the provider's authorize endpoint with PKCE S256 and a nonce", async () => {
    const h = harness(); active = h;
    const { authUrl } = await startThenCallback(h);
    expect(authUrl.origin + authUrl.pathname).toBe(`${ISSUER}/authorize`);
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/); // base64url SHA-256
    expect(authUrl.searchParams.get("nonce")).toBeTruthy();
    expect(authUrl.searchParams.get("scope")).toBe("openid email profile");
  });

  // The verifier is what proves this client redeemed the code. It must never leave the
  // server — the browser carries only the random state key.
  test("the PKCE verifier stays server-side; the browser gets only the state key", async () => {
    const h = harness(); active = h;
    // Only the START leg: the callback consumes the stored state, so the verifier has to be
    // inspected while the login is still in flight.
    const [start] = createOidcAuth(opts).routes;
    const started = await start!.handler(new Request("https://app.example.com/auth/oidc/start"), env(h.KV), {} as never);
    const stored = JSON.parse([...h.store.values()][0]!) as { verifier: string };
    expect(stored.verifier).toBeTruthy();
    expect(started.headers.get("location")).not.toContain(stored.verifier);
  });
});

describe("createOidcAuth — the callback", () => {
  test("exchanges the code with the verifier and lands the session in the URL FRAGMENT", async () => {
    const h = harness(); active = h;
    const { res } = await startThenCallback(h);
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location")!);
    expect(target.origin + target.pathname).toBe("https://app.example.com/signed-in");
    // A fragment is never sent to a server — not in logs, not in Referer.
    expect(target.hash).toMatch(/^#token=/);
    expect(target.search).toBe("");
    expect(h.seen.tokenBody?.get("code_verifier")).toBeTruthy();
    expect(h.seen.tokenBody?.get("grant_type")).toBe("authorization_code");
    expect(h.seen.tokenBody?.get("client_secret")).toBe("s3cret");
  });

  test("the minted token is a pramen session, not the provider's", async () => {
    const h = harness(); active = h;
    const { res } = await startThenCallback(h);
    const token = decodeURIComponent(new URL(res.headers.get("location")!).hash.replace("#token=", ""));
    const [, payload] = token.split(".");
    const claims = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/"))) as { sub: string; roles: string[] };
    expect(claims.sub).toBe("ada@acme.com"); // keyed on the verified email
    expect(claims.roles).toEqual(["user"]);
  });

  // State is the anti-replay: two tabs racing one code, or a resubmitted callback, must not
  // both proceed.
  test("state is SINGLE USE — replaying the same callback fails", async () => {
    const h = harness(); active = h;
    const oidc = createOidcAuth(opts);
    const [start, callback] = oidc.routes;
    const started = await start!.handler(new Request("https://app.example.com/auth/oidc/start"), env(h.KV), {} as never);
    h.asked.nonce = new URL(started.headers.get("location")!).searchParams.get("nonce")!;
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    const cb = () => callback!.handler(new Request(`https://app.example.com/auth/oidc/callback?state=${state}&code=c`), env(h.KV), upsert());
    expect((await cb()).status).toBe(302);
    expect((await cb()).status).toBe(400); // replayed
  });

  test("an unknown state is refused", async () => {
    const h = harness(); active = h;
    const { res } = await startThenCallback(h, { state: "not-a-real-state" });
    expect(res.status).toBe(400);
  });

  test("a provider error redirect is reported as such, not as a missing code", async () => {
    const h = harness(); active = h;
    const [, callback] = createOidcAuth(opts).routes;
    const res = await callback!.handler(new Request("https://app.example.com/auth/oidc/callback?error=access_denied"), env(h.KV), upsert());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("access_denied");
  });

  // The nonce binds the ID token to THIS authorization request. Without the check, a token
  // minted for another session of the same client would be accepted.
  test("an ID token with the wrong nonce is refused", async () => {
    const h = harness({ tokenResponse: async () => ({ id_token: await idToken({ sub: "s", email: "ada@acme.com", email_verified: true, nonce: "someone-elses-nonce" }) }) });
    active = h;
    const { res } = await startThenCallback(h);
    expect(res.status).toBe(401);
  });

  test("an ID token signed by the wrong key is refused", async () => {
    const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const h = harness({ tokenResponse: async () => ({ id_token: await idToken({ sub: "s", email: "ada@acme.com", email_verified: true, nonce: "x" }, other.privateKey) }) });
    active = h;
    const { res } = await startThenCallback(h);
    expect(res.status).toBe(401);
  });

  test("a failed token exchange does not masquerade as a bad login", async () => {
    const h = harness({ tokenResponse: async () => ({ error: "invalid_grant" }) }); active = h;
    const { res } = await startThenCallback(h);
    expect(res.status).toBe(502);
  });

  // Keying accounts on email is what links an OIDC login to an existing magic-link or
  // password account. An UNVERIFIED address would make that an account-takeover path.
  test("an unverified email is refused when accounts are keyed on email", async () => {
    const h = harness({ tokenResponse: async () => ({ id_token: await idToken({ sub: "s", email: "ada@acme.com", email_verified: false, nonce: h.asked.nonce }) }) });
    active = h;
    const { res } = await startThenCallback(h);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("verified email");
  });

  test("`accountKey: \"sub\"` keys on issuer#sub and needs no email at all", async () => {
    const h = harness({ tokenResponse: async () => ({ id_token: await idToken({ sub: "idp-sub-1", nonce: h.asked.nonce }) }) });
    active = h;
    const oidc = createOidcAuth({ ...opts, accountKey: "sub" });
    const [start, callback] = oidc.routes;
    const started = await start!.handler(new Request("https://app.example.com/auth/oidc/start"), env(h.KV), {} as never);
    h.asked.nonce = new URL(started.headers.get("location")!).searchParams.get("nonce")!;
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    const res = await callback!.handler(new Request(`https://app.example.com/auth/oidc/callback?state=${state}&code=c`), env(h.KV), upsert());
    const token = decodeURIComponent(new URL(res.headers.get("location")!).hash.replace("#token=", ""));
    const claims = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { sub: string };
    expect(claims.sub).toBe(`${ISSUER}#idp-sub-1`);
  });

  // The IdP knows nothing about pramen's deactivation flag, so logging in through it must
  // not revive a disabled account.
  test("a deactivated account cannot log back in through the IdP", async () => {
    const h = harness(); active = h;
    const { res } = await startThenCallback(h, { ctx: upsert({ roles: ["user"], active: false }) as never });
    expect(res.status).toBe(403);
  });
});

describe("the privileged upsert handler", () => {
  test("is unreachable over /rpc — no role satisfies it", () => {
    expect((oidcHandlers[OIDC_UPSERT_HANDLER] as { auth?: string[] }).auth).toEqual([]);
  });
});
