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
  type WhereRule,
  deny,
  isAllow,
  isDeny,
  isIdentityMarker,
  isInputMarker,
  isResolver,
} from "../sdk/acl";
import { compileWhere, evalExpr, FALSE, or, type SqlExpr } from "./read-engine";
import { PramenError } from "./errors";

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

/** Build a grant from a policy/relation rule, resolving $identity markers in
 * `where` and each conditional `when`. */
function grantOf(rule: PolicyRules | RelationAclRule, where: SqlExpr | null, identity: Identity | null, input: unknown): Grant {
  return {
    where,
    fields: rule.fields ?? null,
    conditional: (rule.conditionalFields ?? []).map((cf) => ({
      when: whereToExpr(cf.when, identity, input),
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

// Resolve every $identity marker in a policy where-rule (bare values, operator
// objects, in/notIn arrays, AND/OR groups). Returns a plain WhereInput, or null
// if any marker is unresolvable — in which case the rule matches nothing.
function resolveMarkers(rule: Record<string, unknown>, identity: Identity | null, input: unknown): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(rule)) {
    if (key === "AND" || key === "OR") {
      const groups: Record<string, unknown>[] = [];
      for (const g of v as Record<string, unknown>[]) {
        const resolved = resolveMarkers(g, identity, input);
        if (resolved === null) return null;
        groups.push(resolved);
      }
      out[key] = groups;
      continue;
    }

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
      out[key] = rv;
    }
  }
  return out;
}

/** Turn a policy where-rule into an expression. Supports the full user query
 * surface (operators, AND/OR) with $identity / $input markers; an unresolvable
 * marker makes the rule match nothing. */
function whereToExpr(rule: WhereRule, identity: Identity | null, input: unknown): SqlExpr {
  const resolved = resolveMarkers(rule as Record<string, unknown>, identity, input);
  return resolved === null ? FALSE : compileWhere(resolved);
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

export function resolveScope(ctx: AclContext, entity: string, action: Action): Scope {
  const grants: Grant[] = [];
  for (const rule of matchedRules(ctx, entity, action)) {
    if (isDeny(rule)) continue;
    if (isAllow(rule)) grants.push(ALLOW_GRANT);
    else grants.push(grantOf(rule, whereToExpr(rule.where ?? {}, ctx.identity, ctx.input), ctx.identity, ctx.input));
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
      grants.push(grantOf(rel, rel.where ? whereToExpr(rel.where, ctx.identity, ctx.input) : null, ctx.identity, ctx.input));
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
