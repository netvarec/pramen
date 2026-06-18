// Identity resolution at the edge. The Worker authenticates the request and
// forwards a trusted identity to the DO; the DO never re-derives it.
//
// v0 uses a demo bearer-token table. A real deployment verifies a signed token
// (JWT/session) here and maps its claims to an Identity — the rest of the system
// is unchanged. The X-Mrak-Identity escape hatch lets tests assert arbitrary
// identities; drop that branch (and trust only verified tokens) in production.

import type { Identity } from "./sdk/acl";

const DEMO_TOKENS: Record<string, Identity> = {
  admin: { roles: ["admin"], userId: "admin" },
  alice: { roles: ["author"], userId: "alice" },
  bob: { roles: ["author"], userId: "bob" },
  reader: { roles: ["reader"], userId: "anon" },
};

export function resolveIdentity(request: Request): Identity | null {
  // Test convenience: explicit identity JSON.
  const explicit = request.headers.get("x-mrak-identity");
  if (explicit) {
    try {
      return JSON.parse(explicit) as Identity;
    } catch {
      return null;
    }
  }

  const auth = request.headers.get("authorization");
  const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1];
  return token ? (DEMO_TOKENS[token] ?? null) : null;
}
