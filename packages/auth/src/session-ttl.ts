// How long a session minted by this package lives, resolved in ONE place.
//
// Every minter (signup/login/refreshSession, the magic link, OIDC, changePassword) and every
// revocation write (the KV denylist, the notBefore entry) reads it from here. They used to
// disagree: the denylist was sized from AUTH_SESSION_TTL_SECONDS while the magic-link and OIDC
// factories minted with their own `sessionTtlSeconds` (default 3600) and never read the env.
// Shorten the env var, the documented way to tighten revocation, and a deactivated user's
// denylist entry expired while their magic-link token was still valid.
//
// So a factory's explicit option still wins for the tokens IT mints, the env var is the
// default for every other minter, and a revocation entry lives as long as the LONGEST of all
// of them: the env value and every option a factory in this isolate declared.

import type { EnvBag } from "@pramen/server";

export const DEFAULT_SESSION_TTL_SECONDS = 3600;

/** The largest `sessionTtlSeconds` any factory was constructed with. Factories are built at
 * module scope, before any request, so by the time a revocation runs every one of them has
 * declared its TTL here. It only grows: a revocation entry may outlive a token, never the
 * other way round. */
let longestDeclared = 0;

const positive = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
};

/** Validate a factory's `sessionTtlSeconds` and record it for {@link maxSessionTtlOf}. */
export function declareSessionTtl(seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined;
  const ttl = positive(seconds);
  if (ttl === undefined) throw new Error(`@pramen/auth: sessionTtlSeconds must be a positive number, got ${JSON.stringify(seconds)}`);
  longestDeclared = Math.max(longestDeclared, ttl);
  return ttl;
}

/** The TTL to mint with: the factory's own option when it has one, else
 * AUTH_SESSION_TTL_SECONDS, else 1h. */
export function sessionTtlOf(env: EnvBag, configured?: number): number {
  return configured ?? positive(env.AUTH_SESSION_TTL_SECONDS) ?? DEFAULT_SESSION_TTL_SECONDS;
}

/** The longest a session minted by ANY factory can still be valid: what a revocation entry
 * (denylist, notBefore) must outlive so it never lapses under a live token. */
export function maxSessionTtlOf(env: EnvBag): number {
  return Math.max(sessionTtlOf(env), longestDeclared);
}
