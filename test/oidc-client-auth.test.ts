// @pramen/auth: how the OIDC code exchange authenticates the client at the token endpoint.
//
// A strict provider accepts only the method a client is REGISTERED with: Better Auth from 1.7
// answers `invalid_client` ("client registered for client_secret_basic cannot use
// client_secret_post") to a secret in the body, and refuses a request carrying both the Basic
// header and a body secret. So the exchange sends the secret ONE way, picked from the
// provider's discovery document: basic when it lists basic or lists nothing (the spec default),
// post only when post is all it lists. Same fake-provider technique as oidc.test.ts; each test
// gets its own issuer because discovery is cached per issuer for the isolate's life.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { basicClientAuthorization, createOidcAuth, tokenEndpointAuthMethodFor, type OidcOptions, type TokenEndpointAuthMethod } from "../packages/auth/src/oidc";

const CLIENT_ID = "pramen-app";
const SECRET = "s3cret";
const b64url = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  return btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

async function idToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ exp: now + 300, iat: now, ...claims })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

/** What the token endpoint received. */
interface Seen {
  body: URLSearchParams;
  authorization: string | null;
}

let issuers = 0;
/** A fake provider at a fresh issuer, advertising `methods` (omitted from the document when
 * `undefined`). The token request gets `answer`'s response, or an ID token for `aud` when
 * there is none. */
function provider(methods: unknown, answer?: (req: Seen) => Response | undefined, aud = CLIENT_ID) {
  const issuer = `https://idp-${++issuers}.client-auth.example.com`;
  const store = new Map<string, string>();
  const asked = { nonce: "" };
  const seen: Seen[] = [];
  const KV = {
    get: async (k: string, type?: string) => { const v = store.get(k) ?? null; return v !== null && type === "json" ? JSON.parse(v) : v; },
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  };
  const jwk = crypto.subtle.exportKey("jwk", keys.publicKey);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        ...(methods === undefined ? {} : { token_endpoint_auth_methods_supported: methods }),
      });
    }
    if (url === `${issuer}/jwks`) return Response.json({ keys: [{ ...(await jwk), kid: "k1", alg: "RS256", use: "sig" }] });
    if (url === `${issuer}/token`) {
      const req = { body: new URLSearchParams(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") };
      seen.push(req);
      const answered = answer?.(req);
      if (answered) return answered;
      return Response.json({ id_token: await idToken({ iss: issuer, aud, sub: "s1", email: "ada@acme.com", email_verified: true, nonce: asked.nonce }) });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { issuer, KV: KV as unknown as KVNamespace, asked, seen, restore: () => { globalThis.fetch = original; } };
}

/** A provider strict the way Better Auth 1.7 is: the client is registered for ONE method, and
 * the other one is refused with its `invalid_client`, before the code is looked at. */
const registeredFor = (method: TokenEndpointAuthMethod) => (req: Seen): Response | undefined => {
  const used: TokenEndpointAuthMethod = req.authorization ? "client_secret_basic" : "client_secret_post";
  if (used === method) return undefined;
  return Response.json({ error: "invalid_client", error_description: `client registered for ${method} cannot use ${used}` }, { status: 401 });
};

let active: { restore: () => void } | null = null;
afterEach(() => { active?.restore(); active = null; });

const env = (KV: KVNamespace) => ({ KV, AUTH_SECRET: "a-sufficiently-long-test-secret" }) as never;
const upsert = { callPrivileged: async () => Response.json({ ok: true, result: { roles: ["user"], active: true } }) } as never;

const configure = (p: ReturnType<typeof provider>, over: Partial<OidcOptions> = {}) =>
  createOidcAuth({
    issuer: p.issuer, clientId: CLIENT_ID, clientSecret: SECRET,
    redirectUri: "https://app.example.com/auth/oidc/callback", successRedirect: "https://app.example.com/signed-in", ...over,
  });

/** One whole sign-in against `p` through a fresh `createOidcAuth`; returns the callback's answer. */
async function signIn(p: ReturnType<typeof provider>, over: Partial<OidcOptions> = {}): Promise<Response> {
  const [start, callback] = configure(p, over).routes;
  const started = await start!.handler(new Request("https://app.example.com/auth/oidc/start"), env(p.KV), {} as never);
  const authUrl = new URL(started.headers.get("location")!);
  p.asked.nonce = authUrl.searchParams.get("nonce")!;
  const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0]!;
  const state = encodeURIComponent(authUrl.searchParams.get("state")!);
  return callback!.handler(new Request(`https://app.example.com/auth/oidc/callback?state=${state}&code=c`, { headers: { cookie } }), env(p.KV), upsert);
}

/** The inverse of RFC 6749 §2.3.1, the way a provider reads the header (Better Auth 1.7's
 * `decodeBasicCredentials`): base64, split on the FIRST `:`, form-url-decode each half. */
function decodeBasic(authorization: string): { id: string; secret: string } {
  const decoded = atob(authorization.replace(/^Basic +/, ""));
  const at = decoded.indexOf(":");
  const formDecode = (v: string) => new URLSearchParams(`v=${v}`).get("v")!;
  return { id: formDecode(decoded.slice(0, at)), secret: formDecode(decoded.slice(at + 1)) };
}

/** The sent request used basic, and ONLY basic: no credential of the client in the body. */
function expectBasic(seen: Seen | undefined, id = CLIENT_ID, secret = SECRET) {
  expect(seen?.authorization).toMatch(/^Basic [A-Za-z0-9+/]+=*$/);
  expect(decodeBasic(seen!.authorization!)).toEqual({ id, secret });
  expect(seen!.body.has("client_secret")).toBe(false);
  expect(seen!.body.has("client_id")).toBe(false);
  expect(seen!.body.get("code_verifier")).toBeTruthy();
  expect(seen!.body.get("grant_type")).toBe("authorization_code");
}

function expectPost(seen: Seen | undefined) {
  expect(seen?.authorization).toBeNull();
  expect(seen!.body.get("client_id")).toBe(CLIENT_ID);
  expect(seen!.body.get("client_secret")).toBe(SECRET);
}

describe("the token request's client authentication", () => {
  test("uses client_secret_basic when the provider lists it", async () => {
    const p = provider(["client_secret_basic", "client_secret_post", "private_key_jwt"]); active = p;
    expect((await signIn(p)).status).toBe(302);
    expect(p.seen).toHaveLength(1);
    expectBasic(p.seen[0]);
  });

  test("uses client_secret_basic when discovery says nothing (the spec default)", async () => {
    const p = provider(undefined); active = p;
    expect((await signIn(p)).status).toBe(302);
    expectBasic(p.seen[0]);
  });

  test("sends the secret in the body when client_secret_post is the only method listed", async () => {
    const p = provider(["client_secret_post"]); active = p;
    expect((await signIn(p)).status).toBe(302);
    expect(p.seen).toHaveLength(1);
    expectPost(p.seen[0]);
  });

  test("the option overrides discovery, both ways", async () => {
    const both = provider(["client_secret_basic", "client_secret_post"]); active = both;
    await signIn(both, { tokenEndpointAuthMethod: "client_secret_post" });
    expectPost(both.seen[0]);
    both.restore();

    const postOnly = provider(["client_secret_post"]); active = postOnly;
    await signIn(postOnly, { tokenEndpointAuthMethod: "client_secret_basic" });
    expectBasic(postOnly.seen[0]);
  });

  test("a public client sends its id in the body and no secret anywhere", async () => {
    const p = provider(["client_secret_basic"]); active = p;
    expect((await signIn(p, { clientSecret: undefined, tokenEndpointAuthMethod: "client_secret_basic" })).status).toBe(302);
    expect(p.seen[0]?.authorization).toBeNull();
    expect(p.seen[0]?.body.get("client_id")).toBe(CLIENT_ID);
    expect(p.seen[0]?.body.has("client_secret")).toBe(false);
  });

  test("form-encodes the id and secret before base64, so reserved characters survive", async () => {
    const id = "app:one/two";
    const secret = "p+a ss%2B:wörd&=!'()*~";
    const p = provider(["client_secret_basic"], undefined, id); active = p;
    expect((await signIn(p, { clientId: id, clientSecret: secret })).status).toBe(302);
    expectBasic(p.seen[0], id, secret);
  });
});

describe("basicClientAuthorization", () => {
  test("is RFC 6749 §2.3.1: form-urlencode each half, join with ':', base64", () => {
    // Space is `+`, and `:` inside the id is escaped so the provider splits on the right one.
    expect(atob(basicClientAuthorization("a:b", "c d+e%f").slice("Basic ".length))).toBe("a%3Ab:c+d%2Be%25f");
    expect(basicClientAuthorization("pramen-app", "s3cret")).toBe(`Basic ${btoa("pramen-app:s3cret")}`);
  });

  test("non-ASCII is UTF-8 percent-encoded, so the header stays ASCII", () => {
    const header = basicClientAuthorization("id", "žluťoučký");
    expect(atob(header.slice("Basic ".length))).toBe(`id:${encodeURIComponent("žluťoučký")}`);
    expect(decodeBasic(header)).toEqual({ id: "id", secret: "žluťoučký" });
  });
});

describe("tokenEndpointAuthMethodFor", () => {
  test("basic unless post is the only secret method listed", () => {
    expect(tokenEndpointAuthMethodFor(undefined)).toBe("client_secret_basic");
    expect(tokenEndpointAuthMethodFor(["client_secret_basic"])).toBe("client_secret_basic");
    expect(tokenEndpointAuthMethodFor(["client_secret_post", "client_secret_basic"])).toBe("client_secret_basic");
    expect(tokenEndpointAuthMethodFor(["client_secret_post"])).toBe("client_secret_post");
    expect(tokenEndpointAuthMethodFor(["client_secret_post", "private_key_jwt"])).toBe("client_secret_post");
    // Neither secret method: the spec default, and the provider's invalid_client names it.
    expect(tokenEndpointAuthMethodFor(["private_key_jwt"])).toBe("client_secret_basic");
    // A malformed document is read as silent, not as a reason to fail the sign-in.
    expect(tokenEndpointAuthMethodFor("client_secret_post")).toBe("client_secret_basic");
    expect(tokenEndpointAuthMethodFor({ 0: "client_secret_post" })).toBe("client_secret_basic");
  });
});

/** Run `fn` with console.error and console.warn captured; returns what each received. */
async function capture(fn: () => Promise<void>): Promise<{ errors: string[]; warnings: string[] }> {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await fn();
    return { errors: error.mock.calls.map((c) => String(c[0])), warnings: warn.mock.calls.map((c) => String(c[0])) };
  } finally {
    error.mockRestore();
    warn.mockRestore();
  }
}

describe("when the provider refuses the client", () => {
  // Discovery describes the PROVIDER. Auth0 and Better Auth list both methods and enforce the
  // one each client is registered with, so a client registered for post at such a provider
  // must still sign in, as it did before basic became the first choice.
  test("a client registered for post at a provider listing both signs in on the second try", async () => {
    const p = provider(["client_secret_basic", "client_secret_post"], registeredFor("client_secret_post")); active = p;
    const { warnings } = await capture(async () => { expect((await signIn(p)).status).toBe(302); });
    expect(p.seen).toHaveLength(2);
    expectBasic(p.seen[0]);
    expectPost(p.seen[1]);
    expect(warnings.join("\n")).toContain('refused client_secret_basic');
    expect(warnings.join("\n")).toContain('tokenEndpointAuthMethod: "client_secret_post"');
  });

  test("a client registered for basic at a post-only provider signs in on the second try", async () => {
    const p = provider(["client_secret_post"], registeredFor("client_secret_basic")); active = p;
    await capture(async () => { expect((await signIn(p)).status).toBe(302); });
    expect(p.seen).toHaveLength(2);
    expectPost(p.seen[0]);
    expectBasic(p.seen[1]);
  });

  // Kept module-wide per issuer + client id, so an app that builds `createOidcAuth` per request
  // (to read the secret from env, say) gets it too: each signIn here is a fresh instance.
  test("the method that worked is kept: the next sign-in sends no refused attempt and no warning", async () => {
    const p = provider(["client_secret_basic", "client_secret_post"], registeredFor("client_secret_post")); active = p;
    const { warnings } = await capture(async () => {
      expect((await signIn(p)).status).toBe(302);
      expect((await signIn(p)).status).toBe(302);
    });
    expect(p.seen).toHaveLength(3); // basic refused, post, post
    expectPost(p.seen[2]);
    expect(warnings).toHaveLength(1);
  });

  test("a remembered method that is refused later is replaced by the other one", async () => {
    let registered: TokenEndpointAuthMethod = "client_secret_post";
    const p = provider(["client_secret_basic", "client_secret_post"], (req) => registeredFor(registered)(req)); active = p;
    const { warnings } = await capture(async () => {
      expect((await signIn(p)).status).toBe(302); // basic refused, post remembered
      registered = "client_secret_basic";
      expect((await signIn(p)).status).toBe(302); // post refused, basic remembered
      expect((await signIn(p)).status).toBe(302);
    });
    expect(p.seen.map((r) => (r.authorization ? "basic" : "post"))).toEqual(["basic", "post", "post", "basic", "basic"]);
    expect(warnings).toHaveLength(2);
  });

  // Older Keycloak refuses a client with 401 `unauthorized_client`; some providers send only a
  // `WWW-Authenticate` challenge. Both are the provider saying the CLIENT was refused.
  test("a 401 that says why, or challenges, is a refused client too", async () => {
    const keycloak = provider(undefined, (req) => (req.authorization ? Response.json({ error: "unauthorized_client" }, { status: 401 }) : undefined)); active = keycloak;
    await capture(async () => { expect((await signIn(keycloak)).status).toBe(302); });
    expect(keycloak.seen).toHaveLength(2);
    keycloak.restore();

    const challenge = provider(undefined, (req) => (req.authorization ? new Response(null, { status: 401, headers: { "www-authenticate": 'Basic realm="token"' } }) : undefined)); active = challenge;
    await capture(async () => { expect((await signIn(challenge)).status).toBe(302); });
    expect(challenge.seen).toHaveLength(2);
  });

  // A gateway or rate limiter in front of the provider can answer 401 for its own reasons; only
  // the provider's `invalid_client` says the CLIENT was refused.
  test("a bare 401 without invalid_client gets no second try", async () => {
    const p = provider(undefined, () => new Response("Unauthorized", { status: 401 })); active = p;
    const { errors } = await capture(async () => { expect((await signIn(p)).status).toBe(502); });
    expect(p.seen).toHaveLength(1);
    expect(errors).toContain("pramen/auth: OIDC token exchange failed (client_secret_basic, HTTP 401)");
  });

  test("a pinned method gets no second try", async () => {
    const p = provider(["client_secret_basic", "client_secret_post"], registeredFor("client_secret_post")); active = p;
    const { errors } = await capture(async () => { expect((await signIn(p, { tokenEndpointAuthMethod: "client_secret_basic" })).status).toBe(502); });
    expect(p.seen).toHaveLength(1);
    expect(errors).toContain("pramen/auth: OIDC token exchange failed (client_secret_basic, HTTP 401, invalid_client: client registered for client_secret_post cannot use client_secret_basic)");
  });

  test("an error that is not about the client (a spent code) gets no second try", async () => {
    const p = provider(undefined, () => Response.json({ error: "invalid_grant", error_description: "code already used" }, { status: 400 })); active = p;
    const { errors } = await capture(async () => { expect((await signIn(p)).status).toBe(502); });
    expect(p.seen).toHaveLength(1);
    expect(errors).toContain("pramen/auth: OIDC token exchange failed (client_secret_basic, HTTP 400, invalid_grant: code already used)");
  });

  test("a public client gets no second try", async () => {
    const p = provider(undefined, () => Response.json({ error: "invalid_client" }, { status: 401 })); active = p;
    const { errors } = await capture(async () => { expect((await signIn(p, { clientSecret: undefined })).status).toBe(502); });
    expect(p.seen).toHaveLength(1);
    expect(errors).toContain("pramen/auth: OIDC token exchange failed (HTTP 401, invalid_client)");
  });

  test("when both are refused, the log carries both answers", async () => {
    const p = provider(["client_secret_post"], () => Response.json({ error: "invalid_client", error_description: "unknown client" }, { status: 401 })); active = p;
    const { errors } = await capture(async () => { expect((await signIn(p)).status).toBe(502); });
    expect(p.seen).toHaveLength(2);
    expect(errors).toContain("pramen/auth: OIDC token exchange failed (client_secret_basic, HTTP 401, invalid_client: unknown client; refused before it: client_secret_post, HTTP 401, invalid_client: unknown client)");
  });
});

describe("a refused exchange's log line", () => {
  test("carries the status alone when the body has neither error nor description", async () => {
    const p = provider(undefined, () => new Response("bad gateway", { status: 502 })); active = p;
    const { errors } = await capture(async () => { expect((await signIn(p)).status).toBe(502); });
    expect(errors).toContain("pramen/auth: OIDC token exchange failed (client_secret_basic, HTTP 502)");
  });

  test("cannot be split or reordered by provider text: control, separator and bidi characters are replaced", async () => {
    const forged = "bad\r\npramen/auth: forged\u0000\u2028line\u2029\u202Eend\u2066x";
    const p = provider(undefined, () => Response.json({ error: "invalid_grant", error_description: forged }, { status: 400 })); active = p;
    const { errors } = await capture(async () => { expect((await signIn(p)).status).toBe(502); });
    expect(errors).toContain("pramen/auth: OIDC token exchange failed (client_secret_basic, HTTP 400, invalid_grant: bad  pramen/auth: forged  line  end x)");
  });

  test("leaves joiners in legitimate text alone", async () => {
    const text = "می\u200Cخواهم 👩\u200D💻";
    const p = provider(undefined, () => Response.json({ error: "invalid_grant", error_description: text }, { status: 400 })); active = p;
    const { errors } = await capture(async () => { expect((await signIn(p)).status).toBe(502); });
    expect(errors).toContain(`pramen/auth: OIDC token exchange failed (client_secret_basic, HTTP 400, invalid_grant: ${text})`);
  });

  test("caps provider text at 300 code points, never splitting a surrogate pair", async () => {
    // 299 ASCII then an astral character straddling the 300th UTF-16 unit, then more.
    const long = `${"x".repeat(299)}😀${"y".repeat(50)}`;
    const p = provider(undefined, () => Response.json({ error: "invalid_grant", error_description: long }, { status: 400 })); active = p;
    const { errors } = await capture(async () => { expect((await signIn(p)).status).toBe(502); });
    const description = errors.find((e) => e.startsWith("pramen/auth: OIDC token exchange failed"))!.split("invalid_grant: ")[1]!.slice(0, -1);
    expect(description).toBe(`${"x".repeat(299)}😀`);
    expect(Array.from(description)).toHaveLength(300);
  });
});

describe("createOidcAuth options", () => {
  // Like a bad `sessionTtlSeconds`: a typo is never deliberate, and must not read as "unpinned".
  test("an unknown tokenEndpointAuthMethod throws at construction", () => {
    const base = { issuer: "https://idp.example.com", clientId: CLIENT_ID, clientSecret: SECRET, redirectUri: "https://app.example.com/cb", successRedirect: "https://app.example.com/" };
    expect(() => createOidcAuth({ ...base, tokenEndpointAuthMethod: "client_secret_basic " as TokenEndpointAuthMethod })).toThrow('tokenEndpointAuthMethod must be one of client_secret_basic, client_secret_post, got "client_secret_basic "');
    expect(() => createOidcAuth({ ...base, tokenEndpointAuthMethod: "client_secret_post" })).not.toThrow();
  });
});
