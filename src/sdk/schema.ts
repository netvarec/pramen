// Schema definition — the portable layer. Mirrors the prior runtime's `Entity(it => ({...}))`
// factory and `defineSchema({...})`. No platform dependency; this is what stays
// identical whether the substrate is Rust+Turso or Worker+Durable Object.

export type FieldType = "text" | "integer" | "real" | "boolean";

export interface FieldDef {
  readonly type: FieldType;
  readonly primaryKey?: boolean;
  readonly autoIncrement?: boolean;
  readonly notNull?: boolean;
}

const builders = {
  id: (): FieldDef => ({ type: "integer", primaryKey: true, autoIncrement: true, notNull: true }),
  text: (): FieldDef => ({ type: "text" }),
  int: (): FieldDef => ({ type: "integer" }),
  real: (): FieldDef => ({ type: "real" }),
  bool: (): FieldDef => ({ type: "boolean" }),
};

export type FieldBuilders = typeof builders;
export type EntityFields = Record<string, FieldDef>;

export interface EntityDef {
  readonly fields: EntityFields;
}

export function Entity(build: (t: FieldBuilders) => EntityFields): EntityDef {
  return { fields: build(builders) };
}

export type SchemaDef = Record<string, EntityDef>;

export function defineSchema<S extends SchemaDef>(entities: S): S {
  return entities;
}
