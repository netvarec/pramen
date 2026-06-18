// Schema definition — the portable layer. Mirrors the prior runtime's `Entity(it => ({...}))`
// factory and `defineSchema({...})`. Field builders return `as const` literals so
// the exact field shape survives into the type system; sdk/infer.ts turns that
// shape into row/where/insert types.
//
// Entities may also declare relations (belongsTo / hasMany) via a second builder.
// Relations reference their target table by name (resolved at runtime) and the
// foreign-key column. Relation traversal is ACL-governed (see runtime/acl.ts).

export type FieldType = "text" | "integer" | "real" | "boolean";

export interface FieldDef {
  readonly type: FieldType;
  readonly primaryKey?: boolean;
  readonly autoIncrement?: boolean;
  readonly notNull?: boolean;
}

const builders = {
  id: () => ({ type: "integer", primaryKey: true, autoIncrement: true, notNull: true }) as const,
  textId: () => ({ type: "text", primaryKey: true, notNull: true }) as const,
  text: () => ({ type: "text" }) as const,
  int: () => ({ type: "integer" }) as const,
  real: () => ({ type: "real" }) as const,
  bool: () => ({ type: "boolean" }) as const,
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

export type SchemaDef = Record<string, EntityDef<EntityFields, RelationDefs>>;

export function defineSchema<S extends SchemaDef>(entities: S): S {
  return entities;
}
