// @pramen/server — the authoring entry: schema, handlers, ACL, files, errors, and
// the substrate seam. A pramen project is just an app.ts (schema + handlers + ACL),
// an oblaka.ts (topology), and a 3-line Worker entry.
//
// The deploy half — createPramen / the Durable Object — lives at "@pramen/server/worker"
// (see worker-entry.ts). It is split off because it imports `cloudflare:workers`,
// which only exists in the Workers runtime; keeping it separate lets the CLI, tests,
// and codegen load an app.ts for its schema without dragging in the DO runtime.

// --- schema authoring ---
export { Entity, defineSchema, renamedFrom, notNull, unique, indexed, hidden, defaultTo, primaryKey, generated, expr, ExprDefault, trigger, partitionOf, DEFAULT_PARTITION } from "./sdk/schema";
export type { TriggerDef, TriggerOp } from "./sdk/schema";
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
  ManyToManyDef,
  OneHasOneDef,
  OneHasOneInverseDef,
  OnDelete,
} from "./sdk/schema";

// --- app + handlers ---
export { createApp } from "./sdk/app";
export { query, mutation, authorizeHandler } from "./sdk/handlers";
export type { EnvBag, Handler, HandlerContext, HandlerKind, HandlerMap, HandlerOpts, HandlerAuth, Tasks, TaskHandler, AppTaskMap, BootstrapContext, BootstrapFn } from "./sdk/handlers";

// --- ACL ---
export { $identity, $input, $now, allow, deny, policy, resolve, role, isAllow, isDeny, isResolver, isIdentityMarker, isInputMarker, isNowMarker } from "./sdk/acl";
export type {
  Action,
  Identity,
  IdentityMarker,
  InputMarker,
  NowMarker,
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
  JsonObject,
  SqlValue,
  CellValue,
  Row,
  ProjectedRow,
  RelationsOf,
  RelationsResult,
  WhereClause,
  WhereInput,
  WhereOps,
} from "./sdk/infer";

// --- kv (ctx.kv) + session denylist (hard token revocation) ---
export { Kv, denySession, allowSession, isSessionDenied } from "./runtime/kv";

// --- files ---
export type { FileRef, Files, SignUploadOpts, SignDownloadOpts, HeadResult } from "./sdk/files";
export { R2Adapter, MemoryAdapter, createFiles, handleFileRequest } from "./runtime/storage";

// Signed capability tokens (HMAC-SHA256) — the machinery behind signed file urls and
// page-preview links. Exported so an app (or @pramen/cms) can mint its own capability url
// without a second signing implementation.
export { signToken, verifyToken, isUsableSecret, resolveSecret, MIN_TOKEN_SECRET_LEN } from "./runtime/token";
export type { ExpiringToken } from "./runtime/token";
export type { StorageAdapter, PutResult, GetResult } from "./runtime/storage";

// --- mail (ctx.mail) ---
export { Mail, CloudflareEmailAdapter, KvMailAdapter, MemoryMailAdapter, UnconfiguredMailAdapter, createMail } from "./runtime/mail";
export type { MailMessage, MailAddress, MailAdapter, SendEmailBinding } from "./runtime/mail";

// --- queue (ctx.queue — Cloudflare Queues) ---
export { Queue, CloudflareQueueAdapter, MemoryQueueAdapter, createQueue, discoverQueueBindings } from "./runtime/queue";
export type { QueueAdapter, QueueProducerBinding, QueueSendOptions, QueueSendRequest, QueueBatchOptions, QueueContentType } from "./runtime/queue";
export { routeQueue, dispatchQueueBatch } from "./runtime/queue-consumer";
export type { QueueContext, QueueHandler, QueueMessage, QueueBatch, AppQueueMap } from "./runtime/queue-consumer";

// --- errors ---
export { PramenError, BadRequest, Unauthorized, Forbidden, Conflict } from "./runtime/errors";

// --- substrate seam (advanced: bring your own SQL backend) ---
export { sqliteDialect, postgresDialect, DoSqliteDriver, D1Driver } from "./runtime/driver";
export type { Driver, Dialect, DriverRow } from "./runtime/driver";
