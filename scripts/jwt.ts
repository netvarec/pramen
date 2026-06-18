// Mint HS256 JWTs for the smoke tests, signed with the dev secret in
// wrangler.jsonc. Mirrors what a real auth service would issue.

export const DEV_SECRET = "dev-secret-change-me";

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const strToB64url = (s: string) => bytesToB64url(new TextEncoder().encode(s));

export async function sign(payload: Record<string, unknown>, secret = DEV_SECRET): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = strToB64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = strToB64url(JSON.stringify({ iat: now, exp: now + 3600, ...payload }));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${bytesToB64url(new Uint8Array(sig))}`;
}

/** A signed token for the given subject and roles. */
export const token = (sub: string, roles: string[]) => sign({ sub, roles });
