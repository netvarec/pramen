// @pramen/server — the authoring entry: schema, handlers, ACL, files, errors, and
// the substrate seam. A pramen project is just an app.ts (schema + handlers + ACL),
// an oblaka.ts (topology), and a 3-line Worker entry.
//
// The deploy half — createPramen / the Durable Object — lives at "@pramen/server/worker"
// (see worker-entry.ts). It is split off because it imports `cloudflare:workers`,
// which only exists in the Workers runtime; keeping it separate lets the CLI, tests,
// and codegen load an app.ts for its schema without dragging in the DO runtime.

// --- schema authoring ---
export { Entity, defineSchema, renamedFrom, notNull, unique, indexed, hidden, defaultTo, primaryKey, generated, expr, ExprDefault } from "./sdk/schema";
export { isValidUuid } from "./sdk/uuid";
export type {
  DefaultValue,
  FieldType,
  FieldDef,
  EntityFields,
  EntityDef,
  SchemaDef,
  RelationDef,
  RelationDefs,
  BelongsToDef,
  HasManyDef,
} from "./sdk/schema";

// --- app + handlers ---
export { createApp } from "./sdk/app";
export { query, mutation } from "./sdk/handlers";
export type { Handler, HandlerContext, HandlerKind, HandlerMap, HandlerOpts } from "./sdk/handlers";

// --- ACL ---
export { $identity, $input, allow, deny, policy, resolve, role, isAllow, isDeny, isResolver, isIdentityMarker, isInputMarker } from "./sdk/acl";
export type {
  Action,
  Identity,
  IdentityMarker,
  InputMarker,
  Policy,
  PolicyRule,
  PolicyRules,
  Role,
  Validator,
  WhereRule,
  ConditionalFields,
  FieldsFn,
  RelationAclRule,
  SetValue,
  ResolverFn,
  ResolverContext,
  ResolverDb,
} from "./sdk/acl";

// --- inference (types only) ---
export type {
  Cell,
  FieldsOf,
  InferInsert,
  InferRow,
  InferUpdate,
  JsonValue,
  ProjectedRow,
  RelationsOf,
  RelationsResult,
  WhereClause,
  WhereInput,
  WhereOps,
} from "./sdk/infer";

// --- files ---
export type { FileRef, Files, SignUploadOpts, SignDownloadOpts, HeadResult } from "./sdk/files";
export { R2Adapter, MemoryAdapter, createFiles, handleFileRequest } from "./runtime/storage";
export type { StorageAdapter, PutResult, GetResult } from "./runtime/storage";

// --- errors ---
export { PramenError, BadRequest, Unauthorized, Forbidden } from "./runtime/errors";

// --- substrate seam (advanced: bring your own SQL backend) ---
export { sqliteDialect, postgresDialect, DoSqliteDriver, D1Driver } from "./runtime/driver";
export type { Driver, Dialect, Row } from "./runtime/driver";
