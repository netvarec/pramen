// ACL primitives — the portable definition layer, mirroring the prior runtime's
// packages/the definition layer ACL surface: role(), policy(), allow(), deny(),
// $identity(). Resolution semantics live in runtime/acl.ts.
//
// Model: an Identity carries one or more roles. A policy grants a (role) access
// to an (entity, action), optionally restricted by a row-level `where` predicate
// and/or a set of permitted `fields`. Access is deny-by-default; policies only
// ever grant. Across the identity's roles, grants OR-merge (any role can allow).

export type Action = "read" | "create" | "update" | "delete";

/** Runtime identity. Augment with your own properties (userId, tier, …). */
export interface Identity {
  role?: string;
  roles?: string[];
  [key: string]: unknown;
}

// --- $identity markers: reference an identity property inside a where rule ---

const IDENTITY_MARKER = Symbol.for("mrak.identityMarker");

export interface IdentityMarker {
  readonly [IDENTITY_MARKER]: true;
  readonly path: string;
}

/** Reference an identity property in a policy `where`, resolved per request. */
export function $identity(path: string): IdentityMarker {
  return { [IDENTITY_MARKER]: true, path };
}

export function isIdentityMarker(v: unknown): v is IdentityMarker {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[IDENTITY_MARKER] === true;
}

// --- allow / deny markers ---

export interface AllowMarker {
  readonly kind: "allow";
}
export interface DenyMarker {
  readonly kind: "deny";
}

export function allow(): AllowMarker {
  return { kind: "allow" };
}
export function deny(): DenyMarker {
  return { kind: "deny" };
}

// --- policy rules ---

/** A where rule: column -> value, where value may be a literal or an $identity marker. */
export type WhereRule = Record<string, unknown | IdentityMarker>;

export interface PolicyRules {
  /** Row-level predicate (AND of equalities). Omit/empty = all rows. */
  where?: WhereRule;
  /** Permitted fields. Omit = all fields. On read = projection; on write = settable columns. */
  fields?: string[];
}

export type PolicyRule = AllowMarker | DenyMarker | PolicyRules;

export interface Policy {
  readonly name: string;
  readonly entity: string;
  readonly action: Action;
  readonly rule: PolicyRule;
}

export function policy(name: string, entity: string, action: Action, rule: PolicyRule): Policy {
  return { name, entity, action, rule };
}

export interface Role {
  readonly name: string;
  readonly policies: Policy[];
}

export function role(name: string, policies: Policy[]): Role {
  return { name, policies };
}

export function isAllow(r: PolicyRule): r is AllowMarker {
  return (r as AllowMarker).kind === "allow";
}
export function isDeny(r: PolicyRule): r is DenyMarker {
  return (r as DenyMarker).kind === "deny";
}
