// Type-level inference from a schema's field definitions: WhereInput / InferInsert
// / InferRow. Pure types; erased at runtime. Relies on field builders preserving
// literals (`as const`), so e.g.
// `t.id()` is `{ type: "integer"; primaryKey: true; autoIncrement: true; notNull: true }`.

import type { EntityDef, EntityFields, FieldDef, RelationDefs, SchemaDef } from "./schema";

/** SQL field type -> TypeScript value type. */
export type FieldTsType<D extends FieldDef> = D["type"] extends "text"
  ? string
  : D["type"] extends "boolean"
    ? boolean
    : number; // integer | real

/** A column is non-null iff it's NOT NULL or a primary key. */
type IsNotNull<D extends FieldDef> = D extends { notNull: true }
  ? true
  : D extends { primaryKey: true }
    ? true
    : false;

export type Cell<D extends FieldDef> = IsNotNull<D> extends true ? FieldTsType<D> : FieldTsType<D> | null;

/** Row shape returned from reads. */
export type InferRow<F extends EntityFields> = { [K in keyof F]: Cell<F[K]> };

/** A row whose fields may be projected away by field-level (incl. cell-level) ACL:
 * every column optional. The honest type for a handler that reads through a policy
 * which can drop columns per row — `InferRow` over-claims presence by design. */
export type ProjectedRow<F extends EntityFields> = { [K in keyof F]?: Cell<F[K]> };

/** Operators available on a column predicate. `like` is string-only. */
export interface WhereOps<V> {
  eq?: V | null;
  ne?: V | null;
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
  in?: V[];
  notIn?: V[];
  like?: V extends string ? string : never;
  isNull?: boolean;
}

/** Predicate input: per-column equality shorthand or an operator object, plus
 * nestable AND/OR groups. */
export type WhereInput<F extends EntityFields> = {
  [K in keyof F]?: FieldTsType<F[K]> | null | WhereOps<FieldTsType<F[K]>>;
} & {
  AND?: WhereInput<F>[];
  OR?: WhereInput<F>[];
};

/** Patch input for updates: every column optional, value typed (nullable). */
export type InferUpdate<F extends EntityFields> = Partial<{ [K in keyof F]: FieldTsType<F[K]> | null }>;

// Insert: NOT NULL columns without a generated value are required; the rest optional.
type RequiredInsertKeys<F extends EntityFields> = {
  [K in keyof F]: IsNotNull<F[K]> extends true ? (F[K] extends { autoIncrement: true } ? never : K) : never;
}[keyof F];
type OptionalInsertKeys<F extends EntityFields> = Exclude<keyof F, RequiredInsertKeys<F>>;

export type InferInsert<F extends EntityFields> = { [K in RequiredInsertKeys<F>]: FieldTsType<F[K]> } & {
  [K in OptionalInsertKeys<F>]?: FieldTsType<F[K]> | null;
};

/** Extract a schema entry's fields, e.g. FieldsOf<S["notes"]>. */
export type FieldsOf<E> = E extends EntityDef<infer F, RelationDefs> ? F : never;

/** Extract a schema entry's relations. */
export type RelationsOf<E> = E extends EntityDef<EntityFields, infer R> ? R : Record<string, never>;

type RelValue<S extends SchemaDef, Rel> = Rel extends { kind: "belongsTo"; target: infer Tg }
  ? Tg extends keyof S
    ? InferRow<FieldsOf<S[Tg]>> | null
    : never
  : Rel extends { kind: "hasMany"; target: infer Tg }
    ? Tg extends keyof S
      ? InferRow<FieldsOf<S[Tg]>>[]
      : never
    : never;

/** The relation properties added to a row by `with`. Optional (present only when selected). */
export type RelationsResult<S extends SchemaDef, T extends keyof S> = Partial<{
  [K in keyof RelationsOf<S[T]>]: RelValue<S, RelationsOf<S[T]>[K]>;
}>;

