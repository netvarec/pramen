// ACL primitives — the portable definition layer: role(), policy(), allow(),
// deny(), $identity(). Resolution semantics live in runtime/acl.ts.
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

const IDENTITY_MARKER = Symbol.for("pramen.identityMarker");

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

/** A per-row (cell-level) field grant: `fields` are permitted only for rows that
 * match `when`. Additive over the policy's flat `fields` — a conditional grant can
 * only ever ADD fields, never remove them. */
export interface ConditionalFields {
  fields: string[];
  /** Row-predicate, same surface as `where` (operators, AND/OR, $identity markers). */
  when: WhereRule;
}

/** Escape hatch for cell-level ACL: a late per-row resolver. Given the identity and
 * the fetched (or candidate, on write) row, returns the extra permitted fields —
 * additive over `fields`; `null` means all fields for that row. */
export type FieldsFn = (identity: Identity | null, row: Record<string, unknown>) => string[] | null;

/** Per-relation ACL inside a parent read policy. */
export interface RelationAclRule {
  /** Permit traversal to the related entity via this relation even if it has no
   * flat read grant (directAccess). */
  directAccess?: boolean;
  /** Extra row-level predicate applied when traversing. */
  where?: WhereRule;
  /** Restrict fields visible through the relation. */
  fields?: string[];
  /** Per-row field grants applied to traversed rows. Additive over `fields`. */
  conditionalFields?: ConditionalFields[];
  /** Late per-row field resolver for traversed rows. Additive over `fields`. */
  fieldsFn?: FieldsFn;
}

/** A forced column value on write: a literal, or computed from the identity. */
export type SetValue = unknown | ((identity: Identity | null) => unknown);

/** Server-side validation on write; throw to reject. Runs on the final values. */
export type Validator = (args: { identity: Identity | null; values: Record<string, unknown> }) => void;

export interface PolicyRules {
  /** Row-level predicate (AND of equalities). Omit/empty = all rows. */
  where?: WhereRule;
  /** Permitted fields. Omit = all fields. On read = projection; on write = settable columns. */
  fields?: string[];
  /** Cell-level (per-row) field grants applied only to rows matching `when`.
   * Additive over `fields`. On read = projection; on write = settable columns —
   * evaluated against the candidate (insert) or post-merge (update) row. */
  conditionalFields?: ConditionalFields[];
  /** Escape hatch: a late per-row field resolver. Additive over `fields`. */
  fieldsFn?: FieldsFn;
  /** Per-relation traversal rules (see RelationAclRule). */
  relations?: Record<string, RelationAclRule>;
  /** Columns forced to server-controlled values on write (override client input,
   * bypass field restriction). E.g. `{ ownerId: (i) => i?.userId }`. */
  set?: Record<string, SetValue>;
  /** Server-side validation; throw to reject. Sees the final (post-`set`) values. */
  validate?: Validator;
}

// --- dynamic resolvers: a policy whose rule is computed per request ---

/** Read surface given to a resolver — runs in SYSTEM mode (bypasses ACL), so a
 * resolver can consult the DB to decide access without recursing into itself. */
export interface ResolverDb {
  find(spec: {
    from: string;
    where?: Record<string, unknown>;
    orderBy?: { column: string; dir?: "asc" | "desc" };
    limit?: number;
  }): Promise<Array<Record<string, unknown>>>;
}

export interface ResolverContext {
  readonly identity: Identity | null;
  readonly db: ResolverDb;
}

export type ResolverFn = (ctx: ResolverContext) => PolicyRule | Promise<PolicyRule>;

export interface ResolverMarker {
  readonly kind: "resolver";
  readonly id: number;
  readonly fn: ResolverFn;
}

let resolverCounter = 0;
/** A policy rule evaluated once per request during warmup; returns allow/deny/rules. */
export function resolve(fn: ResolverFn): ResolverMarker {
  return { kind: "resolver", id: resolverCounter++, fn };
}

export type PolicyRule = AllowMarker | DenyMarker | PolicyRules | ResolverMarker;

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
export function isResolver(r: PolicyRule): r is ResolverMarker {
  return (r as ResolverMarker).kind === "resolver";
}
