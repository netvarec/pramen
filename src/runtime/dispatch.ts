// Dispatch — resolves a handler by name and runs it with a fresh, ACL-scoped Db.
// Mutations run inside storage.transaction(), which commits on success and rolls
// back on throw — the platform-correct expression of the prior runtime's "mutations auto-wrap
// in BEGIN/COMMIT" invariant. (DO SQLite rejects raw BEGIN/COMMIT because it does
// atomic write coalescing under this API.) Single-writer serialization is free:
// a Durable Object processes one request at a time.
//
// The result reports `touched` (tables the run read or wrote) so the live-query
// layer can match a mutation's writes against each subscription's reads.

import { Db } from "./db";
import type { AclContext } from "./acl";
import type { HandlerContext, HandlerKind, HandlerMap } from "../sdk/handlers";

export interface DispatchResult {
  readonly result: unknown;
  readonly kind: HandlerKind;
  readonly touched: string[];
}

export async function dispatch(
  handlers: HandlerMap,
  storage: DurableObjectStorage,
  acl: AclContext,
  name: string,
  input: unknown,
): Promise<DispatchResult> {
  const handler = handlers[name];
  if (!handler) throw new Error(`unknown handler: ${name}`);

  const db = new Db(storage.sql, acl);
  const ctx: HandlerContext = { db, identity: acl.identity };

  const result =
    handler.kind === "query"
      ? await handler.run(ctx, input)
      : await storage.transaction(async () => handler.run(ctx, input));

  return { result, kind: handler.kind, touched: [...db.touched] };
}
