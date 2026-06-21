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
   * Use it to call external APIs from handlers (Stripe, Resend, …). Loosely typed;
   * cast a value at the use site, e.g. `ctx.env.STRIPE_SECRET_KEY as string`. */
  readonly env: Readonly<Record<string, unknown>>;
  /** Resolved identity for this request (null = anonymous). */
  readonly identity: Identity | null;
}

export type HandlerKind = "query" | "mutation";

export interface Handler<I = unknown, O = unknown> {
  readonly kind: HandlerKind;
  // Stored handlers are schema-agnostic; createApp() binds the typed surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly run: (ctx: HandlerContext<any>, input: I) => O | Promise<O>;
  /** Optional boundary validator: parse/validate the raw request input, throwing
   * to reject (surfaced as a 400). Its return type fixes the handler's input. */
  readonly input?: (raw: unknown) => unknown;
}

export interface HandlerOpts<I> {
  input?: (raw: unknown) => I;
}

// Standalone (schema-agnostic) handler factories. Prefer createApp(schema) for a
// typed ctx.db; these remain for untyped/ad-hoc use.
export function query<I = unknown, O = unknown>(
  run: (ctx: HandlerContext, input: I) => O | Promise<O>,
  opts?: HandlerOpts<I>,
): Handler<I, O> {
  return { kind: "query", run, input: opts?.input };
}

export function mutation<I = unknown, O = unknown>(
  run: (ctx: HandlerContext, input: I) => O | Promise<O>,
  opts?: HandlerOpts<I>,
): Handler<I, O> {
  return { kind: "mutation", run, input: opts?.input };
}

// Registry of handlers keyed by RPC name. Uses `any` for the per-handler input/
// output so handlers with concrete, differing signatures remain assignable
// (a precise union would break under contravariance).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerMap = Record<string, Handler<any, any>>;
