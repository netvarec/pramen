// Signed, self-expiring capability tokens (HMAC-SHA256 over a JSON payload).
//
// pramen already owns the edge and a secret, so a capability url needs no session and no
// store: the payload IS the grant, and the signature is what makes it unforgeable. Signed
// file urls were the first user (`runtime/storage.ts`); page preview links are the second
// (`@pramen/cms`). Both mint in a handler and redeem in the Worker, unauthenticated.
//
// Pure WebCrypto — synchronous in the sense that matters (no stream I/O), so it is safe to
// call from inside the DO's storage.transaction().
//
// A token is `<b64url(json)>.<b64url(sig)>`. It is deliberately NOT a JWT: no alg field to
// confuse, no header to downgrade, one algorithm, verified before the payload is parsed.

/** Every signed token carries an expiry (epoch seconds); `verifyToken` enforces it. */
export interface ExpiringToken {
  exp: number;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const strToB64url = (s: string): string => bytesToB64url(new TextEncoder().encode(s));
export const b64urlToStr = (s: string): string => new TextDecoder().decode(b64urlToBytes(s));

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Sign a payload into a capability token. */
export async function signToken<T extends ExpiringToken>(payload: T, secret: string): Promise<string> {
  const data = strToB64url(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${bytesToB64url(new Uint8Array(sig))}`;
}

/** Verify a token's signature and expiry; returns the payload, or `null` for anything
 * malformed, forged, or expired. The caller decides what the payload authorizes — this
 * only attests that we minted it and that it is still in date. */
export async function verifyToken<T extends ExpiringToken>(raw: string, secret: string): Promise<T | null> {
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const data = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  let ok: boolean;
  try {
    const key = await hmacKey(secret);
    ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig), new TextEncoder().encode(data));
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload: T;
  try {
    payload = JSON.parse(b64urlToStr(data)) as T;
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || Math.floor(Date.now() / 1000) >= payload.exp) return null;
  return payload;
}

/** A signing secret must be present and non-trivial, else tokens are forgeable (an HMAC
 * over an empty or weak key). Below this length the feature is treated as UNCONFIGURED and
 * fails closed, rather than minting urls that anyone can forge. */
export const MIN_TOKEN_SECRET_LEN = 16;

export function isUsableSecret(secret: unknown): secret is string {
  return typeof secret === "string" && secret.length >= MIN_TOKEN_SECRET_LEN;
}

/** Resolve a signing secret from env by preference order, skipping any that is absent or
 * too weak. Returns `undefined` when nothing usable is configured — callers fail closed. */
export function resolveSecret(env: Readonly<Record<string, unknown>>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const v = env[name];
    if (isUsableSecret(v)) return v;
  }
  return undefined;
}
