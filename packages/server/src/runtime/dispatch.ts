// Dispatch — resolves a handler by name and runs it with a fresh, ACL-scoped Db.
// Mutations run inside storage.transaction(), which commits on success and rolls
// back on throw — the platform-correct way to auto-wrap mutations in BEGIN/COMMIT.
// (DO SQLite rejects raw BEGIN/COMMIT because it does atomic write coalescing under
// this API.) Single-writer serialization is free:
// a Durable Object processes one request at a time.
//
// The result reports `touched` (tables the run read or wrote) so the live-query
// layer can match a mutation's writes against each subscription's reads.

import { Db } from "./db";
import { warmup, type AclContext } from "./acl";
import { BadRequest } from "./errors";
import { enqueueTask, type TaskMap } from "./outbox";
import type { Driver } from "./driver";
import type { Kv } from "./kv";
import type { Files } from "../sdk/files";
import type { ResolverDb } from "../sdk/acl";
import type { SchemaDef } from "../sdk/schema";
import type { AppTaskMap, HandlerContext, HandlerKind, HandlerMap, Tasks } from "../sdk/handlers";

export interface DispatchResult {
  readonly result: unknown;
  readonly kind: HandlerKind;
  readonly touched: string[];
  /** Number of tasks the handler enqueued — the DO uses this to arm its drain alarm. */
  readonly enqueued: number;
}

/** The `ctx.tasks` facade over the outbox. `onEnqueue` lets the caller count enqueues
 * so it can wake the drainer. */
export function tasksFacade(driver: Driver, onEnqueue?: () => void): Tasks {
  return {
    enqueue: async (opts) => {
      await enqueueTask(driver, Date.now(), opts);
      onEnqueue?.();
    },
  };
}

/** Bind `app.tasks` (which take a ctx) into the ctx-free `TaskMap` the drainer calls. */
export function bindTasks(appTasks: AppTaskMap | undefined, ctx: HandlerContext): TaskMap {
  const out: TaskMap = {};
  for (const [kind, handler] of Object.entries(appTasks ?? {})) out[kind] = (payload, meta) => handler(ctx, payload, meta);
  return out;
}

export async function dispatch(
  handlers: HandlerMap,
  schema: SchemaDef,
  driver: Driver,
  kv: Kv,
  files: Files,
  env: Readonly<Record<string, unknown>>,
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
  const systemDb = new Db(driver, { acl: acl.acl, identity: acl.identity, system: true, schema, partition: acl.partition }, schema);
  const resolved = await warmup(acl.acl, acl.identity, systemDb as unknown as ResolverDb);

  const db = new Db(driver, { acl: acl.acl, identity: acl.identity, input: parsed, resolved, schema, partition: acl.partition }, schema);
  let enqueued = 0;
  const ctx: HandlerContext = { db, kv, files, env, identity: acl.identity, tasks: tasksFacade(driver, () => enqueued++) };

  const result =
    handler.kind === "query"
      ? await handler.run(ctx, parsed)
      : await driver.transaction(async () => handler.run(ctx, parsed));

  // Both explicit ctx.tasks.enqueue and declarative trigger enqueues (in db) count.
  return { result, kind: handler.kind, touched: [...db.touched], enqueued: enqueued + db.taskEnqueues };
}
