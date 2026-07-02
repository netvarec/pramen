// ACL resolution — the runtime counterpart of sdk/acl.ts.
// Given an identity + (entity, action), resolves a Scope: whether access is
// granted, the row-level predicate to merge into the query, and any field
// restriction. Deny-by-default; grants OR-merge across the identity's roles.

import {
  type Action,
  type AllowMarker,
  type DenyMarker,
  type FieldsFn,
  type Identity,
  type PolicyRule,
  type PolicyRules,
  type RelationAclRule,
  type ResolverDb,
  type Role,
  type Validator,
  deny,
  isAllow,
  isDeny,
  isIdentityMarker,
  isInputMarker,
  isResolver,
} from "../sdk/acl";
import { and, compileWhere, evalExpr, FALSE, or, TRUE, type SqlExpr } from "./read-engine";
import { BadRequest, PramenError } from "./errors";
import type { FieldDef, RelationDef, SchemaDef } from "../sdk/schema";

export class AclDenied extends PramenError {
  constructor(
    readonly entity: string,
    readonly action: Action,
    readonly field?: string,
  ) {
    super(
      field ? `access denied: ${entity}.${field} (${action})` : `access denied: ${action} ${entity}`,
      403,
      "forbidden",
    );
    this.name = "AclDenied";
  }
}

export interface CompiledAcl {
  /** roleName -> entity\0action -> rules that grant it. */
  readonly byRole: Map<string, Map<string, PolicyRule[]>>;
}

/** Per-request ACL context: the compiled policies plus the caller's identity. */
export interface AclContext {
  readonly acl: CompiledAcl;
  readonly identity: Identity | null;
  /** The request input (handler args), so policy `where` rules can reference an
   * `$input(...)` marker — a capability / by-unguessable-key read grant. */
  readonly input?: unknown;
  /** Resolver results for this request (resolverId -> rule), from warmup(). */
  readonly resolved?: Map<number, PolicyRule>;
  /** SYSTEM mode bypasses all ACL — used for warmup reads and internal ops. */
  readonly system?: boolean;
  /** The app schema — lets `where` rules traverse relations (`{ rel: { col } }`),
   * compiled to a subquery with the related entity's read scope AND-merged in. */
  readonly schema?: SchemaDef;
  /** The partition this DO serves. When set, Db rejects any access to a table that
   * lives in a different partition (a partition-DO only owns its own tables). Unset
   * (e.g. the D1/Worker shared-store path) disables the guard — a no-op. */
  readonly partition?: string;
  /** Suppress declarative write-triggers for this Db. Set on the privileged context
   * that DRAINS tasks, so a task handler's writes don't re-fire triggers (which would
   * cascade — a trigger → task → write → trigger loop). Triggers fire on request-path
   * writes, not on task-handler writes. */
  readonly suppressTriggers?: boolean;
}

/** Evaluate every resolver reachable by the identity's roles, once per request.
 * Resolvers read through a SYSTEM-mode db (ACL bypassed) to avoid recursion. */
export async function warmup(
  acl: CompiledAcl,
  identity: Identity | null,
  db: ResolverDb,
): Promise<Map<number, PolicyRule>> {
  const out = new Map<number, PolicyRule>();
  for (const roleName of rolesOf(identity)) {
    const byKey = acl.byRole.get(roleName);
    if (!byKey) continue;
    for (const rules of byKey.values()) {
      for (const rule of rules) {
        if (!isResolver(rule) || out.has(rule.id)) continue;
        try {
          out.set(rule.id, await rule.fn({ identity, db }));
        } catch {
          out.set(rule.id, deny()); // a throwing resolver denies
        }
      }
    }
  }
  return out;
}

const key = (entity: string, action: Action) => `${entity}\0${action}`;

export function compileAcl(roles: Role[]): CompiledAcl {
  const byRole = new Map<string, Map<string, PolicyRule[]>>();
  for (const r of roles) {
    const byKey = byRole.get(r.name) ?? new Map<string, PolicyRule[]>();
    for (const p of r.policies) {
      const k = key(p.entity, p.action);
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(p.rule);
    }
    byRole.set(r.name, byKey);
  }
  return { byRole };
}

/** A per-row additive field grant: `fields` apply to rows where `when` holds. */
export interface ConditionalGrant {
  readonly when: SqlExpr;
  readonly fields: string[];
}

export interface Scope {
  readonly allowed: boolean;
  /** Row-level predicate to AND into the query. null = unrestricted. */
  readonly where: SqlExpr | null;
  /** Statically-granted base fields. null = all fields (no per-row narrowing). */
  readonly fields: string[] | null;
  /** Cell-level grants evaluated per row; additive over `fields`. */
  readonly conditional: ConditionalGrant[];
  /** Cell-level function resolvers evaluated per row; additive over `fields`. */
  readonly fieldsFns: FieldsFn[];
}

export const ALLOW_ALL: Scope = { allowed: true, where: null, fields: null, conditional: [], fieldsFns: [] };
const DENIED: Scope = { allowed: false, where: null, fields: null, conditional: [], fieldsFns: [] };

/** A single grant collected during resolution, before OR-merge. */
interface Grant {
  where: SqlExpr | null;
  fields: string[] | null;
  conditional: ConditionalGrant[];
  fieldsFns: FieldsFn[];
}

/** Build a grant from a policy/relation rule, resolving markers in `where` and each
 * conditional `when` (the `when` predicate is single-table — evaluated in memory). */
function grantOf(rule: PolicyRules | RelationAclRule, where: SqlExpr | null, entity: string, ctx: AclContext, depth: number): Grant {
  return {
    where,
    fields: rule.fields ?? null,
    conditional: (rule.conditionalFields ?? []).map((cf) => ({
      // Cell-level `when` is evaluated per-row in memory (evalExpr), so it must stay
      // single-table — `allowRelations: false` rejects a relation key up front.
      when: compileScopedWhere(cf.when as Record<string, unknown>, entity, ctx, depth, false),
      fields: cf.fields,
    })),
    fieldsFns: rule.fieldsFn ? [rule.fieldsFn] : [],
  };
}

/** The roles to evaluate for a caller. An unauthenticated caller (no verified
 * token) is treated as the `anonymous` role, so an app can grant first-class
 * public reads/writes; if no `anonymous` role is defined this matches nothing
 * (still deny-by-default). */
function rolesOf(identity: Identity | null): string[] {
  if (!identity) return ["anonymous"];
  if (identity.roles?.length) return identity.roles;
  return identity.role ? [identity.role] : ["anonymous"];
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, seg) => (acc == null ? undefined : (acc as Record<string, unknown>)[seg]), obj ?? undefined);
}

const UNRESOLVED = Symbol("unresolved");

// Resolve a value that may be an $identity marker (against the caller) or an
// $input marker (against the request input — a capability/by-key grant). An
// unresolvable marker yields UNRESOLVED, which makes its rule match nothing.
function resolveValue(v: unknown, identity: Identity | null, input: unknown): unknown {
  if (isIdentityMarker(v)) {
    const value = getPath(identity, v.path);
    return value === undefined ? UNRESOLVED : value;
  }
  if (isInputMarker(v)) {
    const value = getPath(input, v.path);
    return value === undefined ? UNRESOLVED : value;
  }
  return v;
}

// Resolve every $identity/$input marker in a SINGLE level of a where-rule (bare
// values, operator objects, in/notIn arrays). AND/OR groups are split off by
// `compileScopedWhere` before this runs, so this only ever sees plain columns.
// Returns a plain WhereInput, or null if any marker is unresolvable — in which
// case this branch matches nothing (FALSE). Note: because branches are resolved
// independently, an unresolvable marker nullifies only its own branch, not the
// whole rule — so `OR: [{ x: $identity(...) }, { public: true }]` still matches
// the `public` branch for a caller whose marker can't resolve. (See the comment
// on `compileScopedWhere`.)
function resolveMarkers(rule: Record<string, unknown>, identity: Identity | null, input: unknown): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(rule)) {
    const isMarker = isIdentityMarker(v) || isInputMarker(v);
    if (v !== null && typeof v === "object" && !isMarker && !Array.isArray(v)) {
      const ops: Record<string, unknown> = {};
      for (const [op, val] of Object.entries(v as Record<string, unknown>)) {
        if (op === "in" || op === "notIn") {
          let arr: unknown;
          if (isIdentityMarker(val) || isInputMarker(val)) {
            arr = resolveValue(val, identity, input);
            if (arr === UNRESOLVED) return null;
          } else {
            const mapped = (val as unknown[]).map((x) => resolveValue(x, identity, input));
            if (mapped.some((x) => x === UNRESOLVED)) return null;
            arr = mapped;
          }
          if (!Array.isArray(arr)) return null; // marker must resolve to a list
          ops[op] = arr;
        } else {
          const rv = resolveValue(val, identity, input);
          if (rv === UNRESOLVED) return null;
          ops[op] = rv;
        }
      }
      out[key] = ops;
    } else {
      const rv = resolveValue(v, identity, input);
      if (rv === UNRESOLVED) return null;
      // A bare-value marker must only ever produce an EQUALITY comparison. If it
      // resolves to a caller-controlled non-primitive (object/array), compileWhere
      // would read it as an operator predicate (`{"gte":""}` → full-table
      // enumeration), defeating the intended equality. Treat that as unresolvable so
      // the branch matches nothing (the safe-deny path). Primitives resolve as today.
      if (isMarker && rv !== null && typeof rv === "object") return null;
      out[key] = rv;
    }
  }
  return out;
}

/** Max relation-traversal nesting depth in a `where` (guards cyclic relations).
 * Kept in lockstep with the `WhereClause` type's depth bound in sdk/infer.ts — if
 * you change one, change the other. */
export const MAX_REL_DEPTH = 5;

/** Primary-key column of an entity (the column a belongsTo points at / a hasMany
 * joins back to). Defaults to `id`. */
function pkOf(schema: SchemaDef | undefined, entity: string): string {
  const fields = schema?.[entity]?.fields;
  if (fields) for (const [n, f] of Object.entries(fields)) if ((f as FieldDef).primaryKey) return n;
  return "id";
}

/** Reject a relation `where` that filters the target on a column it can't read —
 * anywhere in the clause, including inside nested AND/OR groups (else a hidden/
 * unreadable column is LIKE-oracle'able through the subquery). Nested relation keys
 * are skipped: they're re-scoped against THEIR own target's read scope downstream.
 * Mirrors Db.assertReadableWhere's recursion for the top-level user `where`. */
function assertReadableRelationWhere(where: Record<string, unknown>, target: string, fields: string[], ctx: AclContext): void {
  const targetRels = (ctx.schema?.[target]?.relations ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(where)) {
    if (k === "AND" || k === "OR") {
      for (const g of v as Record<string, unknown>[]) assertReadableRelationWhere(g, target, fields, ctx);
    } else if (targetRels[k]) {
      continue;
    } else if (!fields.includes(k)) {
      throw new AclDenied(target, "read", k);
    }
  }
}

/** Compile a relation predicate `{ rel: { … } }` to a subquery, AND-merging the
 * related entity's read scope (and rejecting filters on fields it can't read) so
 * traversal can never widen access beyond a direct read of the target. */
function relationPredicate(rel: RelationDef, nested: unknown, parentEntity: string, ctx: AclContext, depth: number): SqlExpr {
  if (depth >= MAX_REL_DEPTH) throw new BadRequest("relation `where` is nested too deep");
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
    throw new BadRequest(`relation filter for '${rel.target}' must be an object`);
  }
  let inner = compileScopedWhere(nested as Record<string, unknown>, rel.target, ctx, depth + 1);

  // Security: a relation filter must respect the target's read ACL (else it leaks).
  // Two distinct "no" outcomes, matching how the rest of the read path behaves:
  //   - No read grant on the target at all  -> the relation simply yields no rows
  //     to match against (FALSE, empty result) — a valid query over a table you
  //     can't see.
  //   - Readable target, but the filter names a column you can't read -> 403, the
  //     same as ordering/aggregating by a hidden column (you referenced something
  //     forbidden). Top-level user `where` enforces the same rule (Db.readWhere).
  if (!ctx.system) {
    const tScope = resolveScope(ctx, rel.target, "read", depth + 1);
    if (!tScope.allowed) {
      inner = FALSE; // can't filter through a relation you can't read
    } else {
      if (tScope.fields !== null) {
        assertReadableRelationWhere(nested as Record<string, unknown>, rel.target, tScope.fields, ctx);
      }
      if (tScope.where) inner = and(inner, tScope.where);
    }
  }

  // belongsTo: parent.<fk> IN (SELECT <target pk> FROM target WHERE inner)
  // hasMany:   parent.<pk> IN (SELECT <target fk> FROM target WHERE inner)
  return rel.kind === "belongsTo"
    ? { t: "sub", outerCol: rel.column, from: rel.target, selectCol: pkOf(ctx.schema, rel.target), where: inner, negate: false }
    : { t: "sub", outerCol: pkOf(ctx.schema, parentEntity), from: rel.target, selectCol: rel.column, where: inner, negate: false };
}

/** Compile a where-rule (user query or policy) into a SqlExpr. Plain columns go
 * through the marker-resolving compiler; relation keys (`{ rel: { … } }`) become
 * security-scoped subqueries. Supports operators, AND/OR, and $identity/$input
 * markers; an unresolvable marker makes its branch match nothing. Schema-less
 * contexts (no relations) behave exactly like the flat compiler.
 *
 * Marker semantics: AND/OR branches compile independently, so an unresolvable
 * marker collapses ONLY its own branch to FALSE — it does not nullify sibling
 * branches. `OR: [{ ownerId: $identity("userId") }, { public: true }]` therefore
 * still grants the `public` branch to a caller whose `userId` can't resolve (and,
 * conversely, an unresolvable marker in one OR branch no longer revokes access the
 * other branches would grant). This is plain boolean logic; the cases are covered
 * by the relwhere suite.
 *
 * `allowRelations` is false for single-table contexts (cell-level `when`, which is
 * evaluated in memory and cannot do a SQL round-trip): a relation key then raises a
 * clear authoring error instead of emitting a `sub` node that throws at read time. */
export function compileScopedWhere(
  rule: Record<string, unknown>,
  entity: string,
  ctx: AclContext,
  depth = 0,
  allowRelations = true,
): SqlExpr {
  const relations = (ctx.schema?.[entity]?.relations ?? {}) as Record<string, RelationDef>;
  const parts: SqlExpr[] = [];
  const plain: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rule)) {
    if (k === "AND" || k === "OR") {
      const groups = (v as Record<string, unknown>[]).map((g) => compileScopedWhere(g, entity, ctx, depth, allowRelations));
      parts.push(k === "AND" ? and(...groups) : or(...groups));
    } else if (relations[k]) {
      if (!allowRelations) {
        throw new BadRequest(`cell-level \`when\` cannot traverse relations: '${k}' (relations need a SQL round-trip)`);
      }
      parts.push(relationPredicate(relations[k]!, v, entity, ctx, depth));
    } else {
      plain[k] = v;
    }
  }
  if (Object.keys(plain).length > 0) {
    const resolvedPlain = resolveMarkers(plain, ctx.identity, ctx.input);
    parts.push(resolvedPlain === null ? FALSE : compileWhere(resolvedPlain));
  }
  if (parts.length === 0) return TRUE; // empty where -> match all
  return parts.length === 1 ? parts[0]! : and(...parts);
}

/** The concrete rules that apply for (entity, action) under this identity — with
 * resolvers replaced by their warmup result and resolver/unresolved entries dropped. */
function matchedRules(ctx: AclContext, entity: string, action: Action): (AllowMarker | DenyMarker | PolicyRules)[] {
  const k = key(entity, action);
  const out: (AllowMarker | DenyMarker | PolicyRules)[] = [];
  for (const roleName of rolesOf(ctx.identity)) {
    const forRole = ctx.acl.byRole.get(roleName)?.get(k);
    if (!forRole) continue;
    for (const raw of forRole) {
      const rule = isResolver(raw) ? ctx.resolved?.get(raw.id) : raw;
      if (rule && !isResolver(rule)) out.push(rule);
    }
  }
  return out;
}

const ALLOW_GRANT: Grant = { where: null, fields: null, conditional: [], fieldsFns: [] };

/** OR-merge a set of grants into a Scope. No grants -> denied. Conditional/function
 * field grants concatenate; they only ADD fields to a non-null base. */
function mergeGrants(grants: Grant[]): Scope {
  if (grants.length === 0) return DENIED;
  let unrestrictedWhere = false;
  let unrestrictedFields = false;
  const orParts: SqlExpr[] = [];
  const fields = new Set<string>();
  const conditional: ConditionalGrant[] = [];
  const fieldsFns: FieldsFn[] = [];
  for (const g of grants) {
    if (g.where === null || g.where.t === "true") unrestrictedWhere = true;
    else orParts.push(g.where);
    if (g.fields === null) unrestrictedFields = true;
    else for (const f of g.fields) fields.add(f);
    conditional.push(...g.conditional);
    fieldsFns.push(...g.fieldsFns);
  }
  const where = unrestrictedWhere ? null : orParts.length === 1 ? orParts[0]! : or(...orParts);
  return {
    allowed: true,
    where,
    fields: unrestrictedFields ? null : [...fields],
    conditional,
    fieldsFns,
  };
}

export function resolveScope(ctx: AclContext, entity: string, action: Action, depth = 0): Scope {
  const grants: Grant[] = [];
  for (const rule of matchedRules(ctx, entity, action)) {
    if (isDeny(rule)) continue;
    if (isAllow(rule)) grants.push(ALLOW_GRANT);
    else {
      const where = compileScopedWhere((rule.where ?? {}) as Record<string, unknown>, entity, ctx, depth);
      grants.push(grantOf(rule, where, entity, ctx, depth));
    }
  }
  return mergeGrants(grants);
}

/** Effective visible fields for one row = base ∪ matching-conditional ∪ fn-output.
 * Returns null (all fields) when the base is null or a resolver grants everything. */
export function effectiveFields(
  scope: Scope,
  row: Record<string, unknown>,
  identity: Identity | null,
): string[] | null {
  if (scope.fields === null) return null;
  const out = new Set(scope.fields);
  for (const g of scope.conditional) if (evalExpr(g.when, row)) for (const f of g.fields) out.add(f);
  for (const fn of scope.fieldsFns) {
    const extra = fn(identity, row);
    if (extra === null) return null;
    for (const f of extra) out.add(f);
  }
  return [...out];
}

/** Forced values + validators for a write, gathered from matched write policies.
 * `set` values are resolved against the identity; later policies override earlier. */
export interface WriteRules {
  set: Record<string, unknown>;
  validators: Validator[];
}

export function resolveWriteRules(ctx: AclContext, entity: string, action: Action): WriteRules {
  const set: Record<string, unknown> = {};
  const validators: Validator[] = [];
  for (const rule of matchedRules(ctx, entity, action)) {
    if (isAllow(rule) || isDeny(rule)) continue;
    if (rule.set) {
      for (const [col, v] of Object.entries(rule.set)) {
        set[col] = typeof v === "function" ? (v as (i: Identity | null) => unknown)(ctx.identity) : v;
      }
    }
    if (rule.validate) validators.push(rule.validate);
  }
  return { set, validators };
}

/** Scope for traversing `parentEntity.relName` to `target`. Grants come from the
 * target's own read scope OR a parent read policy's relation rule with directAccess. */
export function resolveRelationScope(
  ctx: AclContext,
  parentEntity: string,
  relName: string,
  target: string,
): Scope {
  if (ctx.system) return ALLOW_ALL;

  const grants: Grant[] = [];

  const base = resolveScope(ctx, target, "read");
  if (base.allowed)
    grants.push({ where: base.where, fields: base.fields, conditional: base.conditional, fieldsFns: base.fieldsFns });

  for (const rule of matchedRules(ctx, parentEntity, "read")) {
    if (isAllow(rule) || isDeny(rule)) continue;
    const rel = rule.relations?.[relName];
    if (rel?.directAccess) {
      const relWhere = rel.where ? compileScopedWhere(rel.where as Record<string, unknown>, target, ctx, 0) : null;
      grants.push(grantOf(rel, relWhere, target, ctx, 0));
    }
  }

  return mergeGrants(grants);
}

/** Project a row to the permitted fields. null = all. */
export function projectRow(row: Record<string, unknown>, fields: string[] | null): Record<string, unknown> {
  if (!fields) return row;
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
}
