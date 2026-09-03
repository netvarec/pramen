// ACL primitives — the portable definition layer: role(), policy(), allow(),
// deny(), $identity(), $now(). Resolution semantics live in runtime/acl.ts.
//
// Model: an Identity carries one or more roles. A policy grants a (role) access
// to an (entity, action), optionally restricted by a row-level `where` predicate
// and/or a set of permitted `fields`. Access is deny-by-default; policies only
// ever grant. Across the identity's roles, grants OR-merge (any role can allow).

import type { CellValue, JsonValue, Row } from "./infer";

export type Action = "read" | "create" | "update" | "delete";

/** Runtime identity. Augment with your own properties (userId, tier, …). */
export interface Identity {
  role?: string;
  roles?: string[];
  /** The verified token's `exp` (epoch seconds), when present. Carried so a long-lived
   * WebSocket — whose identity is fixed at upgrade and never re-verified — can enforce
   * expiry per message (see durable-object.ts). Absent for non-expiring / synthetic
   * (callPrivileged) identities, which are therefore never treated as expired. */
  exp?: number;
  [key: string]: JsonValue | undefined;
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

export function isIdentityMarker(v: WhereValue): v is IdentityMarker {
  return typeof v === "object" && v !== null && (v as Partial<IdentityMarker>)[IDENTITY_MARKER] === true;
}

// --- $input markers: reference a request-input field inside a where rule, for a
// capability / by-unguessable-key grant (possessing the value IS the authorization).

const INPUT_MARKER = Symbol.for("pramen.inputMarker");

export interface InputMarker {
  readonly [INPUT_MARKER]: true;
  readonly path: string;
}

/** Reference a request-input field in a policy `where`, resolved per request. The
 * grant matches only the row(s) whose column equals the supplied value — so a
 * caller can read a row only by presenting its unguessable key, without being able
 * to enumerate. An absent input value makes the rule match nothing (safe deny). */
export function $input(path: string): InputMarker {
  return { [INPUT_MARKER]: true, path };
}

export function isInputMarker(v: WhereValue): v is InputMarker {
  return typeof v === "object" && v !== null && (v as Partial<InputMarker>)[INPUT_MARKER] === true;
}

// --- $now markers: the request's evaluation instant inside a where rule, for a
// time-boxed grant (scheduled publication, an expiring share link).

const NOW_MARKER = Symbol.for("pramen.nowMarker");

export interface NowMarker {
  readonly [NOW_MARKER]: true;
}

/** The current UTC instant in a policy `where`, resolved per request, as an ISO-8601
 * string with a `Z` suffix — exactly what `new Date().toISOString()` produces.
 *
 * This is what makes a time boundary an ACL predicate rather than a filter every
 * handler has to remember: `{ publishedAt: { lte: $now() } }` hides a row scheduled
 * for the future from every caller the policy governs, not merely from the queries
 * that thought to ask. `{ publishedAt: { isNull: false } }` cannot express it — a
 * future timestamp is non-null, so a scheduled row would be readable the moment it
 * is saved.
 *
 * Comparison is lexicographic TEXT, which is exact WITHIN one format and wrong across two.
 * Both `'YYYY-MM-DD HH:MM:SS'` and the ISO form open with the same date, so values on
 * different dates still order correctly — it is the SAME date that breaks, where index 10
 * decides and a space (0x20) always sorts below `T` (0x54). A space-form value dated today
 * therefore compares as less than this marker whatever its time-of-day, so a row scheduled
 * for later today reads as already past. The column must hold ISO-8601 UTC —
 * `new Date().toISOString()`.
 *
 * `expr.now()` produces exactly that, so a column defaulted with it is directly comparable
 * here. It did NOT always: it emitted the `datetime('now')` space form, and a policy over
 * such a column was a time boundary that silently did not hold. A store written by a build
 * from before that change still holds space-form values until
 * `isoTimestampBackfill()` rewrites them. */
export function $now(): NowMarker {
  return { [NOW_MARKER]: true };
}

export function isNowMarker(v: WhereValue): v is NowMarker {
  return typeof v === "object" && v !== null && (v as Partial<NowMarker>)[NOW_MARKER] === true;
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

/** A value inside a `where` rule: a literal cell value, a per-request marker, an
 * operator object (`{ gte: 5 }`), a nested relation predicate, or an AND/OR group. */
export type WhereValue =
  | CellValue
  | IdentityMarker
  | InputMarker
  | NowMarker
  | WhereRule
  | WhereValue[];

/** A where rule: column (or `AND`/`OR`/`NOT`) -> value. An interface so it can recur
 * through `WhereValue` for nested relation predicates and boolean groups. */
export interface WhereRule {
  [key: string]: WhereValue;
}

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
export type FieldsFn = (identity: Identity | null, row: Row) => string[] | null;

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
export type SetValue = CellValue | ((identity: Identity | null) => CellValue);

/** Server-side validation on write; throw to reject. Runs on the final values. */
export type Validator = (args: { identity: Identity | null; values: Row }) => void;

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
    where?: WhereRule;
    orderBy?: { column: string; dir?: "asc" | "desc" };
    limit?: number;
  }): Promise<Row[]>;
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
