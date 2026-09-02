// @pramen/server/worker — the DEPLOY entry. This is the only entry that pulls in
// the Durable Object (and thus `cloudflare:workers`), so it is kept separate from
// the main authoring entry: tools that merely load an app.ts to read its schema
// (the CLI, tests, codegen) import from "@pramen/server" and never drag in the DO
// runtime. A Worker's entry imports createPramen from here.

// `RouteContext` stays exported (it predates nothing — @pramen/auth's OIDC routes are
// typed against it); `WorkerOpts` goes with the reverted basePath.
export { createPramen, type PramenApp, type PublicRoute, type RouteContext, type Env, type DoEnv } from "./pramen";
export { makeWorker, callPrivileged } from "./worker";
export { pramenDO, PramenDOBase } from "./durable-object";
