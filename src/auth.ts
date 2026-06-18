// Identity resolution at the edge. The Worker verifies a signed token and
// forwards a trusted identity to the DO; the DO never re-derives it, and the
// client-supplied X-Mrak-Identity header is stripped unless a token verified
// (see src/index.ts), so a validly-signed JWT is the only path to an identity.
//
// v0 verifies HS256 (shared secret in env.AUTH_SECRET) with WebCrypto. Swapping
// to RS256/EdDSA (asymmetric, JWKS) is a localized change to verifyJwt — the
// rest of the system is unchanged. Claims map to Identity: `sub` -> userId,
// `roles`/`role` -> roles, other non-standard claims pass through.

import type { Identity } from "./sdk/acl";

const STANDARD_CLAIMS = new Set(["exp", "iat", "nbf", "iss", "aud", "jti", "sub", "role", "roles", "userId"]);

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  let header: { alg?: string };
  try {
    header = JSON.parse(b64urlToString(h!));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig!), new TextEncoder().encode(`${h}.${p}`));
  if (!valid) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlToString(p!));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now >= payload.exp) return null;
  if (typeof payload.nbf === "number" && now < payload.nbf) return null;
  return payload;
}

function toIdentity(claims: Record<string, unknown>): Identity {
  const roles = Array.isArray(claims.roles)
    ? (claims.roles as string[])
    : typeof claims.role === "string"
      ? [claims.role]
      : [];
  const identity: Identity = { roles, userId: (claims.sub ?? claims.userId) as string | undefined };
  for (const [k, v] of Object.entries(claims)) {
    if (!STANDARD_CLAIMS.has(k)) identity[k] = v; // carry custom claims (tier, …)
  }
  return identity;
}

export async function resolveIdentity(request: Request, secret: string): Promise<Identity | null> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || !secret) return null;
  const claims = await verifyJwt(token, secret);
  return claims ? toIdentity(claims) : null;
}

/** May this identity address the given tenant? Gates `X-Mrak-Tenant` so a caller
 * can't reach (or register) arbitrary tenants. Default policy: admins → any
 * tenant; everyone else → only tenants listed in their `tenants` claim. Customize
 * for your tenancy model (e.g. tenant === identity.org, or a lookup). */
export function authorizeTenant(identity: Identity | null, tenant: string): boolean {
  if (!identity) return false;
  if (identity.roles?.includes("admin")) return true;
  const allowed = Array.isArray(identity.tenants) ? (identity.tenants as string[]) : [];
  return allowed.includes(tenant);
}

export function isAdmin(identity: Identity | null): boolean {
  return identity?.roles?.includes("admin") ?? false;
}
