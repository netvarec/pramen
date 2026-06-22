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
  /** Migration hint: this column was previously named X. On boot the migrator
   * rebuilds the table, copying data from the old column. A diff cannot tell a
   * rename from a drop+add, so the rename must be declared explicitly. */
  readonly renamedFrom?: string;
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

export interface EntityDef<F extends EntityFields = EntityFields, R extends RelationDefs = Record<string, never>> {
  readonly fields: F;
  readonly relations: R;
}

export function Entity<F extends EntityFields, R extends RelationDefs = Record<string, never>>(
  build: (t: FieldBuilders) => F,
  relations?: (r: RelationBuilders) => R,
): EntityDef<F, R> {
  return { fields: build(builders), relations: (relations ? relations(relationBuilders) : {}) as R };
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

/** Give the column a DEFAULT (a literal) — also makes it optional on insert. */
export function defaultTo<F extends FieldDef, D extends DefaultValue>(field: F, value: D): F & { readonly default: D } {
  return { ...field, default: value };
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
