// `@pramen/server/dev` — tooling helpers, deliberately NOT on the authoring entry point.
//
// `signDevToken` mints an HS256 JWT for local development: the `pramen` and `pramen-cms`
// bins and the repo's test helper all use it. It is kept off `@pramen/server` because its
// secret lookup reads `process.env.AUTH_SECRET`, which does not exist in a deployed
// Worker (bindings and secrets arrive on `env`) — so an app handler importing it from the
// main entry would silently sign with the PUBLISHED dev constant while appearing to honour
// AUTH_SECRET. A separate subpath makes "this is dev tooling" part of the import.

export { signDevToken, DEV_SECRET } from "./runtime/dev-token";
