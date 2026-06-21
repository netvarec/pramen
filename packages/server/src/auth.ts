// Identity resolution at the edge. The Worker verifies a signed token and
// forwards a trusted identity to the DO; the DO never re-derives it, and the
// client-supplied X-Pramen-Identity header is stripped unless a token verified
// (see src/index.ts), so a validly-signed JWT is the only path to an identity.
//
// Verification is pluggable via VerifyStrategy: HmacStrategy (HS256, shared secret
// in env.AUTH_SECRET) for dev/symmetric setups, JwksStrategy (RS256 against a remote
// JWKS, with key caching) for real identity providers. The header parse, exp/nbf
// checks, and claim->Identity mapping are shared; only signature verification
// differs. Claims map to Identity: `sub` -> userId, `roles`/`role` -> roles, other
// non-standard claims pass through.

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

interface JwtHeader {
  alg?: string;
  kid?: string;
}

/** Verifies a JWT and returns its claims, or null if invalid. Implementations
 * differ only in how they verify the signature. */
export interface VerifyStrategy {
  verify(token: string): Promise<Record<string, unknown> | null>;
}

/** Verify a signature over `${header}.${payload}` for the parsed header. */
type SignatureVerifier = (signingInput: string, signature: Uint8Array, header: JwtHeader) => Promise<boolean>;

// Shared JWT pipeline: parse, verify the signature via the supplied function, then
// validate exp/nbf. Any malformed part or a verification throw -> null (reject).
async function verifyJwt(token: string, verifySignature: SignatureVerifier): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  let header: JwtHeader;
  try {
    header = JSON.parse(b64urlToString(h!));
  } catch {
    return null;
  }

  let valid: boolean;
  try {
    valid = await verifySignature(`${h}.${p}`, b64urlToBytes(sig!), header);
  } catch {
    return null;
  }
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

/** HS256 via a shared secret. The dev/default strategy. */
export class HmacStrategy implements VerifyStrategy {
  constructor(private readonly secret: string) {}

  verify(token: string): Promise<Record<string, unknown> | null> {
    return verifyJwt(token, async (input, signature, header) => {
      if (header.alg !== "HS256" || !this.secret) return false;
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(this.secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(input));
    });
  }
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

const SINGLE_KEY = "\0single";

/** RS256 verified against a remote JWKS. Public keys are fetched once and cached
 * (TTL); a token with an unknown `kid` triggers one forced refetch to pick up key
 * rotation. Stale keys are kept if a refetch fails. */
export class JwksStrategy implements VerifyStrategy {
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    readonly url: string,
    private readonly ttlMs = 600_000,
  ) {}

  verify(token: string): Promise<Record<string, unknown> | null> {
    return verifyJwt(token, async (input, signature, header) => {
      if (header.alg !== "RS256") return false;
      const key = await this.keyFor(header.kid);
      if (!key) return false;
      return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(input));
    });
  }

  private lookup(kid?: string): CryptoKey | null {
    if (kid) return this.keys.get(kid) ?? null;
    if (this.keys.size === 1) return [...this.keys.values()][0]!; // no kid + single key
    return this.keys.get(SINGLE_KEY) ?? null;
  }

  private async keyFor(kid?: string): Promise<CryptoKey | null> {
    await this.refresh(false);
    let key = this.lookup(kid);
    if (!key) {
      await this.refresh(true); // unknown kid -> force a refetch (key rotation)
      key = this.lookup(kid);
    }
    return key;
  }

  private async refresh(force: boolean): Promise<void> {
    if (!force && this.keys.size > 0 && Date.now() - this.fetchedAt < this.ttlMs) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchKeys();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async fetchKeys(): Promise<void> {
    try {
      const res = await fetch(this.url);
      if (!res.ok) return; // keep stale keys
      const body = (await res.json()) as { keys?: Jwk[] };
      const next = new Map<string, CryptoKey>();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== "RSA") continue;
        const key = await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        next.set(jwk.kid ?? SINGLE_KEY, key);
      }
      if (next.size > 0) {
        this.keys = next;
        this.fetchedAt = Date.now();
      }
    } catch {
      // network error -> keep whatever keys we have
    }
  }
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

export async function resolveIdentity(request: Request, strategy: VerifyStrategy): Promise<Identity | null> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const claims = await strategy.verify(token);
  return claims ? toIdentity(claims) : null;
}

/** May this identity address the given tenant? Gates `X-Pramen-Tenant` so a caller
 * can't reach (or register) arbitrary tenants. Default policy: admins → any
 * tenant; everyone else → only tenants listed in their `tenants` claim. Customize
 * for your tenancy model (e.g. tenant === identity.org, or a lookup). */
export function authorizeTenant(identity: Identity | null, tenant: string): boolean {
  // Anonymous (no verified token) may reach only the default tenant — enough for
  // first-class public flows (the `anonymous` ACL role still gates the data), while
  // not letting unauthenticated callers address/register arbitrary tenants.
  if (!identity) return tenant === "main";
  if (identity.roles?.includes("admin")) return true;
  const allowed = Array.isArray(identity.tenants) ? (identity.tenants as string[]) : [];
  return allowed.includes(tenant);
}

export function isAdmin(identity: Identity | null): boolean {
  return identity?.roles?.includes("admin") ?? false;
}
