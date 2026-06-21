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
import type { SchemaDef } from "./sdk/schema";
import type { HandlerMap } from "./sdk/handlers";
import type { Role } from "./sdk/acl";

/** The user-facing app: a schema, the handler map, and (optionally) ACL roles.
 * `example/app.ts` exports exactly this shape. */
export interface PramenApp {
  schema: SchemaDef;
  handlers: HandlerMap;
  acl?: Role[];
}

export type { Env, DoEnv };

/** Build the deployable pair for an app. */
export function createPramen(app: PramenApp): {
  fetch: (request: Request, env: Env) => Promise<Response>;
  PramenDO: ReturnType<typeof pramenDO>;
} {
  return { fetch: makeWorker(app).fetch, PramenDO: pramenDO(app) };
}
