// Handler factories — mirrors the prior runtime's `query()` / `mutation()` from the server library.
// A query reads; a mutation is wrapped in BEGIN/COMMIT by the dispatcher and
// rolls back on throw (see runtime/dispatch.ts).

import type { Db } from "../runtime/db";

export interface HandlerContext {
  readonly db: Db;
  /** Resolved identity — wired to ACL later; null for now. */
  readonly identity: Record<string, unknown> | null;
}

export type HandlerKind = "query" | "mutation";

export interface Handler<I = unknown, O = unknown> {
  readonly kind: HandlerKind;
  readonly run: (ctx: HandlerContext, input: I) => O | Promise<O>;
}

export function query<I = unknown, O = unknown>(
  run: (ctx: HandlerContext, input: I) => O | Promise<O>,
): Handler<I, O> {
  return { kind: "query", run };
}

export function mutation<I = unknown, O = unknown>(
  run: (ctx: HandlerContext, input: I) => O | Promise<O>,
): Handler<I, O> {
  return { kind: "mutation", run };
}

// Registry of handlers keyed by RPC name. Uses `any` for the per-handler input/
// output so handlers with concrete, differing signatures remain assignable
// (a precise union would break under contravariance).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerMap = Record<string, Handler<any, any>>;
