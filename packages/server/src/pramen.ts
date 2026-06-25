// createPramen(app) — the server library entry. Turns an app (schema + handlers +
// ACL) into the two things a Cloudflare deployment needs: a Worker `fetch` and the
// `PramenDO` Durable Object class. A consumer's whole entry is three lines:
//
//   import { createPramen } from "@pramen/server";
//   import { app } from "./app";
//   const pramen = createPramen(app);
//   export default { fetch: pramen.fetch };
//   export const PramenDO = pramen.PramenDO;   // wrangler binds this by class_name
//
// The DO class is produced per-app (pramenDO closes over `app`) because the platform
// constructs a DO with only (ctx, env). PramenApp is defined here and imported
// type-only by worker.ts / durable-object.ts, so there is no runtime import cycle.

import { makeWorker, type Env } from "./worker";
import { pramenDO, type DoEnv } from "./durable-object";
import { validateTriggerTasks, type SchemaDef } from "./sdk/schema";
import type { AppTaskMap, HandlerMap } from "./sdk/handlers";
import type { AppQueueMap, QueueBatch } from "./runtime/queue-consumer";
import type { Role } from "./sdk/acl";

/** Injected into a public route's handler — forward a privileged mutation into the
 * tenant's DO without the handler importing any deploy-side code (so app.ts stays
 * authoring-only). The synthetic identity defaults to the admin role. */
export interface RouteContext {
  callPrivileged(opts: { name: string; input?: unknown; tenant?: string; roles?: string[] }): Promise<Response>;
}

/** A public, pre-auth route — matched before identity resolution, so it can host a
 * signature-authenticated endpoint (e.g. a Stripe webhook) that doesn't fit the
 * JWT-gated /rpc surface. The handler verifies its own auth (a signature), then can
 * `ctx.callPrivileged(...)` to apply a mutation. `env` is loosely typed here so the
 * app definition stays platform-agnostic. */
export interface PublicRoute {
  /** HTTP method to match (e.g. "POST"). */
  method: string;
  /** Exact pathname to match (e.g. "/stripe/webhook"). */
  path: string;
  handler: (request: Request, env: Readonly<Record<string, unknown>>, ctx: RouteContext) => Response | Promise<Response>;
}

/** The user-facing app: a schema, the handler map, ACL roles, and optional public
 * (pre-auth) routes. `example/app.ts` exports this shape. */
export interface PramenApp {
  schema: SchemaDef;
  handlers: HandlerMap;
  acl?: Role[];
  routes?: PublicRoute[];
  /** Deferred side-effect handlers keyed by `kind` — drained from the outbox after a
   * mutation enqueues via `ctx.tasks.enqueue`. For notification email, webhooks, etc. */
  tasks?: AppTaskMap;
  /** Cloudflare Queues consumers keyed by queue name — process messages produced via
   * `ctx.queue.send(...)`. Dispatched by `createPramen(app).queue` (a consumer is
   * Worker-level: no `ctx.db`, reach a tenant via `ctx.callPrivileged`). */
  queues?: AppQueueMap;
}

export type { Env, DoEnv };

/** Build the deployable pair for an app. `scheduled` is a Cron Trigger entry that
 * drains the D1 outbox (the DO path self-drains via an alarm) — wire it only if you
 * use the D1 store with deferred tasks. */
export function createPramen(app: PramenApp): {
  fetch: (request: Request, env: Env) => Promise<Response>;
  scheduled: (event: unknown, env: Env) => Promise<void>;
  queue: (batch: QueueBatch, env: Env) => Promise<void>;
  PramenDO: ReturnType<typeof pramenDO>;
} {
  validateTriggerTasks(app.schema, Object.keys(app.tasks ?? {})); // fail fast on a typo'd trigger task
  const worker = makeWorker(app);
  return { fetch: worker.fetch, scheduled: worker.scheduled, queue: worker.queue, PramenDO: pramenDO(app) };
}
