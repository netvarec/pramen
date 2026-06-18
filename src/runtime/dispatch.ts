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
import { warmup, type AclContext } from "./acl";
import { BadRequest } from "./errors";
import type { ResolverDb } from "../sdk/acl";
import type { SchemaDef } from "../sdk/schema";
import type { HandlerContext, HandlerKind, HandlerMap } from "../sdk/handlers";

export interface DispatchResult {
  readonly result: unknown;
  readonly kind: HandlerKind;
  readonly touched: string[];
}

export async function dispatch(
  handlers: HandlerMap,
  schema: SchemaDef,
  storage: DurableObjectStorage,
  acl: AclContext,
  name: string,
  input: unknown,
): Promise<DispatchResult> {
  const handler = handlers[name];
  if (!handler) throw new BadRequest(`unknown handler: ${name}`);

  // Validate/parse the request input at the boundary, if the handler declares it.
  let parsed = input;
  if (handler.input) {
    try {
      parsed = handler.input(input);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : "invalid input");
    }
  }

  // Warmup: evaluate dynamic resolvers once, reading through a SYSTEM-mode db
  // (separate from the handler's db, so its reads don't pollute `touched`).
  const systemDb = new Db(storage.sql, { acl: acl.acl, identity: acl.identity, system: true }, schema);
  const resolved = await warmup(acl.acl, acl.identity, systemDb as unknown as ResolverDb);

  const db = new Db(storage.sql, { acl: acl.acl, identity: acl.identity, resolved }, schema);
  const ctx: HandlerContext = { db, identity: acl.identity };

  const result =
    handler.kind === "query"
      ? await handler.run(ctx, parsed)
      : await storage.transaction(async () => handler.run(ctx, parsed));

  return { result, kind: handler.kind, touched: [...db.touched] };
}
