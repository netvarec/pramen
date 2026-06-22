// Type-level inference from a schema's field definitions: WhereInput / InferInsert
// / InferRow. Pure types; erased at runtime. Relies on field builders preserving
// literals (`as const`), so e.g.
// `t.id()` is `{ type: "integer"; primaryKey: true; autoIncrement: true; notNull: true }`.

import type { DefaultValue, EntityDef, EntityFields, FieldDef, RelationDefs, SchemaDef } from "./schema";
import type { FileRef } from "./files";

export type { FileRef } from "./files";

/** Any JSON-serializable value — the type of a `t.json()` column. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** SQL field type -> TypeScript value type. */
export type FieldTsType<D extends FieldDef> = D["type"] extends "text"
  ? string
  : D["type"] extends "boolean"
    ? boolean
    : D["type"] extends "json"
      ? JsonValue
      : D["type"] extends "fileRef"
        ? FileRef
        : D["type"] extends "uuid"
          ? string
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

// --- relation-aware where (a relation key takes a nested clause over its target,
// compiled to a security-scoped subquery). Depth-bounded so the type stays finite
// under cyclic relations (e.g. user.notes ↔ note.owner). The bound matches the
// runtime MAX_REL_DEPTH in runtime/acl.ts — keep the two in lockstep. ---

type PrevDepth = [never, 0, 1, 2, 3, 4, 5];
type RelTargetTable<S extends SchemaDef, R> = R extends { target: infer Tg } ? (Tg extends keyof S ? Tg : never) : never;

/** A `where` clause: column predicates + AND/OR, plus relation keys that take a
 * nested `WhereClause` over the related entity (traversal). */
export type WhereClause<S extends SchemaDef, T extends keyof S, D extends number = 5> = WhereInput<FieldsOf<S[T]>> &
  ([D] extends [never]
    ? object
    : {
        // Remap away the `string`/`number` index keys so a relationless entity
        // (RelationsOf = Record<string, never>) contributes `{}`, not an index
        // signature that would reject every column key in the WhereInput half.
        [K in keyof RelationsOf<S[T]> as string extends K ? never : number extends K ? never : K]?: WhereClause<
          S,
          RelTargetTable<S, RelationsOf<S[T]>[K]>,
          PrevDepth[D]
        >;
      });

/** Patch input for updates: every column optional, value typed (nullable). */
export type InferUpdate<F extends EntityFields> = Partial<{ [K in keyof F]: FieldTsType<F[K]> | null }>;

// Insert: a NOT NULL column is required unless it's auto-generated (autoIncrement,
// or a `generated()` uuid the runtime mints) or has a DEFAULT (the DB fills it);
// everything else is optional.
type RequiredInsertKeys<F extends EntityFields> = {
  [K in keyof F]: IsNotNull<F[K]> extends true
    ? F[K] extends { autoIncrement: true }
      ? never
      : F[K] extends { generated: true }
        ? never
        : F[K] extends { default: DefaultValue }
          ? never
          : K
    : never;
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

