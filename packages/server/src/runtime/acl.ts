// ACL resolution: the runtime counterpart of sdk/acl.ts.
// Given an identity + (entity, action), resolves a Scope: whether access is
// granted, the row-level predicate to merge into the query, and any field
// restriction. Deny-by-default; grants OR-merge across the identity's roles, each
// grant's fields kept bound to the rows its own `where` admits (see mergeGrants).

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
  type WhereValue,
  deny,
  isAllow,
  isDeny,
  isIdentityMarker,
  isInputMarker,
  isNowMarker,
  isResolver,
} from "../sdk/acl";
import { and, columnsInExpr, compileWhere, evalExpr, FALSE, hasSub, not, or, TRUE, type SqlExpr } from "./read-engine";
import { BadRequest, PramenError } from "./errors";
import type { CellValue, Row } from "../sdk/infer";
import type { FieldDef, RelationDef, RelationDefs, SchemaDef } from "../sdk/schema";

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
   * `$input(...)` marker: a capability / by-unguessable-key read grant. */
  readonly input?: unknown;
  /** Resolver results for this request (resolverId -> rule), from warmup(). */
  readonly resolved?: Map<number, PolicyRule>;
  /** SYSTEM mode bypasses all ACL, and is used for warmup reads and internal ops. */
  readonly system?: boolean;
  /** The app schema, which lets `where` rules traverse relations (`{ rel: { col } }`),
   * compiled to a subquery with the related entity's read scope AND-merged in. */
  readonly schema?: SchemaDef;
  /** The tenant this request is for: the `x-pramen-tenant` value the DO was addressed
   * with. Carried so a handler can mint a tenant-scoped capability (e.g. a signed page
   * preview link) without the caller supplying, and thus being able to forge, a tenant. */
  readonly tenant?: string;
  /** Which substrate is serving this request: `"do"` (a Durable Object, the default) or
   * `"d1"` (the shared D1 database, selected by `PRAMEN_STORE=d1`). A
   * handler needs this when a capability it mints can only be redeemed on one of them. */
  readonly store?: "do" | "d1";
  /** The partition this DO serves. When set, Db rejects any access to a table that
   * lives in a different partition (a partition-DO only owns its own tables). Unset
   * (e.g. the D1/Worker shared-store path) disables the guard, making it a no-op. */
  readonly partition?: string;
  /** Suppress declarative write-triggers for this Db. Set on the privileged context
   * that DRAINS tasks, so a task handler's writes don't re-fire triggers (which would
   * cascade, in a trigger → task → write → trigger loop). Triggers fire on request-path
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
      // `check` is a predicate on the row being WRITTEN. A read or a delete writes no row,
      // so a `check` there would be accepted and silently mean nothing: refuse it here.
      const check = (p.rule as PolicyRules | undefined)?.check;
      if (check !== undefined && p.action !== "create" && p.action !== "update") {
        throw new Error(`pramen: policy '${p.name}' declares \`check\` on a ${p.action} policy; \`check\` applies only to create and update`);
      }
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

/** Prefix of the computed 0/1 columns that carry a relation-traversing row predicate's
 * per-row value (see `RowPredicate`). Never a real column; stripped before any row is
 * returned. */
export const ACL_FLAG_PREFIX = "__pramen_acl_";

/** A row predicate evaluated per row. A single-table one runs in memory (`evalExpr`). One
 * that traverses a relation (a `sub` node) cannot, so it is computed in SQL instead: a
 * projected `CASE WHEN … END` column named `flag` on a stored row (`flagColumns`), or a
 * one-row probe for a row that isn't stored yet (Db.withFlags). */
export interface RowPredicate {
  readonly expr: SqlExpr;
  readonly flag?: string;
}

/** One policy's grant, kept PAIRED with the rows it admits. Grants OR-merge, but each
 * grant's fields apply only to the rows THAT grant admits: merging "own rows, all fields"
 * with "every row, public fields" must not produce "every row, all fields", which no
 * single grant allows. */
export interface BoundGrant {
  /** The grant's row predicate, evaluated on the STORED row (the pre-image on update, the
   * candidate on insert). Absent when the grant admits every row in scope. */
  readonly admit?: RowPredicate;
  /** The policy's `check` (update only), evaluated on the post-image. A grant whose check
   * fails contributes nothing to the write. */
  readonly check?: RowPredicate;
  /** Fields beyond the scope's base on the rows this grant admits. null = every column. */
  readonly fields: string[] | null;
  readonly conditional: ConditionalGrant[];
  readonly fieldsFns: FieldsFn[];
}

export interface Scope {
  readonly allowed: boolean;
  /** Row-level predicate to AND into the query. null = unrestricted. */
  readonly where: SqlExpr | null;
  /** Base fields: readable on EVERY row in scope, so they are the only ones that may be
   * filtered, ordered or aggregated by. null = all fields (no per-row narrowing). */
  readonly fields: string[] | null;
  /** Per-row grants, additive over `fields`: cell-level `conditionalFields`/`fieldsFn`,
   * and the extra fields of a policy that admits only some of the rows in scope. */
  readonly grants: BoundGrant[];
}

export const ALLOW_ALL: Scope = { allowed: true, where: null, fields: null, grants: [] };
const DENIED: Scope = { allowed: false, where: null, fields: null, grants: [] };

/** A single grant collected during resolution, before OR-merge. */
interface Grant {
  where: SqlExpr | null;
  fields: string[] | null;
  conditional: ConditionalGrant[];
  fieldsFns: FieldsFn[];
  /** Update policies only: the compiled `check`, a predicate on the post-image. */
  check?: SqlExpr;
}

/** Build a grant from a policy/relation rule, resolving markers in `where` and each
 * conditional `when` (the `when` predicate is single-table, evaluated in memory). */
function grantOf(rule: PolicyRules | RelationAclRule, where: SqlExpr | null, entity: string, ctx: AclContext, depth: number): Grant {
  return {
    where,
    fields: rule.fields ?? null,
    conditional: (rule.conditionalFields ?? []).map((cf) => ({
      // Cell-level `when` is evaluated per-row in memory (evalExpr), so it must stay
      // single-table: `cell: true` rejects a relation key up front.
      when: compileScopedWhere(cf.when as WhereRule, entity, ctx, { depth, cell: true }),
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
  return path.split(".").reduce<unknown>((acc, seg) => (acc == null ? undefined : (acc as WhereRule)[seg]), obj ?? undefined);
}

const UNRESOLVED = Symbol("unresolved");

// Resolve a value that may be an $identity marker (against the caller), an
// $input marker (against the request input, a capability/by-key grant), or a
// $now marker (the evaluation instant). An unresolvable marker yields UNRESOLVED,
// which makes its rule match nothing. $now always resolves.
/** A resolved where value, or the sentinel meaning "this marker could not resolve". */
type ResolvedWhereValue = WhereValue | typeof UNRESOLVED;

/** What a marker may resolve to: a non-null scalar. Anything else is UNRESOLVED. A null
 * would compile an equality to `IS NULL` and match exactly the rows that hold NO key (for
 * a capability grant, the rows never shared); an object would be read by compileWhere as
 * an operator predicate (`{"gte":""}` → full-table enumeration). */
function isScalar(v: unknown): v is string | number | bigint | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean";
}

function resolveValue(v: WhereValue, identity: Identity | null, input: unknown): ResolvedWhereValue {
  if (isNowMarker(v)) return new Date().toISOString();
  if (isIdentityMarker(v) || isInputMarker(v)) {
    const value = getPath(isIdentityMarker(v) ? identity : input, v.path);
    return isScalar(value) ? value : UNRESOLVED;
  }
  return v;
}

/** Resolve an `in`/`notIn` operand: a marker must resolve to a list of scalars, and each
 * marker inside a literal list to a scalar. Anything else is UNRESOLVED. */
function resolveList(val: WhereValue, identity: Identity | null, input: unknown): ResolvedWhereValue {
  if (isIdentityMarker(val) || isInputMarker(val)) {
    const value = getPath(isIdentityMarker(val) ? identity : input, val.path);
    return Array.isArray(value) && value.every(isScalar) ? (value as WhereValue[]) : UNRESOLVED;
  }
  if (!Array.isArray(val)) return UNRESOLVED;
  const mapped = val.map((x) => resolveValue(x, identity, input));
  return mapped.some((x) => x === UNRESOLVED) ? UNRESOLVED : (mapped as WhereValue[]);
}

// Resolve every $identity/$input/$now marker in a SINGLE level of a where-rule (bare
// values, operator objects, in/notIn arrays). AND/OR groups are split off by
// `compileScopedWhere` before this runs, so this only ever sees plain columns.
// Returns a plain WhereInput, or null if any marker is unresolvable, in which
// case this branch matches nothing (FALSE). Note: because branches are resolved
// independently, an unresolvable marker nullifies only its own branch, not the
// whole rule, so `OR: [{ x: $identity(...) }, { public: true }]` still matches
// the `public` branch for a caller whose marker can't resolve. (See the comment
// on `compileScopedWhere`.) A marker only ever resolves to a non-null scalar, or a
// list of them for in/notIn (see `isScalar`), for bare values and operands alike.
function resolveMarkers(rule: WhereRule, identity: Identity | null, input: unknown): WhereRule | null {
  const out: WhereRule = {};
  for (const [key, v] of Object.entries(rule)) {
    const isMarker = isIdentityMarker(v) || isInputMarker(v) || isNowMarker(v);
    if (v !== null && typeof v === "object" && !isMarker && !Array.isArray(v)) {
      const ops: WhereRule = {};
      for (const [op, val] of Object.entries(v as WhereRule)) {
        const rv = op === "in" || op === "notIn" ? resolveList(val, identity, input) : resolveValue(val, identity, input);
        if (rv === UNRESOLVED) return null;
        ops[op] = rv;
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

/** Max relation-traversal nesting depth in a `where` (guards cyclic relations).
 * Kept in lockstep with the `WhereClause` type's depth bound in sdk/infer.ts: if
 * you change one, change the other. */
export const MAX_REL_DEPTH = 5;

/** Primary-key column of an entity (the column a belongsTo points at / a hasMany
 * joins back to). Defaults to `id`. */
function pkOf(schema: SchemaDef | undefined, entity: string): string {
  const fields = schema?.[entity]?.fields;
  if (fields) for (const [n, f] of Object.entries(fields)) if ((f as FieldDef).primaryKey) return n;
  return "id";
}

/** Reject a column a caller-supplied filter or join may not reference: `hidden()` always
 * (even under allow()/SYSTEM), and anything outside the base `fields` when restricted. */
function assertReadableCol(entity: string, col: string, fields: string[] | null, schema: SchemaDef | undefined): void {
  const fd = schema?.[entity]?.fields?.[col] as FieldDef | undefined;
  if (fd?.hidden || (fields !== null && !fields.includes(col))) throw new AclDenied(entity, "read", col);
}

/** Validate a CALLER-SUPPLIED `where` over `entity` against what the caller may read
 * (a filter is an oracle for every column it names), anywhere in the clause including
 * nested AND/OR/NOT groups:
 *   - a key that is neither a declared column nor a relation is a 400;
 *   - a `hidden()` column is a 403 whatever the scope, as with orderBy/select/aggregate;
 *   - a column outside the base `fields` (when restricted) is a 403;
 *   - a belongsTo/oneHasOne key joins on THIS entity's FK, so that FK must be readable
 *     here too. The hop's own target is validated when the relation compiles
 *     (acl.relationPredicate), as is a hasMany/oneHasOneInverse join column, which lives
 *     on the target.
 * Policy `where` rules are trusted developer code and are not checked. Schemaless
 * entities are skipped. */
export function assertReadableWhereKeys(where: unknown, entity: string, fields: string[] | null, schema: SchemaDef | undefined): void {
  if (where == null) return;
  if (typeof where !== "object" || Array.isArray(where)) throw new BadRequest(`invalid where clause for '${entity}'`);
  const def = schema?.[entity];
  if (!def) return;
  const cols = def.fields as Record<string, FieldDef>;
  const rels = (def.relations ?? {}) as RelationDefs;
  for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
    if (k === "AND" || k === "OR") {
      if (!Array.isArray(v)) throw new BadRequest(`\`${k}\` must be an array`);
      for (const g of v) assertReadableWhereKeys(g, entity, fields, schema);
    } else if (k === "NOT") {
      assertReadableWhereKeys(v, entity, fields, schema);
    } else if (Object.prototype.hasOwnProperty.call(rels, k)) {
      const rel = rels[k]!;
      if (rel.kind === "belongsTo" || rel.kind === "oneHasOne") assertReadableCol(entity, rel.column, fields, schema);
    } else if (!Object.prototype.hasOwnProperty.call(cols, k)) {
      throw new BadRequest(`unknown column: ${entity}.${k}`);
    } else {
      assertReadableCol(entity, k, fields, schema);
    }
  }
}

/** Compile a relation predicate `{ rel: { … } }` to a subquery, AND-merging the
 * related entity's read scope (and, for a manyToMany, the junction's) so traversal can
 * never widen access beyond a direct read of the target. `untrusted` marks a
 * caller-supplied filter, whose keys and join columns are also checked for readability. */
function relationPredicate(
  rel: RelationDef,
  nested: unknown,
  parentEntity: string,
  ctx: AclContext,
  depth: number,
  untrusted: boolean,
): SqlExpr {
  if (depth >= MAX_REL_DEPTH) throw new BadRequest("relation `where` is nested too deep");
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
    throw new BadRequest(`relation filter for '${rel.target}' must be an object`);
  }
  let inner = compileScopedWhere(nested as WhereRule, rel.target, ctx, { depth: depth + 1, untrusted });

  // Security: a relation filter must respect the target's read ACL (else it leaks).
  // Two distinct "no" outcomes, matching how the rest of the read path behaves:
  //   - No read grant on the target at all  -> the relation simply yields no rows
  //     to match against (FALSE, empty result), a valid query over a table you
  //     can't see.
  //   - Readable target, but a caller's filter names a column you can't read -> 403,
  //     the same as ordering/aggregating by a hidden column (you referenced something
  //     forbidden). That includes the JOIN column: a hasMany/oneHasOneInverse joins on
  //     the target's FK, so filtering through it is a filter on that FK. SYSTEM checks
  //     only `hidden()` (its scope is unrestricted), like orderBy/select do.
  const tScope = ctx.system ? ALLOW_ALL : resolveScope(ctx, rel.target, "read", depth + 1);
  if (!tScope.allowed) {
    inner = FALSE; // can't filter through a relation you can't read
  } else {
    if (untrusted) {
      assertReadableWhereKeys(nested, rel.target, tScope.fields, ctx.schema);
      if (rel.kind === "hasMany" || rel.kind === "oneHasOneInverse") assertReadableCol(rel.target, rel.column, tScope.fields, ctx.schema);
    }
    if (tScope.where) inner = and(inner, tScope.where);
  }

  // belongsTo: parent.<fk> IN (SELECT <target pk> FROM target WHERE inner)
  // hasMany:   parent.<pk> IN (SELECT <target fk> FROM target WHERE inner)
  // manyToMany: parent.<pk> IN (SELECT <sourceCol> FROM through
  //               WHERE <targetCol> IN (SELECT <target pk> FROM target WHERE inner)
  //               AND <junction read scope>)
  if (rel.kind === "manyToMany") {
    // The junction is an ordinary entity with its own policies: a link row the caller
    // can't read directly must not be observable through the traversal either.
    let link: SqlExpr = { t: "sub", outerCol: rel.targetColumn, from: rel.target, selectCol: pkOf(ctx.schema, rel.target), where: inner, negate: false };
    const jScope = ctx.system ? ALLOW_ALL : resolveScope(ctx, rel.through, "read", depth + 1);
    if (!jScope.allowed) {
      link = FALSE;
    } else {
      if (untrusted) {
        assertReadableCol(rel.through, rel.sourceColumn, jScope.fields, ctx.schema);
        assertReadableCol(rel.through, rel.targetColumn, jScope.fields, ctx.schema);
      }
      if (jScope.where) link = and(link, jScope.where);
    }
    return { t: "sub", outerCol: pkOf(ctx.schema, parentEntity), from: rel.through, selectCol: rel.sourceColumn, where: link, negate: false };
  }
  // oneHasOne mirrors belongsTo (this row's FK → target pk); oneHasOneInverse mirrors
  // hasMany (target's column → this row's pk).
  return rel.kind === "belongsTo" || rel.kind === "oneHasOne"
    ? { t: "sub", outerCol: rel.column, from: rel.target, selectCol: pkOf(ctx.schema, rel.target), where: inner, negate: false }
    : { t: "sub", outerCol: pkOf(ctx.schema, parentEntity), from: rel.target, selectCol: rel.column, where: inner, negate: false };
}

/** Options for `compileScopedWhere`. */
export interface ScopedWhereOpts {
  /** Relation-traversal depth so far (guards cyclic relations). */
  readonly depth?: number;
  /** A single-table context (cell-level `when`, evaluated in memory and unable to do a
   * SQL round-trip): a relation key then raises a clear authoring error instead of
   * emitting a `sub` node that throws at read time. */
  readonly cell?: boolean;
  /** A caller-supplied filter (Db's user `where`), as opposed to a trusted policy rule:
   * every relation hop's keys and join columns are checked for readability. The caller
   * validates the top level itself (`assertReadableWhereKeys`, against its own scope). */
  readonly untrusted?: boolean;
}

/** Compile a where-rule (user query or policy) into a SqlExpr. Plain columns go
 * through the marker-resolving compiler; relation keys (`{ rel: { … } }`) become
 * security-scoped subqueries. Supports operators, AND/OR, and $identity/$input/$now
 * markers; an unresolvable marker makes its branch match nothing. Schema-less
 * contexts (no relations) behave exactly like the flat compiler.
 *
 * Marker semantics: AND/OR branches compile independently, so an unresolvable
 * marker collapses ONLY its own branch to FALSE. It does not nullify sibling
 * branches. `OR: [{ ownerId: $identity("userId") }, { public: true }]` therefore
 * still grants the `public` branch to a caller whose `userId` can't resolve (and,
 * conversely, an unresolvable marker in one OR branch no longer revokes access the
 * other branches would grant). This is plain boolean logic; the cases are covered
 * by the relwhere suite. */
export function compileScopedWhere(rule: WhereRule, entity: string, ctx: AclContext, opts: ScopedWhereOpts = {}): SqlExpr {
  const depth = opts.depth ?? 0;
  const relations = (ctx.schema?.[entity]?.relations ?? {}) as Record<string, RelationDef>;
  const parts: SqlExpr[] = [];
  const plain: WhereRule = {};
  for (const [k, v] of Object.entries(rule)) {
    if (k === "AND" || k === "OR") {
      if (!Array.isArray(v)) throw new BadRequest(`\`${k}\` must be an array`);
      const groups = (v as WhereRule[]).map((g) => compileScopedWhere(g, entity, ctx, opts));
      parts.push(k === "AND" ? and(...groups) : or(...groups));
    } else if (k === "NOT") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new BadRequest("`NOT` must be an object");
      parts.push(not(compileScopedWhere(v as WhereRule, entity, ctx, opts)));
    } else if (Object.prototype.hasOwnProperty.call(relations, k)) {
      if (opts.cell) {
        throw new BadRequest(`cell-level \`when\` cannot traverse relations: '${k}' (relations need a SQL round-trip)`);
      }
      parts.push(relationPredicate(relations[k]!, v, entity, ctx, depth, opts.untrusted ?? false));
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

/** The concrete rules that apply for (entity, action) under this identity, with
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

/** One grant per matched policy for (entity, action). A `check` on a create policy folds
 * into its `where` (the candidate row IS the post-image); on an update policy it stays
 * separate, evaluated on the post-image while `where` gates the pre-image. */
function collectGrants(ctx: AclContext, entity: string, action: Action, depth: number): Grant[] {
  const grants: Grant[] = [];
  for (const rule of matchedRules(ctx, entity, action)) {
    if (isDeny(rule)) continue;
    if (isAllow(rule)) {
      grants.push(ALLOW_GRANT);
      continue;
    }
    const where = compileScopedWhere((rule.where ?? {}) as WhereRule, entity, ctx, { depth });
    const grant = grantOf(rule, where, entity, ctx, depth);
    if (rule.check && (action === "create" || action === "update")) {
      const check = compileScopedWhere(rule.check, entity, ctx, { depth });
      if (action === "create") grant.where = and(where, check);
      else grant.check = check;
    }
    grants.push(grant);
  }
  return grants;
}

const isRowWide = (g: Grant) => g.where === null || g.where.t === "true";

/** OR-merge a set of grants into a Scope. No grants -> denied.
 *
 * Rows OR-merge. Fields do NOT merge independently of rows: a grant's fields apply only
 * to the rows that grant admits. The base `fields` are those readable on EVERY row in
 * scope: a field every grant lists (each row is admitted by one of them), plus the fields
 * of a grant that admits every row. Anything a row-restricted grant adds beyond that
 * becomes a per-row BoundGrant, admitted by that grant's own `where`. A grant that
 * admits every row in scope needs no admission predicate: it is row-wide, or it is the
 * only grant (the scope's `where` already IS its admission), which keeps the common
 * single-policy case exactly as cheap as before. */
function mergeGrants(grants: Grant[]): Scope {
  if (grants.length === 0) return DENIED;
  const restricted = grants.filter((g) => !isRowWide(g)).map((g) => g.where!);
  const where = restricted.length < grants.length ? null : restricted.length === 1 ? restricted[0]! : or(...restricted);

  // every: the fields EVERY grant lists (a field-unrestricted grant lists them all), so
  // whichever grant admits a row, it grants these. null = no grant restricts fields.
  // wide: the fields of grants that admit every row. Only check-free ones count: a grant
  // with a `check` may turn out not to apply to a write. null = one of them grants all.
  let every: Set<string> | null = null;
  let wide: Set<string> | null = new Set();
  for (const g of grants) {
    if (g.fields !== null) every = every === null ? new Set(g.fields) : new Set(g.fields.filter((f) => every!.has(f)));
    if (isRowWide(g) && !g.check && wide !== null) {
      if (g.fields === null) wide = null;
      else for (const f of g.fields) wide.add(f);
    }
  }
  const baseFields: string[] | null = every === null || wide === null ? null : [...new Set([...every, ...wide])];

  const hasCheck = grants.some((g) => g.check);
  const grantsOut: BoundGrant[] = [];
  if (baseFields !== null || hasCheck) {
    let n = 0;
    const pred = (expr: SqlExpr): RowPredicate => (hasSub(expr) ? { expr, flag: `${ACL_FLAG_PREFIX}${n++}` } : { expr });
    const baseSet = baseFields === null ? null : new Set(baseFields);
    const single = grants.length === 1;
    for (const g of grants) {
      const extra = baseSet === null ? [] : g.fields === null ? null : g.fields.filter((f) => !baseSet.has(f));
      const addsNothing = extra !== null && extra.length === 0 && g.conditional.length === 0 && g.fieldsFns.length === 0;
      // With a `check` in play every grant is kept, so a write can tell whether ANY of
      // them still applies to its post-image.
      if (addsNothing && !hasCheck) continue;
      grantsOut.push({
        admit: single || isRowWide(g) ? undefined : pred(g.where!),
        check: g.check ? pred(g.check) : undefined,
        fields: extra,
        conditional: g.conditional,
        fieldsFns: g.fieldsFns,
      });
    }
  }
  return { allowed: true, where, fields: baseFields, grants: grantsOut };
}

export function resolveScope(ctx: AclContext, entity: string, action: Action, depth = 0): Scope {
  return mergeGrants(collectGrants(ctx, entity, action, depth));
}

/** Whether a row predicate holds for `row`: in memory, or from its SQL-computed flag
 * column. A flag the row doesn't carry counts as false (fail closed). */
export function predicateHolds(p: RowPredicate | undefined, row: Row): boolean {
  if (!p) return true;
  if (p.flag !== undefined) {
    const v = row[p.flag];
    return v != null && Number(v) === 1;
  }
  return evalExpr(p.expr, row);
}

/** Whether a bound grant applies: it admits the STORED row and its `check` (if any)
 * holds on `row` (the post-image on update; the same row on read/insert). */
function grantApplies(g: BoundGrant, row: Row, stored: Row): boolean {
  return predicateHolds(g.admit, stored) && predicateHolds(g.check, row);
}

/** Effective visible (or writable) fields for one row = base ∪ the fields of each bound
 * grant that applies to it (its own fields, matching conditional grants, fn output).
 * Returns null (all fields) when the base is null or an applying grant grants everything.
 * `row` is what cell `when`s and fns see (the candidate/post-merge row on a write);
 * `stored` is what admissions are evaluated on (the pre-image on update). */
export function effectiveFields(scope: Scope, row: Row, identity: Identity | null, stored: Row = row): string[] | null {
  if (scope.fields === null) return null;
  const out = new Set(scope.fields);
  for (const g of scope.grants) {
    if (!grantApplies(g, row, stored)) continue;
    if (g.fields === null) return null;
    for (const f of g.fields) out.add(f);
    for (const c of g.conditional) if (evalExpr(c.when, row)) for (const f of c.fields) out.add(f);
    for (const fn of g.fieldsFns) {
      const extra = fn(identity, row);
      if (extra === null) return null;
      for (const f of extra) out.add(f);
    }
  }
  return [...out];
}

/** Whether any of the scope's grants still applies to a write whose post-image is `row`
 * and pre-image `stored`. Only meaningful when the scope carries a `check` (`hasCheck`):
 * then every grant is kept as a BoundGrant, and a write none of them applies to is denied. */
export function anyGrantApplies(scope: Scope, row: Row, stored: Row): boolean {
  return scope.grants.some((g) => grantApplies(g, row, stored));
}

export function hasCheck(scope: Scope): boolean {
  return scope.grants.some((g) => g.check);
}

/** Every field that may be visible on SOME row in scope (for projection and `select`
 * validation). null = any field (unrestricted, or a field-resolver may expose anything). */
export function possibleFields(scope: Scope): string[] | null {
  if (scope.fields === null) return null;
  const out = new Set(scope.fields);
  for (const g of scope.grants) {
    if (g.fields === null || g.fieldsFns.length > 0) return null;
    for (const f of g.fields) out.add(f);
    for (const c of g.conditional) for (const f of c.fields) out.add(f);
  }
  return [...out];
}

/** Whether any grant carries a field-resolver function (which can read any column). */
export function hasFieldsFn(scope: Scope): boolean {
  return scope.grants.some((g) => g.fieldsFns.length > 0);
}

/** Columns a stored row must carry for the per-row grants to evaluate in memory: each
 * cell `when`'s inputs and each in-memory admission's inputs. */
export function scopeInputColumns(scope: Scope): Set<string> {
  const out = new Set<string>();
  for (const g of scope.grants) {
    if (g.admit && g.admit.flag === undefined) columnsInExpr(g.admit.expr, out);
    for (const c of g.conditional) columnsInExpr(c.when, out);
  }
  return out;
}

/** The SQL-computed admission flags a stored row of this scope must be read with. */
export function flagColumns(scope: Scope): { alias: string; expr: SqlExpr }[] {
  const out: { alias: string; expr: SqlExpr }[] = [];
  for (const g of scope.grants) if (g.admit?.flag !== undefined) out.push({ alias: g.admit.flag, expr: g.admit.expr });
  return out;
}

/** The SQL-computed `check` flags, evaluated on a post-image (which isn't stored yet). */
export function checkFlagPredicates(scope: Scope): { alias: string; expr: SqlExpr }[] {
  const out: { alias: string; expr: SqlExpr }[] = [];
  for (const g of scope.grants) if (g.check?.flag !== undefined) out.push({ alias: g.check.flag, expr: g.check.expr });
  return out;
}

/** Forced values + validators for a write, gathered from matched write policies.
 * `set` values are resolved against the identity; later policies override earlier. */
export interface WriteRules {
  set: Row;
  validators: Validator[];
}

export function resolveWriteRules(ctx: AclContext, entity: string, action: Action): WriteRules {
  const set: Row = {};
  const validators: Validator[] = [];
  for (const rule of matchedRules(ctx, entity, action)) {
    if (isAllow(rule) || isDeny(rule)) continue;
    if (rule.set) {
      for (const [col, v] of Object.entries(rule.set)) {
        set[col] = typeof v === "function" ? (v as (i: Identity | null) => CellValue)(ctx.identity) : v;
      }
    }
    if (rule.validate) validators.push(rule.validate);
  }
  return { set, validators };
}

/** The target rows reachable through `rel` from a parent row matching `parentWhere`, as
 * a predicate over the TARGET (so it can scope a relation load). */
function reachableFrom(schema: SchemaDef | undefined, parentEntity: string, rel: RelationDef, parentWhere: SqlExpr): SqlExpr {
  const parentPk = pkOf(schema, parentEntity);
  switch (rel.kind) {
    case "belongsTo":
    case "oneHasOne":
      return { t: "sub", outerCol: pkOf(schema, rel.target), from: parentEntity, selectCol: rel.column, where: parentWhere, negate: false };
    case "hasMany":
    case "oneHasOneInverse":
      return { t: "sub", outerCol: rel.column, from: parentEntity, selectCol: parentPk, where: parentWhere, negate: false };
    case "manyToMany":
      return {
        t: "sub",
        outerCol: pkOf(schema, rel.target),
        from: rel.through,
        selectCol: rel.targetColumn,
        where: { t: "sub", outerCol: rel.sourceColumn, from: parentEntity, selectCol: parentPk, where: parentWhere, negate: false },
        negate: false,
      };
  }
}

/** Scope for traversing `parentEntity.relName` to `target`. Grants come from the
 * target's own read scope OR a parent read policy's relation rule with directAccess.
 * A directAccess grant applies only to targets reached from parent rows THAT policy's
 * `where` admits: another role's wider parent grant must not lend it more parents. */
export function resolveRelationScope(ctx: AclContext, parentEntity: string, relName: string, target: string): Scope {
  if (ctx.system) return ALLOW_ALL;

  const grants = collectGrants(ctx, target, "read", 0);
  const relDef = ctx.schema?.[parentEntity]?.relations?.[relName] as RelationDef | undefined;

  for (const rule of matchedRules(ctx, parentEntity, "read")) {
    if (isAllow(rule) || isDeny(rule)) continue;
    const rel = rule.relations?.[relName];
    if (!rel?.directAccess) continue;
    let where: SqlExpr | null = rel.where ? compileScopedWhere(rel.where as WhereRule, target, ctx) : null;
    const parentWhere = compileScopedWhere((rule.where ?? {}) as WhereRule, parentEntity, ctx);
    if (parentWhere.t !== "true") {
      if (!relDef) continue; // can't bind the grant to its parent rows: grant nothing
      const reach = reachableFrom(ctx.schema, parentEntity, relDef, parentWhere);
      where = where ? and(where, reach) : reach;
    }
    grants.push(grantOf(rel, where, target, ctx, 0));
  }

  return mergeGrants(grants);
}

/** Project a row to the permitted fields. null = all. */
export function projectRow(row: Row, fields: string[] | null): Row {
  if (!fields) return row;
  const out: Row = {};
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
}
