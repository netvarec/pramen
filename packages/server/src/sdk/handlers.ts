// Handler factories — `query()` and `mutation()`. A query reads; a mutation is
// wrapped in BEGIN/COMMIT by the dispatcher and
// rolls back on throw (see runtime/dispatch.ts).

import type { Db } from "../runtime/db";
import type { Driver } from "../runtime/driver";
import type { Kv } from "../runtime/kv";
import type { Mail } from "../runtime/mail";
import type { Queue } from "../runtime/queue";
import type { Identity } from "./acl";
import type { Files } from "./files";
import type { SchemaDef } from "./schema";

export interface HandlerContext<S extends SchemaDef = SchemaDef> {
  /** Schema-typed repository: find/insert/update/delete inferred from S. */
  readonly db: Db<S>;
  /** Project KV — global (cross-tenant) config/flags/cache. Not per-tenant
   * (that's db) and not transactional. */
  readonly kv: Kv;
  /** Per-tenant file storage: mint signed upload/download urls, head/delete blobs.
   * Bytes flow through the Worker /files/* route, never through the DO. */
  readonly files: Files;
  /** Send email: `ctx.mail.send({ to, subject, text/html })`. On Cloudflare this is
   * Cloudflare Email Sending (the `send_email` binding); off-platform / unconfigured it
   * captures instead of sending. Prefer enqueuing the send as a task (see `ctx.tasks`)
   * so it runs off the single-writer write path. */
  readonly mail: Mail;
  /** The Worker/DO environment — bindings (KV, R2, DB, …) plus vars and secrets
   * (AUTH_SECRET, plus anything in wrangler.jsonc / .dev.vars / `wrangler secret`).
   * Use it to call external services from handlers — Cloudflare bindings (e.g. the
   * `send_email` binding for Cloudflare Email Sending) or third-party APIs (Stripe, …). Loosely typed;
   * cast a value at the use site, e.g. `ctx.env.STRIPE_SECRET_KEY as string`. */
  readonly env: Readonly<Record<string, unknown>>;
  /** Resolved identity for this request (null = anonymous). */
  readonly identity: Identity | null;
  /** Deferred side-effects (a transactional outbox). `tasks.enqueue` persists a task
   * row in the SAME transaction as a mutation (atomic with the data write); a drainer
   * runs the matching `app.tasks` handler after commit, off the write path, with
   * retry. For notification email, webhooks, etc. — see `app.tasks`. */
  readonly tasks: Tasks;
  /** Enqueue onto a native Cloudflare Queue: `ctx.queue.send("jobs", body)`. Unlike
   * `ctx.tasks` (a transactional outbox, atomic with the mutation, drained in-process),
   * a queue send is NOT transactional with the write but is higher-throughput, with
   * platform-native batching/retry/DLQ and a consumer that may live in another Worker.
   * Declare queues in oblaka.ts; consume them via `app.queues`. */
  readonly queue: Queue;
}

/** Context handed to each `app.bootstrap` function. A privileged, SYSTEM-scoped `Db` (ACL
 * bypassed) plus the raw driver, available once schema migration has run on boot. Use it to
 * reconcile CODE-DEFINED reference data — content types, block types, roles, feature flags —
 * into the store, so a fresh / reprovisioned database converges to what the repo declares
 * instead of depending on rows someone created by hand. */
export interface BootstrapContext<S extends SchemaDef = SchemaDef> {
  /** System-scoped Db (ACL bypassed), scoped to `partition`. */
  readonly db: Db<S>;
  /** Raw driver — for `driver.transaction(...)` or bespoke SQL. */
  readonly driver: Driver;
  readonly schema: S;
  /** The partition being booted. On the DO path bootstrap runs ONLY for the default
   * partition (reference data lives there); on the D1 path it is always the default. */
  readonly partition: string;
}

/** An idempotent reconcile run once after `migrate()` on each boot (a DO's first fetch, or a
 * Worker/D1 isolate init). It MUST be safe to run repeatedly — upsert by a stable key, never
 * blind-insert. A thrown error is logged and swallowed so a broken reconcile can't brick a
 * tenant's boot; it simply retries on the next boot. Set as `app.bootstrap`. */
export type BootstrapFn = (ctx: BootstrapContext) => void | Promise<void>;

/** The deferred-side-effects facade handed to handlers as `ctx.tasks`. */
export interface Tasks {
  /** Enqueue a task to run after commit. `kind` selects the `app.tasks` handler;
   * `payload` is JSON-serialized. `delayMs` defers when it becomes due. */
  enqueue(opts: { kind: string; payload?: unknown; delayMs?: number }): Promise<void>;
}

/** Idempotency metadata for a task delivery. `id` is stable across retries — record it
 * to dedupe the rare duplicate (delivery is at-least-once). `attempts` is 1-based. */
export interface TaskMeta {
  id: string;
  attempts: number;
}

/** An app task handler — runs a deferred side effect for one `kind` (e.g. send an
 * email via `ctx.env.EMAIL`). Throwing schedules a retry (capped, then dead-lettered).
 * Receives a privileged, system-scoped context plus the task's idempotency `meta`.
 * Register handlers in `app.tasks`. */
export type TaskHandler = (ctx: HandlerContext, payload: unknown, meta: TaskMeta) => void | Promise<void>;
/** Map of `kind` → handler. Set as `app.tasks`; drained by the DO alarm / a Cron. */
export type AppTaskMap = Record<string, TaskHandler>;

export type HandlerKind = "query" | "mutation";

/** Authorization required to CALL a handler, enforced BEFORE its body runs. This is
 * distinct from the row-level ACL (which gates `ctx.db`): use it to gate handlers that
 * touch `ctx.kv`/`ctx.env`/`ctx.mail`/`ctx.tasks` directly — those bypass the ACL, so an
 * un-gated such handler is callable by anyone (incl. anonymous) on an open tenant. Forms:
 *   - `"authenticated"` — any non-anonymous caller (identity != null)
 *   - `string[]`        — the caller must hold one of these roles
 *   - `(identity) => boolean` — a custom predicate
 * Absent ⇒ open (the prior behavior; a `ctx.db` handler is still ACL-gated). */
export type HandlerAuth = "authenticated" | readonly string[] | ((identity: Identity | null) => boolean);

/** Evaluate a handler's `auth` requirement against the caller's identity. */
export function authorizeHandler(auth: HandlerAuth, identity: Identity | null): boolean {
  if (auth === "authenticated") return identity != null;
  if (typeof auth === "function") return auth(identity);
  if (!identity) return false; // a role list can never be satisfied by an anonymous caller
  const roles = Array.isArray(identity.roles) ? identity.roles : [];
  const held = identity.role ? [identity.role, ...roles] : roles;
  return auth.some((r) => held.includes(r));
}

export interface Handler<I = unknown, O = unknown> {
  readonly kind: HandlerKind;
  // Stored handlers are schema-agnostic; createApp() binds the typed surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly run: (ctx: HandlerContext<any>, input: I) => O | Promise<O>;
  /** Optional boundary validator: parse/validate the raw request input, throwing
   * to reject (surfaced as a 400). Its return type fixes the handler's input. */
  readonly input?: (raw: unknown) => unknown;
  /** Optional DO partition this handler runs in (static, server-side). The Worker
   * routes the request to the matching partition-DO before dispatch. Absent ⇒ the
   * default partition (routed to the bare tenant key). */
  readonly partition?: string;
  /** Optional call-authorization, enforced before the handler runs (see HandlerAuth). */
  readonly auth?: HandlerAuth;
}

export interface HandlerOpts<I> {
  input?: (raw: unknown) => I;
  /** DO partition this handler runs in. Absent ⇒ the default partition. */
  partition?: string;
  /** Authorization to CALL this handler (see HandlerAuth) — gate non-`ctx.db` handlers. */
  auth?: HandlerAuth;
}

// Standalone (schema-agnostic) handler factories. Prefer createApp(schema) for a
// typed ctx.db; these remain for untyped/ad-hoc use.
export function query<I = unknown, O = unknown>(
  run: (ctx: HandlerContext, input: I) => O | Promise<O>,
  opts?: HandlerOpts<I>,
): Handler<I, O> {
  return { kind: "query", run, input: opts?.input, partition: opts?.partition, auth: opts?.auth };
}

export function mutation<I = unknown, O = unknown>(
  run: (ctx: HandlerContext, input: I) => O | Promise<O>,
  opts?: HandlerOpts<I>,
): Handler<I, O> {
  return { kind: "mutation", run, input: opts?.input, partition: opts?.partition, auth: opts?.auth };
}

// Registry of handlers keyed by RPC name. Uses `any` for the per-handler input/
// output so handlers with concrete, differing signatures remain assignable
// (a precise union would break under contravariance).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerMap = Record<string, Handler<any, any>>;
