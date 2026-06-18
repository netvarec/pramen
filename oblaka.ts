// oblaka IaC — the source of truth for mrak's Cloudflare topology.
//
//   bun run config            generate wrangler.jsonc from this file (local)
//   bun run deploy            provision resources (oblaka --remote) + ship code (wrangler deploy)
//
// `oblaka oblaka.ts` (no --remote) writes wrangler.jsonc into this dir, which
// `wrangler dev`/`wrangler deploy` then consume. `--remote` provisions the Worker
// + Durable Object (and the SQLite DO migration) on Cloudflare; it uploads only a
// placeholder module, so `wrangler deploy` does the actual code bundle + upload.

import { define, DurableObject, Worker } from "oblaka-iac";

export default define(({ env }) => {
  // AUTH_SECRET: a dev value locally; in real envs set it as a secret with
  // `wrangler secret put AUTH_SECRET` (a secret overrides this var at runtime).
  const vars = env === "local" ? { AUTH_SECRET: "dev-secret-change-me" } : {};

  return new Worker({
    dir: ".",
    name: "mrak",
    main: "./src/index.ts",
    compatibility_date: "2026-06-18",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true },
    bindings: {
      // The DO is the database. oblaka emits the binding + the SQLite migration
      // (new_sqlite_classes: ["MrakDO"]) into wrangler.jsonc automatically.
      MRAK: new DurableObject({ name: "mrak-store", className: "MrakDO" }),
    },
    vars,
  });
});
