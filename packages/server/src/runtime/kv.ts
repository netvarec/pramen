// Kv: a thin, prefixed wrapper over the project's Workers KV namespace, handed
// to handlers as ctx.kv.
//
// Two levels of namespacing keep things isolated:
//  - Across projects: each project declares its own KV namespace in oblaka.ts
//    (named per project), so projects in one account never share a namespace.
//  - Within the namespace: keys are prefixed (`app:` for handler data) so they
//    never collide with pramen-internal keys (the tenant registry uses `tenant:`).
//
// ctx.kv is GLOBAL across all tenants of the project, so use it for config, feature
// flags, and caches, NOT per-tenant data (that's ctx.db). KV is eventually
// consistent and is NOT part of a mutation's transaction.

export class Kv {
  constructor(
    private readonly ns: KVNamespace,
    private readonly prefix = "app:",
  ) {}

  private full(key: string): string {
    return this.prefix + key;
  }

  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown>;
  get(key: string, type?: "json"): Promise<string | null | unknown> {
    return type === "json" ? this.ns.get(this.full(key), "json") : this.ns.get(this.full(key), "text");
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }): Promise<void> {
    await this.ns.put(this.full(key), value, opts);
  }

  async delete(key: string): Promise<void> {
    await this.ns.delete(this.full(key));
  }

  /** List keys under an (app-relative) prefix; returned names have the internal
   * prefix stripped. cursor is null when the listing is complete. */
  async list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: string[]; cursor: string | null }> {
    const res = await this.ns.list({ prefix: this.full(opts?.prefix ?? ""), limit: opts?.limit, cursor: opts?.cursor });
    return {
      keys: res.keys.map((k) => k.name.slice(this.prefix.length)),
      cursor: res.list_complete ? null : ((res as { cursor?: string }).cursor ?? null),
    };
  }
}

// --- session denylist (hard token revocation) -------------------------------
//
// The core is stateless verify-only: roles/active are baked into a token at login and
// there is no per-request DB lookup. To revoke a token BEFORE its `exp` (deactivate /
// delete / compromise), we keep a tiny KV denylist keyed by username (= the JWT `sub`).
// The Worker checks it right after resolving identity: a denied `sub` fails closed
// (401), never silently downgrades to anonymous.
//
// The entry carries an `expirationTtl` equal to the session TTL, so it self-expires
// exactly when the last token that could have been outstanding at revocation time does:
// the list can only ever hold recently-revoked users and never grows unbounded. The key
// is username-scoped (not per-token), so it blocks EVERY token for that user, including
// a fresh login, which is why reactivation must lift it (see `allowSession`).

/** App-relative key (the `Kv` facade adds its own `app:` prefix). Writer (auth) and
 * reader (Worker) both route through these helpers so the namespacing always agrees. */
const denyKey = (username: string): string => `authDenied:${username}`;

/** Cloudflare KV rejects an `expirationTtl` below 60s, so clamp it so a short session TTL
 * still produces a valid (if slightly over-long) denylist entry. */
const MIN_KV_TTL_SECONDS = 60;

/** Revoke every outstanding token for `username` for up to `ttlSeconds` (the session
 * TTL). Called when an account is deactivated / deleted. The entry self-expires, so the
 * denylist never accumulates beyond the current revocation window. */
export async function denySession(kv: Kv, username: string, ttlSeconds: number): Promise<void> {
  const ttl = Math.max(MIN_KV_TTL_SECONDS, Math.trunc(ttlSeconds) || MIN_KV_TTL_SECONDS);
  await kv.put(denyKey(username), "1", { expirationTtl: ttl });
}

/** Lift a prior `denySession` (e.g. on reactivation). The key is username-scoped, so
 * without this a reactivated account would stay locked out, even for a fresh login,
 * until the denylist entry expired on its own. */
export async function allowSession(kv: Kv, username: string): Promise<void> {
  await kv.delete(denyKey(username));
}

/** Is there a live denylist entry for `username`? The Worker consults this per
 * authenticated request (only when a `sub` is present) to fail a revoked token closed. */
export async function isSessionDenied(kv: Kv, username: string): Promise<boolean> {
  return (await kv.get(denyKey(username))) != null;
}

// --- session not-before (revoke every token issued BEFORE an instant) ---------
//
// The denylist above blocks every token for a user, a fresh login included, which fits
// deactivation and deletion. A password reset (or "sign out everywhere") wants the
// narrower cut: tokens minted before the event die, a token minted after it keeps
// working. That is a per-user `notBefore` instant compared against the token's `iat`.
// Same shape as the denylist: one username-scoped key, self-expiring at the session TTL
// (by then every token issued before the instant has expired on its own).

const notBeforeKey = (username: string): string => `authNotBefore:${username}`;

/** Revoke every token for `username` whose `iat` is below `atSeconds` (epoch seconds),
 * for up to `ttlSeconds` (the session TTL). A later call moves the instant. */
export async function setSessionNotBefore(kv: Kv, username: string, atSeconds: number, ttlSeconds: number): Promise<void> {
  const ttl = Math.max(MIN_KV_TTL_SECONDS, Math.trunc(ttlSeconds) || MIN_KV_TTL_SECONDS);
  await kv.put(notBeforeKey(username), String(Math.trunc(atSeconds)), { expirationTtl: ttl });
}

/** Was a token with this `iat` issued before `username`'s not-before instant? A token
 * with no numeric `iat` cannot prove it is newer, so while an instant is set it counts as
 * issued before (fail closed). No instant set: false. Same-second is NOT before, so the
 * token minted right after a reset survives. */
export async function isIssuedBeforeNotBefore(kv: Kv, username: string, iat: unknown): Promise<boolean> {
  const raw = await kv.get(notBeforeKey(username));
  if (raw == null) return false;
  const notBefore = Number(raw);
  if (!Number.isFinite(notBefore)) return false;
  return typeof iat !== "number" || iat < notBefore;
}

/** Is this verified identity revoked, by the denylist or by a not-before instant newer
 * than its `iat`? Shared by the Worker (per request, the WS upgrade included) and the DO
 * (per socket frame and before each push), so the two cannot disagree on what "revoked"
 * means. An identity with no string `userId` (anonymous, a synthetic callPrivileged one)
 * is never revoked. */
export async function isIdentityRevoked(kv: Kv, identity: { userId?: unknown; iat?: unknown } | null): Promise<boolean> {
  const sub = typeof identity?.userId === "string" ? identity.userId : undefined;
  if (!sub) return false;
  const [denied, stale] = await Promise.all([isSessionDenied(kv, sub), isIssuedBeforeNotBefore(kv, sub, identity?.iat)]);
  return denied || stale;
}
