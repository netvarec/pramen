// Schema definition — the portable layer: an `Entity(t => ({...}))` factory and
// `defineSchema({...})`. Field builders return `as const` literals so
// the exact field shape survives into the type system; sdk/infer.ts turns that
// shape into row/where/insert types.
//
// Entities may also declare relations (belongsTo / hasMany) via a second builder.
// Relations reference their target table by name (resolved at runtime) and the
// foreign-key column. Relation traversal is ACL-governed (see runtime/acl.ts).

// "json" and "fileRef" are logical types stored as TEXT (JSON). The value a handler
// reads/writes is the parsed value (a JsonValue, or a FileRef) — db.ts codecs it
// to/from the column, and infer.ts types it accordingly. "uuid" is a TEXT column
// typed as `string`; wrap it with `generated()` to auto-mint a v4 on insert.
export type FieldType = "text" | "integer" | "real" | "boolean" | "json" | "fileRef" | "uuid";

/** A SQL DEFAULT literal (used by the migrator + DDL). */
export type DefaultValue = string | number | boolean | null;

export interface FieldDef {
  readonly type: FieldType;
  readonly primaryKey?: boolean;
  readonly autoIncrement?: boolean;
  readonly notNull?: boolean;
  /** A UNIQUE constraint (enforced via a unique index). */
  readonly unique?: boolean;
  /** A (non-unique) index on this column. */
  readonly index?: boolean;
  /** Auto-generate the value on insert when the caller omits it (uuid columns only,
   * minted via crypto.randomUUID()). Set by the `generated()` modifier; makes the
   * column optional on insert. */
  readonly generated?: boolean;
  /** A column DEFAULT (a literal). Makes the column optional on insert. */
  readonly default?: DefaultValue;
  /** A column DEFAULT that is raw SQL, emitted UNQUOTED (e.g. `datetime('now')`) —
   * set by `defaultTo(field, expr.now())`/`expr.raw(...)`. Distinct from `default`
   * (a quoted literal). Makes the column optional on insert. */
  readonly defaultExpr?: string;
  /** Migration hint: this column was previously named X. On boot the migrator
   * rebuilds the table, copying data from the old column. A diff cannot tell a
   * rename from a drop+add, so the rename must be declared explicitly. */
  readonly renamedFrom?: string;
  /** Never project this column on any ORM read — find/get, mutation echoes, relation
   * loads, and the SYSTEM-mode admin data API all strip it, even under a full-access
   * (allow()) or SYSTEM scope. Writable on insert/update, and still visible to raw
   * `ctx.db.exec` (the escape hatch credential code uses). For secrets/internal
   * columns like a password hash. Set by the `hidden()` modifier. */
  readonly hidden?: boolean;
}

const builders = {
  id: () => ({ type: "integer", primaryKey: true, autoIncrement: true, notNull: true }) as const,
  textId: () => ({ type: "text", primaryKey: true, notNull: true }) as const,
  text: () => ({ type: "text" }) as const,
  int: () => ({ type: "integer" }) as const,
  real: () => ({ type: "real" }) as const,
  bool: () => ({ type: "boolean" }) as const,
  /** Arbitrary JSON, stored in a TEXT column. Handlers read/write the parsed value
   * (a JsonValue); db.ts stringifies on write and parses on read. */
  json: () => ({ type: "json" }) as const,
  /** A reference to a stored file (R2 object). Holds JSON metadata (a FileRef),
   * not the bytes — upload/download go through ctx.files + the Worker /files/* route. */
  fileRef: () => ({ type: "fileRef" }) as const,
  /** A UUID stored in a TEXT column (typed as `string`). Wrap with `generated()` to
   * auto-mint a v4 on insert, and/or `primaryKey()` to use it as the PK — the kvalt
   * pattern `id: primaryKey(generated(t.uuid()))`. A provided value is validated. */
  uuid: () => ({ type: "uuid" }) as const,
};

export type FieldBuilders = typeof builders;
export type EntityFields = Record<string, FieldDef>;

// --- relations ---

export interface BelongsToDef<T extends string = string> {
  readonly kind: "belongsTo";
  readonly target: T;
  /** Local column holding the target's primary key. */
  readonly column: string;
}
export interface HasManyDef<T extends string = string> {
  readonly kind: "hasMany";
  readonly target: T;
  /** Column on the target referring back to this entity's primary key. */
  readonly column: string;
}
export type RelationDef = BelongsToDef | HasManyDef;
export type RelationDefs = Record<string, RelationDef>;

const relationBuilders = {
  belongsTo: <T extends string>(target: T, column: string) => ({ kind: "belongsTo", target, column }) as const,
  hasMany: <T extends string>(target: T, column: string) => ({ kind: "hasMany", target, column }) as const,
};
export type RelationBuilders = typeof relationBuilders;

/** The default partition name for entities that don't declare one. */
export const DEFAULT_PARTITION = "default";

// --- triggers — declarative "on write → enqueue a task" (layered on the outbox) ---

export type TriggerOp = "create" | "update" | "delete";

/** A declarative trigger on an entity: when a matching write commits, the `Db` write
 * path enqueues a task of `task` (handled by `app.tasks[task]`) IN THE SAME transaction
 * as the write, with payload `{ entity, op, id, row }`. So a side effect (webhook,
 * notification email) fires reliably after the write, off the single-writer path —
 * reusing the whole outbox machinery (retry, idempotency, drain). Only ORM writes
 * (`ctx.db` insert/update/delete) fire triggers; the raw `ctx.db.exec` escape hatch
 * does not. */
export interface TriggerDef {
  /** The `app.tasks` handler kind that runs the side effect. */
  readonly task: string;
  /** Which ops fire it. For `update`, an array names the columns to watch — fire only
   * when the update writes one of them; `true` fires on any update. */
  readonly on: { create?: boolean; update?: boolean | readonly string[]; delete?: boolean };
}

/** Declare an entity trigger (sugar; returns the def). */
export function trigger(def: TriggerDef): TriggerDef {
  return def;
}

/** Does this trigger fire for `op` given the columns the write touched? */
export function triggerFires(t: TriggerDef, op: TriggerOp, writtenCols: readonly string[]): boolean {
  if (op === "create") return t.on.create === true;
  if (op === "delete") return t.on.delete === true;
  const u = t.on.update;
  if (u === true) return true;
  if (Array.isArray(u)) return u.some((f) => writtenCols.includes(f));
  return false;
}

export interface EntityDef<F extends EntityFields = EntityFields, R extends RelationDefs = Record<string, never>> {
  readonly fields: F;
  readonly relations: R;
  /** The partition (Durable Object class) this entity lives in. Always populated;
   * defaults to `"default"` so downstream code never branches on `undefined`. */
  readonly partition: string;
  /** Declarative write-triggers (see TriggerDef). Always an array (possibly empty). */
  readonly triggers: readonly TriggerDef[];
}

export function Entity<F extends EntityFields, R extends RelationDefs = Record<string, never>>(
  build: (t: FieldBuilders) => F,
  relations?: (r: RelationBuilders) => R,
  opts?: { partition?: string; triggers?: readonly TriggerDef[] },
): EntityDef<F, R> {
  return {
    fields: build(builders),
    relations: (relations ? relations(relationBuilders) : {}) as R,
    partition: opts?.partition ?? DEFAULT_PARTITION,
    triggers: opts?.triggers ?? [],
  };
}

/** The triggers declared on an entity (empty if none / unknown entity). */
export function triggersOf(schema: SchemaDef, entity: string): readonly TriggerDef[] {
  return schema[entity]?.triggers ?? [];
}

/** Throw if any declarative trigger names a `task` not in `taskNames` — caught at
 * deploy/load by createPramen, so a typo can't silently enqueue a task that never runs
 * (it would retry then dead-letter). */
export function validateTriggerTasks(schema: SchemaDef, taskNames: Iterable<string>): void {
  const known = new Set(taskNames);
  for (const [entity, def] of Object.entries(schema)) {
    for (const t of def.triggers) {
      if (!known.has(t.task)) {
        throw new Error(`trigger on '${entity}' references task '${t.task}', but app.tasks has no such handler.`);
      }
    }
  }
}

/** Annotate a field as renamed from a previous column name (migration hint). Wraps
 * a builder result, preserving its literal field type: `title: renamedFrom(t.text(), "name")`. */
export function renamedFrom<F extends FieldDef>(field: F, from: string): F & { readonly renamedFrom: string } {
  return { ...field, renamedFrom: from };
}

// --- field modifiers — wrap a builder result, preserving its literal type. They
// compose: `unique(notNull(t.text()))`, `defaultTo(t.int(), 0)`. (Wrapper style,
// like renamedFrom — avoids the method/field name clash a `.notNull()` chain hits.)

/** Mark a column NOT NULL. */
export function notNull<F extends FieldDef>(field: F): F & { readonly notNull: true } {
  return { ...field, notNull: true };
}

/** Add a UNIQUE constraint (enforced via a unique index). */
export function unique<F extends FieldDef>(field: F): F & { readonly unique: true } {
  return { ...field, unique: true };
}

/** Add a (non-unique) index on the column. */
export function indexed<F extends FieldDef>(field: F): F & { readonly index: true } {
  return { ...field, index: true };
}

/** Mark a column never-readable through the ORM: stripped from every read projection
 * (find/get, mutation echoes, relation loads, admin data) even under full/SYSTEM
 * access. Still writable, and still visible to raw `ctx.db.exec`. For secrets such as
 * a password hash, e.g. `passwordHash: hidden(t.text())`. */
export function hidden<F extends FieldDef>(field: F): F & { readonly hidden: true } {
  return { ...field, hidden: true };
}

/** A raw-SQL column DEFAULT (emitted unquoted in the DDL), produced by the `expr`
 * helpers below. Distinct from a literal default so `defaultTo` can render
 * `DEFAULT datetime('now')` rather than the quoted string `DEFAULT 'datetime(...)'`. */
export class ExprDefault {
  constructor(readonly sql: string) {}
}

/** SQL-expression defaults for `defaultTo(field, expr.now())`. `now()` is the current
 * UTC timestamp as TEXT (`'YYYY-MM-DD HH:MM:SS'`, like `CURRENT_TIMESTAMP`) — pair it
 * with `t.text()`. `raw(sql)` is an escape hatch for any other SQLite default expression. */
export const expr = {
  now: (): ExprDefault => new ExprDefault("datetime('now')"),
  raw: (sql: string): ExprDefault => new ExprDefault(sql),
};

/** Give the column a DEFAULT — also makes it optional on insert. Pass a literal
 * (rendered as a quoted SQL literal) or an `expr.*()` value (raw SQL, unquoted),
 * e.g. `defaultTo(t.text(), "pending")` or `defaultTo(t.text(), expr.now())`. */
export function defaultTo<F extends FieldDef>(field: F, value: ExprDefault): F & { readonly defaultExpr: string };
export function defaultTo<F extends FieldDef, D extends DefaultValue>(field: F, value: D): F & { readonly default: D };
export function defaultTo<F extends FieldDef>(field: F, value: DefaultValue | ExprDefault): FieldDef {
  return value instanceof ExprDefault ? { ...field, defaultExpr: value.sql } : { ...field, default: value };
}

/** Mark a column as the PRIMARY KEY (implies NOT NULL). Composes with any builder,
 * e.g. `id: primaryKey(generated(t.uuid()))` or `code: primaryKey(t.text())`. */
export function primaryKey<F extends FieldDef>(field: F): F & { readonly primaryKey: true; readonly notNull: true } {
  return { ...field, primaryKey: true, notNull: true };
}

/** Auto-generate the column's value on insert when omitted — uuid only (minted via
 * crypto.randomUUID()). Makes the column optional on insert. Rejected at schema
 * construction on a non-uuid column, since the runtime only knows how to mint uuids. */
export function generated<F extends FieldDef>(field: F): F & { readonly generated: true } {
  if (field.type !== "uuid") {
    throw new Error(`generated() is only valid on a uuid column (got '${field.type}')`);
  }
  return { ...field, generated: true };
}

export type SchemaDef = Record<string, EntityDef<EntityFields, RelationDefs>>;

export function defineSchema<S extends SchemaDef>(entities: S): S {
  return entities;
}

// --- partition helpers — enumerate / resolve the partition (Durable Object class)
// an entity lives in. Used by the migrator/admin to group tables per DO.

/** The partition an entity lives in. Defaults to `"default"` for unknown entities. */
export function partitionOf(schema: SchemaDef, entity: string): string {
  return schema[entity]?.partition ?? DEFAULT_PARTITION;
}

/** The distinct partition names in a schema, in stable (first-seen) order. */
export function partitionsOf(schema: SchemaDef): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entity of Object.keys(schema)) {
    const partition = partitionOf(schema, entity);
    if (!seen.has(partition)) {
      seen.add(partition);
      out.push(partition);
    }
  }
  return out;
}

/** The table names whose partition matches `partition`, in schema (key) order. */
export function entitiesInPartition(schema: SchemaDef, partition: string): string[] {
  return Object.keys(schema).filter((entity) => partitionOf(schema, entity) === partition);
}

// --- schema validation — static invariants checked once before migrate (DO boot
// + the D1 path) and at codegen. Cloudflare-free, so it stays in sdk/.

/**
 * Validate a schema's static invariants, throwing on the first violation:
 *
 *  - every relation's `target` names an entity that exists in the schema;
 *  - no relation crosses a partition boundary — a relation's source and target
 *    must live in the same partition (a Durable Object can't reach into another).
 *
 * Relations are static, so these are caught at validation time (boot + codegen),
 * never as a runtime surprise. Runs even for a single (default) partition — it's
 * cheap and catches relation-target typos.
 */
export function validateSchema(schema: SchemaDef): void {
  for (const [entity, def] of Object.entries(schema)) {
    for (const [relName, rel] of Object.entries(def.relations)) {
      if (!(rel.target in schema)) {
        throw new Error(
          `relation '${entity}.${relName}' targets unknown entity '${rel.target}' — ` +
            `no such entity in the schema. Check the relation target name.`,
        );
      }
      const pE = partitionOf(schema, entity);
      const pT = partitionOf(schema, rel.target);
      if (pE !== pT) {
        throw new Error(
          `relation '${entity}.${relName}' crosses a partition boundary: '${entity}' is in partition ` +
            `'${pE}' but target '${rel.target}' is in '${pT}'. Relations cannot cross partitions — ` +
            `put both entities in the same partition or drop the relation.`,
        );
      }
    }
    for (const t of def.triggers) {
      if (!t.task) throw new Error(`trigger on '${entity}' is missing a 'task'.`);
      if (!t.on.create && !t.on.update && !t.on.delete) {
        throw new Error(`trigger '${t.task}' on '${entity}' fires on nothing — set on.create/update/delete.`);
      }
      const watched = Array.isArray(t.on.update) ? t.on.update : [];
      for (const f of watched) {
        if (!(f in def.fields)) {
          throw new Error(`trigger '${t.task}' on '${entity}' watches unknown column '${f}'.`);
        }
      }
    }
  }
}
