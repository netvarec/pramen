// Handler factories — `query()` and `mutation()`. A query reads; a mutation is
// wrapped in BEGIN/COMMIT by the dispatcher and
// rolls back on throw (see runtime/dispatch.ts).

import type { Db } from "../runtime/db";
import type { Kv } from "../runtime/kv";
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
}

/** The deferred-side-effects facade handed to handlers as `ctx.tasks`. */
export interface Tasks {
  /** Enqueue a task to run after commit. `kind` selects the `app.tasks` handler;
   * `payload` is JSON-serialized. `delayMs` defers when it becomes due. */
  enqueue(opts: { kind: string; payload?: unknown; delayMs?: number }): Promise<void>;
}

/** An app task handler — runs a deferred side effect for one `kind` (e.g. send an
 * email via `ctx.env.EMAIL`). Throwing schedules a retry (capped, then dead-lettered).
 * It receives a privileged, system-scoped context. Register handlers in `app.tasks`. */
export type TaskHandler = (ctx: HandlerContext, payload: unknown) => void | Promise<void>;
/** Map of `kind` → handler. Set as `app.tasks`; drained by the DO alarm / a Cron. */
export type AppTaskMap = Record<string, TaskHandler>;

export type HandlerKind = "query" | "mutation";

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
}

export interface HandlerOpts<I> {
  input?: (raw: unknown) => I;
  /** DO partition this handler runs in. Absent ⇒ the default partition. */
  partition?: string;
}

// Standalone (schema-agnostic) handler factories. Prefer createApp(schema) for a
// typed ctx.db; these remain for untyped/ad-hoc use.
export function query<I = unknown, O = unknown>(
  run: (ctx: HandlerContext, input: I) => O | Promise<O>,
  opts?: HandlerOpts<I>,
): Handler<I, O> {
  return { kind: "query", run, input: opts?.input, partition: opts?.partition };
}

export function mutation<I = unknown, O = unknown>(
  run: (ctx: HandlerContext, input: I) => O | Promise<O>,
  opts?: HandlerOpts<I>,
): Handler<I, O> {
  return { kind: "mutation", run, input: opts?.input, partition: opts?.partition };
}

// Registry of handlers keyed by RPC name. Uses `any` for the per-handler input/
// output so handlers with concrete, differing signatures remain assignable
// (a precise union would break under contravariance).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerMap = Record<string, Handler<any, any>>;
