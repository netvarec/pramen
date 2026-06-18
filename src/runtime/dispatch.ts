// Dispatch — resolves a handler by name and runs it. Mutations run inside
// storage.transaction(), which commits on success and rolls back on throw —
// the platform-correct expression of the prior runtime's "mutations auto-wrap in
// BEGIN/COMMIT" invariant. (DO SQLite rejects raw BEGIN/COMMIT precisely
// because it does atomic write coalescing under this API.) Single-writer
// serialization is free: a Durable Object processes one request at a time.

import type { Db } from "./db";
import type { HandlerContext, HandlerMap } from "../sdk/handlers";

export async function dispatch(
  handlers: HandlerMap,
  db: Db,
  storage: DurableObjectStorage,
  name: string,
  input: unknown,
): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) throw new Error(`unknown handler: ${name}`);

  const ctx: HandlerContext = { db, identity: null };

  if (handler.kind === "query") {
    return await handler.run(ctx, input);
  }

  return await storage.transaction(async () => handler.run(ctx, input));
}
