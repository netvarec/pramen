// oblaka IaC — the source of truth for pramen's Cloudflare topology.
//
//   bun run config            generate wrangler.jsonc from this file (local)
//   bun run deploy            provision resources (oblaka --remote) + ship code (wrangler deploy)
//
// `oblaka oblaka.ts` (no --remote) writes wrangler.jsonc into this dir, which
// `wrangler dev`/`wrangler deploy` then consume. `--remote` provisions the Worker
// + Durable Object (and the SQLite DO migration) on Cloudflare; it uploads only a
// placeholder module, so `wrangler deploy` does the actual code bundle + upload.

import { define, D1Database, DurableObject, EmailService, KVNamespace, R2Bucket, Worker } from "oblaka-iac";

// One name to namespace every resource this project owns. Cloudflare resource
// names are account-global, so set a unique PROJECT per app and all its resources
// (Worker, DO, KV) get distinct names — many pramen projects coexist in one account.
const PROJECT = "pramen";

export default define(({ env }) => {
  // AUTH_SECRET: a dev value locally; in real envs set it as a secret with
  // `wrangler secret put AUTH_SECRET` (a secret overrides this var at runtime).
  const vars =
    env === "local"
      ? {
          AUTH_SECRET: "dev-secret-change-me",
          FILES_SECRET: "dev-files-secret-change-me",
          CORS_ORIGINS: "*",
          // Local dev applies destructive migrations freely; production must opt in.
          PRAMEN_ALLOW_DESTRUCTIVE: "true",
          // Where the magic-link lands in your frontend (the example builds
          // `${APP_URL}/auth?token=…`). MAIL_FROM is intentionally unset locally;
          // MAIL_CAPTURE opts ctx.mail into the dev inbox (capture to KV) instead of
          // sending. Without MAIL_CAPTURE and MAIL_FROM, ctx.mail FAILS CLOSED (a send
          // throws) — so a misconfigured prod can't silently stash emails in KV.
          APP_URL: "http://localhost:8787",
          MAIL_CAPTURE: "true",
        }
      : {
          // Production email (ctx.mail): set MAIL_FROM to an address on a domain
          // onboarded to Cloudflare Email Sending (`wrangler email sending enable
          // yourdomain.com`); with the EMAIL binding below + MAIL_FROM, ctx.mail sends
          // for real — no API keys. APP_URL is your frontend origin (magic-link).
          // MAIL_FROM: "login@yourdomain.com",
          // MAIL_FROM_NAME: "Acme",
          // APP_URL: "https://app.yourdomain.com",
        };

  return new Worker({
    dir: ".",
    name: PROJECT,
    main: "./example/worker.ts",
    compatibility_date: "2026-06-18",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true },
    bindings: {
      // The DO is the database. oblaka emits the binding + the SQLite migration
      // (new_sqlite_classes: ["PramenDO"]) into wrangler.jsonc automatically.
      PRAMEN: new DurableObject({ name: `${PROJECT}-store`, className: "PramenDO" }),
      // One KV namespace per project. Holds the tenant registry (`tenant:` keys)
      // and handler-facing ctx.kv data (`app:` keys); see packages/server/src/runtime/kv.ts.
      KV: new KVNamespace({ name: `${PROJECT}-kv` }),
      // D1 database for the "Worker + D1 (no DO)" path — the same engine over D1,
      // selected per-request via `x-pramen-store: d1`. The DO remains the write path.
      DB: new D1Database({ name: `${PROJECT}-d1` }),
      // R2 bucket backing file storage — `fileRef` columns + ctx.files + the Worker
      // /files/* upload/download route. Bytes live here; the DB holds only metadata.
      FILES: new R2Bucket({ name: `${PROJECT}-files` }),
      // Cloudflare Email Sending — the transactional-email binding (no API keys).
      // Used by @pramen/auth's magic-link demo (ctx.env.EMAIL.send(...)). The `from`
      // domain must be onboarded: `wrangler email sending enable yourdomain.com`.
      EMAIL: new EmailService(),
    },
    vars,
  });
});
