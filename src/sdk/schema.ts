// Schema definition — the portable layer. Mirrors the prior runtime's `Entity(it => ({...}))`
// factory and `defineSchema({...})`. Field builders return `as const` literals so
// the exact field shape survives into the type system; sdk/infer.ts turns that
// shape into row/where/insert types.

export type FieldType = "text" | "integer" | "real" | "boolean";

export interface FieldDef {
  readonly type: FieldType;
  readonly primaryKey?: boolean;
  readonly autoIncrement?: boolean;
  readonly notNull?: boolean;
}

const builders = {
  id: () => ({ type: "integer", primaryKey: true, autoIncrement: true, notNull: true }) as const,
  text: () => ({ type: "text" }) as const,
  int: () => ({ type: "integer" }) as const,
  real: () => ({ type: "real" }) as const,
  bool: () => ({ type: "boolean" }) as const,
};

export type FieldBuilders = typeof builders;
export type EntityFields = Record<string, FieldDef>;

export interface EntityDef<F extends EntityFields = EntityFields> {
  readonly fields: F;
}

export function Entity<F extends EntityFields>(build: (t: FieldBuilders) => F): EntityDef<F> {
  return { fields: build(builders) };
}

export type SchemaDef = Record<string, EntityDef>;

export function defineSchema<S extends SchemaDef>(entities: S): S {
  return entities;
}
