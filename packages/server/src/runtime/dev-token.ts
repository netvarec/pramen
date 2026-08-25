// Mint an HS256 JWT for local development and tooling — what a real auth service would
// issue, without running one.
//
// Extracted because it was already written twice (the `pramen` CLI and the repo's test
// helper) and `@pramen/cms`'s own bin would have been a third. One implementation, in the
// package that owns tokens.
//
// NOT an auth system: the dev fallback secret is public, so a token signed with it is
// worthless anywhere `AUTH_SECRET` is set to something real. That is the point — it makes
// a forgotten secret fail loudly rather than quietly accept dev tokens in production.

/** The scaffolded oblaka.ts dev secret. Used only when AUTH_SECRET is unset. */
export const DEV_SECRET = "dev-secret-change-me";

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const strToB64url = (s: string): string => bytesToB64url(new TextEncoder().encode(s));

/** Sign a dev JWT (1h). Secret: the `secret` argument, else `AUTH_SECRET`, else DEV_SECRET. */
export async function signDevToken(payload: Record<string, unknown>, secret?: string): Promise<string> {
  const key = secret ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.AUTH_SECRET ?? DEV_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const header = strToB64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = strToB64url(JSON.stringify({ iat: now, exp: now + 3600, ...payload }));
  const data = `${header}.${body}`;
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return `${data}.${bytesToB64url(new Uint8Array(sig))}`;
}
