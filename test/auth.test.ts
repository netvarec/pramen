// Unit test for the JWT verify strategies. HmacStrategy (HS256) is also exercised
// end-to-end by every e2e suite via env.AUTH_SECRET; here we cover RS256/JWKS —
// key fetch, caching, kid selection, rotation, and rejection — with a mocked JWKS
// endpoint, so no live identity provider is needed.

import { afterEach, describe, expect, test } from "bun:test";
import { HmacStrategy, JwksStrategy } from "../src/auth";
import { DEV_SECRET, sign } from "../scripts/jwt";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const strB64 = (s: string) => b64url(new TextEncoder().encode(s));

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;

async function signRs256(payload: Record<string, unknown>, key: CryptoKey, kid?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = strB64(JSON.stringify({ alg: "RS256", typ: "JWT", ...(kid ? { kid } : {}) }));
  const body = strB64(JSON.stringify({ iat: now, exp: now + 3600, ...payload }));
  const data = `${header}.${body}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

describe("HmacStrategy (HS256)", () => {
  const strat = new HmacStrategy(DEV_SECRET);

  test("accepts a valid token", async () => {
    const claims = await strat.verify(await sign({ sub: "alice", roles: ["author"] }));
    expect(claims?.sub).toBe("alice");
  });

  test("rejects a wrong-secret token", async () => {
    expect(await strat.verify(await sign({ sub: "alice" }, "wrong-secret"))).toBeNull();
  });

  test("rejects an expired token", async () => {
    expect(await strat.verify(await sign({ sub: "alice", exp: 1 }))).toBeNull();
  });
});

describe("JwksStrategy (RS256)", () => {
  let realFetch: typeof fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Generate an RSA keypair, serve its public key as a JWKS, and count fetches.
  async function setup(kid?: string) {
    const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const jwks = { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] };
    realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify(jwks), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { pair, fetches: () => fetches };
  }

  test("verifies a token signed by a JWKS key (with kid)", async () => {
    const { pair } = await setup("key-1");
    const strat = new JwksStrategy("https://issuer/.well-known/jwks.json");
    const claims = await strat.verify(await signRs256({ sub: "alice", roles: ["author"] }, pair.privateKey, "key-1"));
    expect(claims?.sub).toBe("alice");
  });

  test("caches public keys across verifies (single fetch)", async () => {
    const { pair, fetches } = await setup("key-1");
    const strat = new JwksStrategy("https://issuer/jwks");
    const tok = await signRs256({ sub: "alice" }, pair.privateKey, "key-1");
    await strat.verify(tok);
    await strat.verify(tok);
    expect(fetches()).toBe(1);
  });

  test("rejects a token signed by a different key", async () => {
    const { pair } = await setup("key-1");
    const strat = new JwksStrategy("https://issuer/jwks");
    const other = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
    const forged = await signRs256({ sub: "mallory" }, other.privateKey, "key-1");
    expect(await strat.verify(forged)).toBeNull();
  });

  test("rejects an unknown kid after one forced refetch (rotation handling)", async () => {
    const { pair, fetches } = await setup("key-1");
    const strat = new JwksStrategy("https://issuer/jwks");
    const tok = await signRs256({ sub: "alice" }, pair.privateKey, "key-999");
    expect(await strat.verify(tok)).toBeNull();
    expect(fetches()).toBe(2); // initial fetch + forced refetch on the kid miss
  });

  test("rejects an HS256 token (algorithm mismatch)", async () => {
    await setup("key-1");
    const strat = new JwksStrategy("https://issuer/jwks");
    expect(await strat.verify(await sign({ sub: "alice" }))).toBeNull();
  });
});
