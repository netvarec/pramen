# pramen

Reactive backend runtime for TypeScript on **Cloudflare**. Define schema +
handlers, get a backend deployed as a Worker + Durable Object: the platform
provides the single-writer/storage/replication stack. Read `DESIGN.md` for the
architecture.

## WIP: everything is subject to change

Active development; nothing is stable. No backward-compat constraints, so redesign
freely rather than patching around something that feels wrong. No preexisting
issues: if something is broken, fix it.

## Layout & architecture

The runtime is the publishable **`@pramen/server`** package at `packages/server/src/`
(SDK + Cloudflare glue). A project (see `example/`) is just `app.ts` + `oblaka.ts` +
a 3-line `worker.ts` that calls `createPramen(app)`.

```
example/worker.ts  createPramen(app) -> { fetch, PramenDO }
  Worker (fetch)  ->  PramenDO (per-tenant Durable Object)
                        ├─ ctx.storage.sql   in-process SQLite (the DB)
                        ├─ schemaDDL on boot (blockConcurrencyWhile)
                        └─ dispatch: query -> run; mutation -> storage.transaction()
```

- **`@pramen/server`** (`.` export) is authoring-only: `Entity`/`defineSchema`,
  `createApp`, `query`/`mutation`, ACL, files, errors, the substrate seam. The
  **deploy** half (`createPramen` + the Durable Object) is **`@pramen/server/worker`**,
  split off because only it imports `cloudflare:workers`. So the CLI/tests/codegen
  can load an `app.ts` for its schema without dragging in the DO runtime.
- The DO + Worker are **parameterized by the app** (`pramenDO(app)` / `makeWorker(app)`),
  closed over by `createPramen`: no static app import in the runtime.
- **The DO is the database.** Single-writer serialization is free (a DO handles
  one request at a time), per-tenant via `idFromName`.
- **D1 is NOT the DO's write path**: it's over-RPC, not in-process; the DO's
  SQLite is its transactional store. D1 is instead available as a separate
  substrate via the Worker (`PRAMEN_STORE=d1`). See the Substrate seam below.
- **SDK (`packages/server/src/sdk/`) is platform-agnostic**, the portable product.
  `packages/server/src/runtime/` is the Cloudflare glue.

## Commands

```bash
bun install
bun run dev          # lopata dev (Bun runtime; fast reload + /__dashboard); http://localhost:8787
bun run dev:wrangler # wrangler dev (miniflare), workerd-parity check before deploy
bun run typecheck    # tsc --noEmit (server + client + react)
bun run build        # tsc → dist (JS + .d.ts) for all 3 packages (for published Node consumers)
bun run deploy       # oblaka --remote --env production && wrangler deploy (then: wrangler secret put AUTH_SECRET)
```

Prod config: secrets via `wrangler secret put` (AUTH_SECRET; FILES_SECRET ≥16 chars or
files fail closed). Destructive migrations are OFF unless `PRAMEN_ALLOW_DESTRUCTIVE=true`
(local dev sets it on). Packages use conditional `exports`: the `development`/`bun`/
`workerd` conditions resolve to `src` (so in-repo typecheck/tests/dev/deploy need no
build), while published Node consumers fall through to `dist` (`default`/`types`).
tsconfigs set `customConditions: ["development"]`.

The Worker REFUSES TO SERVE (500 on every request, files/media/public routes included, logged
once per isolate) in two configurations, checked first in `makeWorker`'s fetch by
`misconfiguration(env, hostname)`: dev-only values on a NON-LOCAL host (`PRAMEN_DEV_SEED=true`,
`AUTH_SECRET === DEV_SECRET` (JWKS_URL or not: it still signs files/previews), or `FILES_SECRET === DEV_FILES_SECRET`; local =
loopback only: localhost / *.localhost / 127.0.0.0/8 / [::1]; `PRAMEN_DEV_ALLOW_LAN=true`, set by
hand to open the dev server from a phone, adds the private ranges and *.local, never a tunnel's
public hostname; it is not inferred from the host because a staging box on a private network
serving the dev secrets is what this refuses), and `JWKS_URL` without BOTH `AUTH_AUDIENCE` and
`AUTH_ISSUER` (any host). The request host is the signal, never a var like APP_URL: the failure
caught is oblaka rendering the whole LOCAL vars block into a deploy, APP_URL=localhost included.
A Worker has no startup hook that sees env, so a 500 to everything is how it refuses to start.
A service binding call (`https://cms/…`) is NOT local (#92): the caller sends the same host on a
deployment, which also makes a binding URL naming a `*.localhost` host a BYPASS of this guard. The
local remedy is the callee's `.dev.vars` (docs: auth-and-tenancy).

**The env must reach OBLAKA, not wrangler.** oblaka falls back to env `local` when given neither
`--env` nor `CLOUDFLARE_ENV`, even with `--remote`, and the local block carries a published
`AUTH_SECRET`, `CORS_ORIGINS=*`, `PRAMEN_STORE_HEADER=allow` and `PRAMEN_DEV_SEED`. `bun run
deploy --env x` appends `--env x` to the LAST command of the `&&` chain (wrangler), never to
oblaka. So `deploy`/`plan` name `--env production` on the oblaka command, and `oblaka.ts` (and
the `pramen init` template) THROW when asked to render `local` under `--remote` (an argv check,
so oblaka's programmatic `deploy()` API is not covered). Set secrets AFTER the deploy: oblaka
names the remote script `${env}-${PROJECT}` and writes that name into `wrangler.jsonc`, which is
what a plain `wrangler secret put` targets. The dev-account seed (`devUserBootstrap`) is
registered only by `example/dev-worker.ts`, the `main` of the `local` env; the deployed
`example/worker.ts` never registers it, so no var can turn it on.

Local dev runs on **lopata** (Bun-based CF runtime; fully emulates DO SQLite +
WebSocket Hibernation). It reads the oblaka-generated `wrangler.jsonc` unchanged and
serves a dashboard at `/__dashboard`. The e2e suite still boots real `wrangler dev`
(miniflare); run `bun run dev:wrangler` once before deploying to catch any
Bun-vs-workerd differences.

> pramen uses the published **lopata `^0.24.0`** from npm. Since 0.19.2 it carries the two fixes
> pramen relies on: the proxy-to-DO deadlock (the canonical
> `stub.fetch(new Request(request, { headers }))` tripped a Bun `new Request(req)`
> stream-body clone bug) and DO SQLite surfacing `RETURNING` rows from `exec()`.
> `bunfig.toml` exempts lopata from a global `minimumReleaseAge` so a fresh lopata
> release installs immediately (other deps still honor the policy).

## Substrate seam (Driver/Dialect)

The data layer runs over a `Driver` (async `exec` + `transaction`) + `Dialect`
(`packages/server/src/runtime/driver.ts`), so the ACL/read/write engine is substrate-agnostic:

- **`DoSqliteDriver`**: the DO's in-process SQLite (the default write path).
- **`D1Driver`**: the SAME engine over a real D1 binding, run **in the Worker**
  (no DO) and selected by the operator with `PRAMEN_STORE=d1`. The `x-pramen-store: d1|do`
  request header overrides it ONLY under `PRAMEN_STORE_HEADER=allow` (local dev, e2e: the e2e
  suite passes `--var PRAMEN_STORE_HEADER:allow` to wrangler dev). Never let a caller pick the
  store: each store has its own `auth_users`, sessions name the user by a bare `sub` signed with
  the shared AUTH_SECRET, so signing up a victim's username on the store where it is free and
  presenting that token to the other store's `refreshSession` reissued the victim's roles
  (anonymous to admin). Sessions also carry a `store` claim (`@pramen/auth`, below) as the
  second half of that fix. `useD1Store`/`requestUsesD1` in `worker.ts` is the one decision,
  shared by /rpc and a route's `callPrivileged`. Admin routes (`/admin/migrations`,
  `/admin/tasks/*`) still read the header: they are admin-gated and it selects what to inspect.
  A queue consumer's `callPrivileged` follows `PRAMEN_STORE` too (it used to always forward to a
  DO, landing a D1 deployment's queue writes in a store nothing reads). RPC only:
  live queries need the DO (single writer + socket host), and on `PRAMEN_STORE=d1` `/live` is
  REFUSED (404, by the Worker and again by the DO's upgrade, header opt-in or not): a D1
  deployment still binds the DO class, whose own store holds none of the data but has its own
  empty users table and answers every handler over `call` frames, so a reachable socket there is
  a second store nobody runs. Proven end-to-end in
  miniflare by `test/suites/d1.ts` (ACL, row scope, field/cell-level projection,
  RETURNING writes, aggregates). The D1 binding is declared in `oblaka.ts`.
- **The D1 boot is a `SharedBoot`, never a bare memoized promise** (`runtime/boot.ts`, #51).
  Workers rule: async work belongs to the invocation that started it, and when that invocation
  ends (the caller disconnects) its pending I/O is canceled: a promise chained on canceled I/O
  NEVER SETTLES, it does not reject. A once-per-isolate boot memoized from the first request's
  D1 calls therefore wedged every later fetch in the isolate for its lifetime (0 ms CPU, no logs)
  once a proxy timed out the legitimately slow first request after a deploy; crons in another
  isolate stayed healthy, a redeploy "fixed" it. So: the starter puts the boot under
  `ctx.waitUntil` (pass `ctx` from EVERY entry: fetch, routes, admin, `scheduled`), and awaiters
  treat a boot with no statement progress for `D1_BOOT_STALE_MS` (30 s, the `waitUntil` cap) as
  orphaned and start their own. Apply the same rule to any future per-isolate memo of I/O.
- **`postgresDialect`**: shows the SQL shape for a future Hyperdrive/Postgres port
  (quoting + `$n` placeholders); needs a pg `Driver` over Hyperdrive.

## File storage (R2)

Files live in **R2**, not the DB. A `fileRef` column (`t.fileRef()`) stores only
JSON metadata (`FileRef`: `{ key, size, contentType, filename?, uploadedAt? }`) in a
TEXT cell: the bytes are an R2 object addressed by a tenant-scoped key. The object
store is behind a `StorageAdapter` seam (`R2Adapter`/`MemoryAdapter` in
`runtime/storage.ts`), mirroring the Driver/Dialect seam.

- Handlers use **`ctx.files`**, never the R2 binding directly:
  - `signUpload({ contentType, filename?, maxSize?, prefix? })` → `{ url, ref }` (a
    signed PUT url + draft metadata to attach later).
  - `signDownload(ref, { download? })` → `{ url, expiresAt }`: mint ONLY after an
    ACL'd `ctx.db` read; knowing a key is not authorization.
  - `head(key)` / `delete(key)` for upload-verify and cascade.
- The Worker serves `/files/upload` (PUT) + `/files/download` (GET), authorized by an
  HMAC token (`FILES_SECRET`, falls back to `AUTH_SECRET`) in the url. Bytes stream
  in the Worker; they never pass through the DO. Signed urls are RELATIVE; the
  client resolves them (`@pramen/client` `fileUrl()`/`upload()`).
- The object↔JSON codec lives at the `Db` chokepoint, so handlers always see/write
  `FileRef` objects. R2 is declared in `oblaka.ts` (`FILES` binding).
- `/media/` answers are cached `public, max-age=MEDIA_MAX_AGE` (3600), never `immutable`:
  `purgeMedia` is a takedown and invalidates no cache. `isActiveType` fails toward the sandbox:
  any `+xml`, `text/xsl`, `application/xslt+xml`, `multipart/*`, any comma-list member that is
  active, and anything that does not parse as a MIME type. `signUpload` refuses a `contentType`
  that is not ONE MIME type (`isSingleMimeType`).

The same shape (adapter + `ctx.<service>` facade + Worker glue) is how other
Cloudflare services should be added (e.g. email via the Send service as `ctx.mail`).

## Partitions

An entity may declare a **`partition`**: the Durable Object class it lives in:
`Entity(t => ({...}), undefined, { partition: "audit" })`. The default is a single
partition (`"default"`), i.e. **one DO per tenant**, the original model. Partitioning
splits a tenant's data across multiple DOs (e.g. a hot path vs. an append-only audit
log) for independent single-writer serialization and storage.

- A partition-DO **only sees its own partition's tables**: migrate/admin/CLI are all
  **per-partition**: each partition is migrated, hashed (`schema_hash:<partition>` in
  `_pramen_meta`), and reported independently. `sdk/schema.ts` provides
  `partitionsOf(schema)` / `entitiesInPartition(schema, p)` / `partitionOf(schema, e)`
  / `DEFAULT_PARTITION` to enumerate/resolve them; `validateSchema(schema)` enforces the
  static invariants (relation targets exist; no relation crosses a partition).
- **Cross-partition relations, `with` eager-loads, and transactions are rejected**: a
  DO can't reach into another DO's SQLite. A relation whose source and target are in
  different partitions fails `validateSchema` at boot (and codegen). Keep related
  entities in the same partition.
- **Backward-compat invariant, DO NOT break:** the default partition uses the **bare**
  DO key `idFromName(tenant)` (NOT `idFromName(tenant:default)`), so a pre-partitions
  store is byte-for-byte the same DO. `partitionDoName(tenant, partition)` in
  `runtime/registry.ts` encodes this: bare `tenant` for `"default"`, `${tenant}:${partition}`
  otherwise. Routing and the tenant registry both go through it, so they stay in lockstep;
  any future change to DO addressing must preserve the bare-key form for the default partition.
- Admin/CLI address one partition at a time: `/admin/schema?tenant=&partition=` returns
  that partition's applied schema; `/tenants` returns `{ tenant, partition }[]`. The CLI's
  `schema status` loops `partitionsOf(app.schema)`, fetching + comparing each partition
  (a single-partition app reads identically to before).

## Conventions

- Schema: `Entity(t => ({ id: t.id(), ... }))` + `defineSchema({ table: Entity })`.
  Field builders: `id`/`textId`/`text`/`int`/`real`/`bool`/`json`/`fileRef`/`uuid`. `json`
  and `fileRef` are stored as TEXT and object↔JSON-codec'd at the `Db` chokepoint, so
  handlers read/write the parsed value (a `JsonValue` / `FileRef`). `uuid` is a TEXT
  column typed as `string`; a supplied value is validated (`isValidUuid`) on write and
  rejected (400) if malformed. Modifiers are wrapper helpers (compose like
  `renamedFrom`): `notNull()`, `unique()`, `indexed()`, `defaultTo(v)`, `primaryKey()`,
  `generated()`, `hidden()`, e.g. `code: unique(t.text())`, `status: defaultTo(t.text(), "pending")`.
  `hidden()` marks a column never-readable through the ORM (stripped from every read
  projection (find/get, mutation echoes, relation loads, SYSTEM-mode `/admin/data`),
  even under `allow()`/SYSTEM; still writable + visible to raw `ctx.db.exec`). For
  secrets like a password hash. `primaryKey()` marks any column the PK (implies NOT NULL); `generated()` auto-mints a
  uuid on insert via `crypto.randomUUID()` (uuid-only) and makes the column optional on
  insert. The canonical UUID primary key is `id: primaryKey(generated(t.uuid()))`.
  `defaultTo` also takes a SQL-expression default via the `expr` helper: `expr.now()`
  (the current UTC instant as ISO-8601 TEXT with millis and a `Z`, byte-identical to
  `new Date().toISOString()`) or `expr.raw(sql)`, emitted unquoted and parenthesized
  (`DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`), e.g.
  `createdAt: defaultTo(t.text(), expr.now())`. Expr-default columns are optional on
  insert (the DB fills them); adding one to an existing table triggers a table rebuild
  (SQLite forbids `ALTER ADD COLUMN` with a non-constant default), which is additive
  (backfills existing rows) and ungated.
- `expr.now()` EMITS ISO-8601 (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), not the
  `datetime('now')` space form it used to. Two reasons, both silent failures: the space form
  does not compare against `$now()` (which is ISO), and it is second-resolution. The
  comparison bug is narrower than "inconsistent" and worth knowing exactly: both forms open
  with `YYYY-MM-DD`, so different DATES still order correctly; it is the SAME date that
  breaks, where index 10 decides and `' '` (0x20) always sorts below `'T'` (0x54) whatever
  the time-of-day. So a space-form value dated today is always `<= $now()`, i.e. a row
  scheduled for later TODAY reads as already published until midnight. Changing the default
  is a MODIFIER change, so `migrate()` rebuilds the table, and a rebuild COPIES values
  through, leaving both formats mixed in one column. `isoTimestampBackfill()` (from
  `@pramen/server`, `sdk/iso-timestamps.ts`) is the rewrite: a `DataMigration` an app spreads
  into `app.migrations`, scanning the schema for `expr.now()` columns plus any the app names
  via `extraColumns` (`@pramen/cms` exports `CMS_LEGACY_TIMESTAMP_COLUMNS` for
  `cms_pages.publishedAt`, which was stamped from handler code and so has no default to
  find). Bulk `driver.exec` UPDATE, guarded on `length=19 AND substr(col,11,1)=' '`: a third
  format is left alone rather than guessed at, and the guard makes it idempotent by shape.
  Safe to declare on a fresh store: every UPDATE matches no rows. In `@pramen/cms` this
  collapsed `nowStamp`/`isoStamp` into one helper: the two existed only because one column
  could not satisfy both comparison requirements.
- Auth/ACL: an unauthenticated caller is the `anonymous` role (define it for public
  reads/writes; absent ⇒ deny). A policy `where` may use `$identity("path")` (caller),
  `$input("path")` (request input, a capability/by-unguessable-key read), or `$now()`
  (the evaluation instant, as an ISO-8601 UTC string, for a time-boxed grant like
  scheduled publication: `{ publishedAt: { lte: $now() } }`, which `isNull: false`
  can't express since a future timestamp is non-null. Lexicographic TEXT comparison, so
  the column must hold `toISOString()` values, which `expr.now()` now produces, having
  emitted the `datetime('now')` space form until `isoTimestampBackfill()` landed).
  Grants OR-merge on ROWS, but a policy's `fields` stay BOUND to the rows its own `where` admits
  (`mergeGrants` in `runtime/acl.ts`). Merging `author` (own rows, every column) with `reader`
  (every row, no `body`) used to collapse to "every row, every column", which no single policy
  allows, on read, write, the write echo and `directAccess`. Now the scope's base `fields` are
  only those readable on EVERY row in scope (a field every policy lists, plus the fields of a
  policy that admits every row); anything a row-restricted policy adds is a per-row `BoundGrant`
  admitted by that policy's own `where`. Only base fields may be filtered, ordered or aggregated
  by. A single policy is unchanged (no per-row work). A per-row admission that traverses a
  relation can't run in `evalExpr`, so it is computed in SQL: a projected `CASE WHEN … END AS
  "__pramen_acl_N"` flag on stored rows, or a one-row probe over a derived table for a row that
  isn't stored yet (insert candidate, update post-image, write echo). Flags are stripped before
  any row is returned. A `directAccess` relation grant reaches only targets linked from parent
  rows ITS policy's `where` admits. A marker (`$identity`/`$input`) resolves only to a non-null
  scalar, or a list of them for `in`/`notIn`; null or an object is UNRESOLVED, so
  `$input("key")` fed `{key: null}` never becomes `IS NULL` (which matched exactly the
  never-shared rows).
  Public,
  pre-auth routes go in `app.routes` (matched before auth; use `ctx.callPrivileged`
  to run a privileged handler), for signature-authed webhooks.
- `ctx.callPrivileged` works on BOTH stores. It used to only forward to the DO, so
  everything built on a pre-auth route (signed preview links, the sitemap) was DO-only and
  the CMS REFUSED to mint preview links on D1 rather than hand out a dead one. On D1 the
  engine runs in the Worker, so it now dispatches locally there. Both paths share one
  `dispatchD1`, so migration/bootstrap/the multi-tenant commingling guard/the outbox drain
  cannot drift, and a privileged call pins `first-primary` because it may write. This is
  what makes D1 a first-class CMS store, which matters because D1 is a BINDING: nothing
  needs exporting from the worker entry, so the CMS can live inside an Astro site's Worker.
  The store follows the same decision as /rpc (`PRAMEN_STORE`, the header only under
  `PRAMEN_STORE_HEADER=allow`), so a D1 deployment needs `PRAMEN_STORE=d1` (an embedded topology
  sets it anyway). Its opts take an optional `userId`, put on the synthetic identity on BOTH
  paths (`privilegedIdentity` in worker.ts); `roles` defaults to `["admin"]` but an explicit
  `[]` stays `[]`, never admin.
- Per-handler call authorization (the ACL only gates `ctx.db`): `query(fn, { auth })` /
  `mutation(fn, { auth })` where `auth` is `"authenticated"` | `string[]` (one-of role) |
  `(identity) => boolean`, enforced in `runtime/dispatch.ts` BEFORE the handler runs
  (throws 403). Gate any handler that touches `ctx.kv`/`ctx.env`/`ctx.mail`/`ctx.tasks`
  directly: those bypass the row-ACL, so un-gated they're callable by anyone. Absent ⇒
  open. `authorizeHandler(auth, identity)` is the pure check. `createApp` forwards `auth`.
- Write policies bind the WRITTEN row. A create policy's `where` must hold on the candidate
  (after `set`, omitted columns at their literal default; an expr default reads as NULL and
  fails closed), else 403; it used to be silently ignored. Evaluated BEFORE the INSERT so it
  holds on D1. An update policy's `where` gates the PRE-image only; the opt-in `check:
  WhereRule` is evaluated on the post-image before the UPDATE. Opt-in because the CMS trash flow
  deliberately moves a row out of its `deletedAt IS NULL` update scope. With merged grants a
  policy whose check fails contributes nothing and a write no policy still covers is a 403.
  `check` on create is AND-ed into `where`; `compileAcl` THROWS on a read or delete `check`. The
  example's `author:update` uses it so an author can't reassign `ownerId` (a `fields` whitelist
  would have broken `attachToNote`).
- A per-row-authorized update (cell grants, a bound policy, or a `check`) is decided on a
  pre-image read, which on D1 is a separate autocommitting statement. The UPDATE therefore
  re-asserts the stored values the decision read (`preimageGuard`: the inputs of cell
  `when`s/admissions/checks, EVERY column when a `fieldsFn` is involved, compared raw and
  null-safely) plus each relation-traversing admission that held. Zero rows re-runs the whole
  decision (up to 3 times), then 409. Never fires on the DO (single writer).
- `@pramen/auth` (optional, verify-only core stays BYO-IdP): `authSchema` + `authHandlers`
  (`signup`/`login`/`me`, PBKDF2, server-assigned roles, HS256 tokens via `AUTH_SECRET`).
  `signup` takes an OPTIONAL `email` (validated, unique, stored UNVERIFIED). `auth_users`
  columns: `username` (PK = JWT `sub`), `passwordHash` (`hidden()`), `roles`, unique mutable
  `email`, `emailVerified` (epoch ms the current email was confirmed; NULL = unverified),
  `active` (deactivation flag, which blocks login), `credentialsChangedAt` (epoch SECONDS of the
  last password reset/change or deletion; NULL = never). A custom users table must have the same
  shape (`USERS_TABLE_COLUMNS`), `credentialsChangedAt` and `profile` included: pass
  `createUserHandlers({ table, schema })` to have it checked at app construction
  (`assertUsersTableShape`), else a missing column is a SQL error mid-handler. `deleteUser`
  writes the denylist right after the ACL'd deactivation, before anything that could fail. Also:
  `createMagicLinkAuth({ sendEmail })` (passwordless one-time links; transport is the
  app's: Cloudflare Email Sending via the `send_email`/`EMAIL` binding declared in
  `oblaka.ts`; magic-link users keyed on the immutable `username`, never the mutable
  `email`); `createUserHandlers({ table })` + `authPolicies({ table, prefix, adminReadFields, … })`
  for ACL-gated admin (`listUsers`/`setUserRoles`/`setUserActive`/`deleteUser`) + self
  (`changeEmail`/`changePassword`) management, over `auth_users` or your own
  authSchema-shaped table (`changeEmail` clears `emailVerified` BEFORE writing the address (on
  D1 each statement commits alone, so the reverse order left a cut-off call with the new address
  verified), and on an account WITH a password requires `currentPassword`, like
  `changePassword`: the email is the reset channel, so a bare session that could move it could
  mail itself a reset link and replace the password; `changePassword` returns a fresh `token`,
  because it retires the caller's own session too). Session TTL resolves in ONE place
  (`packages/auth/src/session-ttl.ts`): a factory's own `sessionTtlSeconds` for the tokens it
  mints, else `AUTH_SESSION_TTL_SECONDS`, else 3600. Every revocation entry (denylist,
  notBefore) is sized by `maxSessionTtlOf(env)` = the longest of the env value and every TTL a
  factory declared at construction, so it never lapses under a live token. The stateless
  verify-only core closes the "roles are baked into the token" gap two ways, no session store:
  **`refreshSession`** (in `authHandlers` + `createMagicLinkAuth`, authenticated) re-reads
  roles/active and reissues a token: a client refreshing at ~half-TTL lets the TTL stay short
  (bounded revocation lag) and picks up a role GRANT immediately (no re-login); and a **KV
  denylist** for HARD revocation: `setUserActive(false)`/`deleteUser` write `authDenied:<username>`
  (self-expiring at the session TTL, lifted on reactivation), which the core Worker checks right
  after `resolveIdentity` and fails a revoked token CLOSED (401, not a downgrade to anonymous),
  covering HTTP + the WS upgrade. Helpers `denySession`/`allowSession`/`isSessionDenied` are
  exported from `@pramen/server` for app-driven revocation. A NOT-BEFORE instant is the narrower
  cut for a password reset / sign-out-everywhere: `setSessionNotBefore(kv, username, atSeconds,
  ttlSeconds)` revokes tokens whose `iat` is BELOW it (same second survives; no `iat` while an
  instant is set fails closed), `isIssuedBeforeNotBefore` reads it, and `isIdentityRevoked`
  (runtime/kv.ts) is the single "denylist OR stale iat" check the Worker and the DO both call.
  `toIdentity` carries `iat` like `exp` for this (declared on Identity by module augmentation in
  auth.ts). A live WebSocket re-checks `exp` AND `isIdentityRevoked` per frame and before every
  push, closing 4401 "session revoked". A broadcast looks revocation up only for the sockets it
  is about to push to (a subscription reads a written table), once per (user, iat), in
  parallel. Frames from ONE socket run strictly in arrival order (`frameTail` in the DO): the
  input gate holds only across the DO's own storage awaits, so the per-frame KV read let a
  `subscribe` be overtaken by its own `unsubscribe` and leave a zombie subscription. Waiting for a
  reconnect is not revocation, because the revoked client decides when to reconnect and an
  exp-less token never forces one. Every failed `verifyPassword` spends one PBKDF2 derivation
  (empty hash of a passwordless user, unknown scheme, unparseable pbkdf2), so `login` for a
  passwordless account is no faster than for an unknown one (passwordless users are keyed by
  their email, so the fast path was an account oracle).

  **Credential epoch** (revokes only what came BEFORE): `resetPassword`, `changePassword` and
  `deleteUser` stamp `credentialsChangedAt` and write a per-user KV notBefore entry
  (`setSessionNotBefore`); `refreshSession` refuses a token whose `iat` is below
  `credentialsChangedAt`, or which predates the row's `createdAt` (an earlier account under the
  same username), and the Worker refuses one below notBefore. Not `denySession`: that is
  username-scoped and would lock out the owner's next login. A token with no `iat` is refused by
  `refreshSession`.

  **`deleteUser` keeps a TOMBSTONE** (inactive; `passwordHash`, `email`, `emailVerified`,
  `profile` cleared) instead of deleting the row: the username IS the identity (JWT `sub`,
  `$identity("userId")` owner columns, CMS actor), so a freed one could be signed up again by
  anyone, inheriting the deleted user's rows. It is an UPDATE of `active`, so the admin UPDATE
  policy authorizes it, not the delete policy. Tombstones show in `listUsers` as inactive.

  **Email-proven adoption rule** (`adoptableBy` in `users-table.ts`): a magic-link sign-in,
  `inviteUser` or an email-keyed OIDC sign-in takes an EXISTING row only if it has no password
  or has proven the same address (`email` equal to it and verified). Anyone can sign up with a
  victim's address as the username and their own password; adopting that row shared one `sub`
  between them. Refused, nothing written: OIDC answers `account_conflict` (409).
  `loginWithMagicLink` records the proven address as the row's verified `email` when no other
  row holds it (that keeps a magic-link user adoptable after they set a password), and
  `resetPassword` stamps `emailVerified` (redeeming the link proves the address).

  **Store claim**: a session minted on D1 carries `store: "d1"` (absent = DO); `sessionIsFrom`
  checks it with the `usersTable` claim, so refreshSession / me / the self handlers honor a
  session only on the store whose users table minted it. The OIDC upsert returns `ctx.store` and
  the callback stamps it.

  **Single-use tokens are consumed by ONE conditional statement** (`UPDATE ... WHERE consumedAt
  IS NULL AND expiresAt >= ? RETURNING`), never SELECT + JS check + UPDATE, which let two
  concurrent redemptions both pass on D1. `verifyEmail` stamps with `WHERE username = ? AND
  email = ?`, and `resetPassword` writes with the same address guard, for the same reason.

  **Resend cooldown**: `requestMagicLink`, `requestPasswordReset` and `requestEmailVerification`
  send at most one email per address per `resendCooldownSeconds` (default 60; 0 = off), read
  from the token tables' `createdAt`; a request inside the window still answers `{ ok: true }`.
  For the magic link only an UNREDEEMED link holds the next one back. `inviteUser` is not
  throttled. A cross-address rate limit belongs at the edge.
- OIDC login (`@pramen/auth`, opt-in): `createOidcAuth({ issuer, clientId, clientSecret?,
  redirectUri, successRedirect })` → `{ routes }` (spread into `app.routes`, PRE-AUTH) plus
  `oidcHandlers` (spread into handlers). Authorization code + PKCE S256, discovery via
  `/.well-known/openid-configuration`, `state`+`nonce` in KV (single-use: read-and-DELETE
  before the exchange), ID token verified by the same `JwksStrategy` the Worker uses
  (signature/iss/aud/exp) plus a nonce match. Exchanges for a PRAMEN session, not a
  passthrough of the IdP token, and that keeps `refreshSession`, the KV denylist and
  role-in-token ACL working. The session lands in the redirect's URL FRAGMENT (never sent to
  a server). `start?prompt=none` is a silent attempt: a provider error answer (`login_required`
  etc.) lands on `successRedirect#error=<code>` with no token instead of an error page, but only
  for the browser holding the binder, and so does every LATER failure of a silent attempt
  (deactivated, unverified email, bad token, a thrown step), as `#error=<pramen code>` via the
  callback's one `fail` helper. A provider code outside the four `prompt=none` exists for is
  redirected too but `console.error`ed. The app must try it once per visit or it loops. Any other
  `prompt` is refused (400). Roles: `mapRoles(claims)` when the IdP is authoritative (Entra `roles`,
  Auth0/Okta namespaced claim), where it overwrites stored roles on every login, removals
  included, minus any `__`-prefixed system role (filtered out; see below), else the row's
  stored roles (Google Workspace ships none), else `defaultRoles`.
  Accounts key on the VERIFIED email by default (links with magic-link/password rows, subject to
  the adoption rule above); an unverified email is REFUSED, not silently keyed on `sub`.
  `accountKey: "sub"` namespaces by issuer instead, and stores an email only if the provider
  verified it (it used to store and stamp an unverified one). A first-login insert releases
  other rows' UNVERIFIED claims on the address and stores NULL if a row VERIFIED it, rather than
  failing on the unique column (which locked the owner out of every OIDC sign-in). `active =
  false` still blocks login. The write goes through
  `callPrivileged` → `__oidcUpsertUser`, gated on `OIDC_SYSTEM_ROLE`. NOT `auth: []`, which
  this said until it was found to be unreachable BY ANYONE: `callPrivileged` does not bypass
  the handler gate (it sends an ordinary `{ roles: [...] }` identity through the same
  `dispatch` check), `[]` is truthy so the gate runs, and `[].some(...)` is false for every
  caller, so every OIDC sign-in 403'd at the upsert. `validateHandlerAuth` now WARNS at boot
  about an empty list (never throws: `createPramen` runs at the Worker entry's module scope,
  so a throw would fail every request in the deployment, and `@pramen/cms` builds `auth` from
  a caller's `reviewerRoles`, so `reviewerRoles: []` produces one on purpose).
  `auth: ["admin"]` is the wrong fix for a handler that writes roles.
  **A `__`-prefixed role is a SYSTEM role**: `toIdentity` strips it from every verified token,
  so it can only ever be presented by `callPrivileged` from inside the Worker. Without that
  the gate would be bypassable by anyone whose IdP has a group of that name (`mapRoles` passes
  the provider's claim into the minted session, and on the verify-only path the `roles` claim
  is the external IdP's entirely). `setUserRoles` refuses to grant one, and `mapRoles` output
  is filtered, so the store never holds a role that silently does nothing. Use the prefix for
  any future server-only handler. The callback sets one cookie PER ATTEMPT (`pramen_oidc_<sha256(state)[0:16]>`,
  HttpOnly/SameSite=Lax/callback-path, cleared on completion; per attempt because silent
  sign-in runs in every tab and a single name let tabs overwrite each other's binder) binding `state` to the browser that started the login. Without it
  an attacker's valid state+code fed to a victim's browser signs the victim in AS THE
  ATTACKER; sessions themselves stay bearer tokens. The error page escapes centrally and
  echoes only RFC 6749-shaped codes: it is public, pre-auth and reachable with arbitrary
  query params, so raw interpolation was a reflected XSS on the app's own origin.
  Verify-only (BYO-IdP via `JWKS_URL`) remains the no-login-code path, but it REQUIRES
  `AUTH_AUDIENCE` + `AUTH_ISSUER` (else the Worker 500s every request): a key set alone also
  accepts tokens the same IdP minted for other clients or directories, roles claim included.
  `JwksStrategy`/`VerifyOptions` stay opt-in at the class level because OIDC verifies ID tokens
  with its own aud/iss; the requirement lives in the Worker.
- Password reset + email verification (`@pramen/auth`, opt-in): two one-time-email-token
  flows built on the magic-link machinery: mint a random token, store only its SHA-256
  **hash** + expiry in the shared `emailTokenSchema` table (`auth_email_tokens`, discriminated
  by `purpose` "reset"|"verify"), email the raw token from a TASK (off the write path), redeem
  once. Spread `emailTokenSchema` if you use either; wire the returned `.tasks` or the email
  never sends. **The token is minted INSIDE the send task, never in the request** (#73, all
  three flows incl. magic link): a task payload is plain JSON in `_pramen_outbox` and in every
  backup, so a raw token there undid the hashing. The request writes a PENDING row
  (`tokenHash = pending:<requestId>`, unredeemable) and enqueues only the `requestId`; the task
  re-checks eligibility (reset: active + same email; verify: same email + still unverified),
  mints, claims ITS OWN row with one conditional `UPDATE … RETURNING`, sends, stamps `sentAt`.
  So a superseded or mooted request sends nothing, a redelivery after a successful send is a
  no-op (the inbox link stays live), and two drainers on one task send one email. Keep that
  shape for any future emailed secret. **`createPasswordReset({ sendEmail, table?, linkTtlSeconds? })`** →
  `requestPasswordReset({ email })` (anonymous, enumeration-safe: always `{ ok: true }`,
  sends only when an ACTIVE account matches) + `resetPassword({ token, newPassword })`
  (anonymous, single-use, sets `passwordHash`; account must still exist + be active). Default
  link TTL 1h. **`createEmailVerification({ sendEmail, table?, linkTtlSeconds? })`** →
  `requestEmailVerification()` (AUTHENTICATED: verifies the caller's OWN current email; runs
  right after signup when the client holds the session token; no-op if already verified, 400 if
  no email) + `verifyEmail({ token })` (anonymous, stamps `emailVerified`, GUARDS that the
  account's current email still equals the address the token was minted for, so a later
  `changeEmail` invalidates a pending token). Default link TTL 24h. `sendEmail` gets
  `{ email, token, username }`; tasks are `sendPasswordResetEmail` / `sendVerificationEmail`.
  See `example/app.ts` for the wiring (dev `__pwResetInbox`/`__verifyInbox` mirror `__magicInbox`).
- Relations: `belongsTo(target, column)` / `hasMany(target, column)`,
  `oneHasOne(target, column)` / `oneHasOneInverse(target, column)` (single-valued 1:1;
  mark the FK column `unique()` for the DB guarantee), and
  `manyToMany(target, { through, sourceColumn, targetColumn })` (**logical**: an **explicit
  junction entity** you write to directly: `ctx.db.insert(through, …)` to link, `delete` to
  unlink; no synthetic tables/write API; its own read policies govern traversal through it).
  All must keep source/junction/target in one partition.
- **Real foreign keys** are **opt-in** on an owning relation via `onDelete`:
  `belongsTo(target, column, { onDelete: "cascade" | "setNull" | "restrict" })` (also
  `oneHasOne`) emits a `FOREIGN KEY … REFERENCES … ON DELETE` enforced by the engine on
  both DO and D1 (cascade/set-null/restrict + insert integrity). Without `onDelete` a
  relation stays logical (no constraint, no migration). Adding/changing an FK is a table
  rebuild (SQLite can't ALTER it): deferred on the DO's boot transaction, and via the D1
  driver's atomic `batch()` on D1; an FK over orphaned data is skipped + reported, not fatal.
  Rebuilding a table that live FKs REFERENCE quarantines + restores the referencing tables
  inside the same atomic step (`DROP TABLE parent` implicit-DELETEs its rows, and
  `defer_foreign_keys` defers only checks, NOT ON DELETE actions, so without the quarantine a
  parent rebuild would cascade-wipe/null the children or abort on RESTRICT); a
  self-referential FK swaps through a bare FK-less copy for the same reason.
- `where` can traverse relations: `{ owner: { name: "x" } }` (belongsTo/hasMany) or `{ tags: {
  name: "x" } }` (manyToMany, via a nested subquery through the junction) compiles to a subquery
  in both user queries and policy `where`; `with: { tags: true }` eager-loads the target list
  through the junction. The related entity's read scope is AND-merged (traversal can't widen
  access; an unreadable target drops out), and so is the JUNCTION's read scope for a manyToMany
  (a link row the caller can't read directly is invisible to `with` and `where`; grant the
  junction to whoever traverses). Cell-`when` predicates stay single-table. A caller-supplied
  `where` (Db's user where, `untrusted` in `compileScopedWhere`) is checked at every hop by
  `assertReadableWhereKeys`: an undeclared key is a 400, a `hidden()` column a 403 under every
  scope (allow() and SYSTEM included), a field outside the base `fields` a 403, and the JOIN
  column must be readable (the parent's FK for belongsTo/oneHasOne, the target's FK for
  hasMany/oneHasOneInverse, both junction link columns), since filtering through a relation is a
  filter on it. Policy `where` rules are trusted and not checked. Eager loads follow the same
  rule per row: a belongsTo attaches only where the parent's FK is readable on that row, a
  hasMany groups only targets whose FK is readable on that row, and a `hidden()` FK never joins,
  not even under SYSTEM. Inside a `sub` node every inner column is QUALIFIED with the subquery's
  table (`compileExpr`'s `table` argument), so an inner name can never bind to the outer row
  through SQL correlated-name resolution.
- `where` string ops: `like` (raw `%`/`_` wildcards) plus `contains`/`startsWith`/`endsWith`
  (auto-escape the needle so `%`/`_` are literal; case-insensitive). `NOT: { … }` negates a
  nested clause; `AND`/`OR` take arrays. Composite uniqueness: `Entity(fields, relations,
  { unique: [["a","b"]] })` (a managed multi-column unique index); single-column stays `unique(t.x())`.
- Handlers: `query()` / `mutation()` from `@pramen/server`. Context is
  `{ db, kv, files, env, identity, tasks, mail, queue }`. Mutations are auto-wrapped in
  `storage.transaction()` by `runtime/dispatch.ts` (commit on return, rollback on
  throw). Do not write transaction control in handler code. Raw `BEGIN`/`COMMIT`
  via `sql.exec` is rejected by DO SQLite.
- Deferred side-effects (notification email, webhooks): `ctx.tasks.enqueue({ kind,
  payload, delayMs? })` writes to the `_pramen_outbox` table in the SAME transaction
  as the mutation (atomic), and `app.tasks[kind]` runs it after commit, off the write
  path: at-least-once with retry/backoff, dead-letter, and a `meta.id` idempotency key
  (`runtime/outbox.ts`). The DO self-drains via an alarm scheduled at the next due time.
  `armDrain` reads `getAlarm()` and keeps an EARLIER pending alarm (it only sets now+50 when
  none is pending or the pending one is later): setAlarm replaces the single alarm, so an
  unconditional re-arm was a trailing debounce, and enqueuing requests under 50 ms apart
  (anonymous magic-link requests) postponed the tenant's only automatic drain indefinitely;
  the D1 store has NO alarm, so a DELAYED task runs only under a Cron trigger. The Worker
  warns once per isolate when a request-tail drain leaves a future-due task and no Cron
  drain has been seen (`shouldWarnMissingCron`), and stops once one fires;
  the D1/Worker store (no alarm) drains via a Cron Trigger (`createPramen().scheduled`)
  or `POST /admin/tasks/drain` (`x-pramen-store: d1`). Admin: `/admin/tasks/drain`,
  `/admin/tasks/list` (both stores). Concurrent drains claim disjoint batches.
- Declarative triggers: an entity may declare `triggers: [trigger({ task, on: { create?,
  update?: true | string[], delete? } })]` (3rd `Entity` arg). On a matching ORM write the
  `Db` write path auto-enqueues `task` (payload `{ entity, op, id, row }`) in the write's
  transaction: no `ctx.tasks.enqueue` in the handler. A field-filtered update fires only
  on an actual value CHANGE; `hidden()` columns are stripped from the payload; raw
  `ctx.db.exec` and task-handler writes (suppressTriggers) don't fire triggers (no
  cascade); `createPramen` rejects a trigger whose `task` has no `app.tasks` handler.
- CMS public reads are published-only IN THE HANDLER (`getPage` without `preview`,
  `listPagesByTerm`, menu page resolution), never only through the anonymous policy: a site's
  deployer token may hold a draft-reading role. `getPage` serves only the current published
  snapshot (no live fallback).
- CMS review is bound to CONTENT. `getPage({ preview: true })` returns `contentHash`
  (`pageContentHash`: page minus `status`/`translations`, plus regions, stable JSON, SHA-256);
  `approve` REQUIRES it as `expectedContentHash` (409 on mismatch) and publishes the very
  snapshot it hashed. The editor fetches the current preview right before an approve and sends
  its hash only if EVERY value that hash covers equals the screen's (`matchesScreen`, driven by
  the fresh side's keys, so nothing hashed goes unchecked; the editor's own inline saves leave
  the loaded hash stale), else it shows the new content for a fresh review. `schedulePage` freezes the snapshot into a `scheduled` revision whose id
  rides in the `cms:publish` payload; the task publishes THAT revision and publishes nothing
  without one (so a publish queued before this shipped logs and does nothing). `deletePage`
  keeps `scheduledAt`/`unpublishAt`; `cms:publish` refuses a trashed page itself,
  `cms:unpublish` archives regardless, and `restorePage` drops a publish that came due while
  trashed (`scheduleCleared: true`).
- CMS preview links read AS THE MINTER: `PreviewToken`/`CollectionPreviewToken` carry `u`
  (userId) and `ro` (non-`__` roles), and the redeem routes pass exactly those to
  `callPrivileged({ roles, userId })`, never a configured role union. A token without a minter
  is refused, minting needs an identity with a `userId`, the token also carries the minting
  session's `iat` (`ia`), redemption runs `isIdentityRevoked` on that (the denylist AND a
  not-before, so a password reset kills links its retired sessions minted; needs the `KV`
  binding, fails closed without it, and a link without `ia` fails once a not-before is set), and a link's TTL is
  capped at the session TTL unless `maxPreviewTtlSeconds` raises it. An app's OWN route over a preview token (one redeeming into its own handler) uses
  `previewRedeemer(env, payload)` after `verifyToken`, for the same refusal rules. `cmsRoutes` no longer takes
  `handlers`/`collectionHandlers`/`viewerRoles`.
- `createMedia` accepts only a key under `${tenant}/media/`, once per key. `purgeMedia` deletes
  the object FIRST and lets a failure propagate (the row is the only handle on the key).
- Field option sources are DECLARED: `createCmsHandlers({ optionSources: { name: query(...) }
  })`. Query handlers only, registered by `createCmsHandlers`, reported as
  `listCmsCapabilities().optionSources`; editor-authored schemas naming anything else are a 400
  (`normalizeFieldSchema(raw, path, optionSources)`), `createCollectionHandlers` throws at boot
  for an undeclared collection source, `cmsBootstrap(defs, { optionSources })` (the same map) does
  the same for code-defined block and content types (without it, it WARNS naming the unchecked
  sources: an undeclared one boots and its picker stays empty), and the editor dispatches a field's source only through
  `Api.callOptionSource`, which refuses undeclared names (the call carries the VIEWER's token,
  so an arbitrary handler name was a confused deputy).
- `@pramen/analytics`: `createAnalyticsSink({ tenants })` and `createAnalyticsQueues({ tenants
  })` (default `["main"]`) drop events for any other tenant: `/collect` is pre-auth and must
  never let a visitor name the tenant. `/collect` reads its body through `readCapped`
  (content-length precheck + bounded stream read), never `request.text()`.
- CMS locales (`@pramen/cms`): a deployment DECLARES what it publishes in,
  `createCmsHandlers({ locales: ["cs", "en"] })`, and the editor renders its i18n surface
  off `listCmsCapabilities` (the pages-side counterpart to a collection's `supports: [...]`),
  never off a client flag. One locale ⇒ monolingual: no i18n chrome, and the editor stops
  sending `locale` on a save so nothing overwrites a field it no longer shows. `locales[0]`
  IS the default stamp (no separate `defaultLocale` to disagree with it). Deliberately not
  inferred from the data: `createTranslation` is only reachable from the panel that would be
  hidden, so "show i18n once a 2nd locale exists" can never become true. `listLocales` stays
  a DATA query (what is authored), distinct from what is declared.
- Bootstrap (code-defined reference data): `app.bootstrap: BootstrapFn[]` runs once after
  schema migration on each boot (DO first-fetch / D1 isolate init) with a privileged system
  `Db`, to converge code-declared reference data (content types, block types, roles, flags)
  into the store so a fresh/reprovisioned DB matches the repo, no manual seeding. Idempotent
  (upsert, don't blind-insert); a throw is logged, never fatal; DO path runs default-partition
  only. `@pramen/cms` ships `defineContentType`/`defineBlockType` + `cmsBootstrap({ blockTypes,
  contentTypes })` (upsert-by-slug). See `example/app.ts`. Every row `cmsBootstrap` writes is
  stamped **`managedBy: <owner>`**, because convergence and the type editor (#46) point at the same
  rows: an editor added a field, got a 200, and lost it at the next cold start when `upsertBySlug`
  patched `fieldsSchema` back to the literal in `app.ts`, orphaning the block content authored
  against it. `updateBlockType`/`updateContentType` now 409 on an owned row (the row exists and the
  edit is well-formed; the conflict is with a definition the request can't reach) and the builder
  renders it read-only. The guard reads `managedBy` through an explicit `select` and THROWS if the
  column is absent: reads are column-projected, so "absent ⇒ editable" would have disarmed the
  guard for exactly the deployments that restrict read `fields`. An OWNER id, not a boolean,
  because `app.bootstrap` is an ARRAY: a sweep can't tell "not mine" from "no longer declared",
  so two `cmsBootstrap` calls released each other's rows every boot; each now releases only what
  it wrote, and a package can ship block types beside the app's via `{ owner }`. A type that drops
  out of the declaration is released (a lock with nothing behind it is worse than no lock), and
  `blockTypes: []` DECLARES none (sweeps) where an absent key says nothing about that table, which
  is also the in-band way to hand everything back before deleting the reconciler. `upsertBySlug`
  never ADOPTS a row it doesn't own: overwriting an editor-authored type of the same slug and then
  locking it was #48's mirror image, unrepairable from the editor.
  Validation lives on `cmsBootstrap`, NOT on `define*`: those helpers are optional and
  `BlockTypeDef` is a structural interface, so a literal/`.map`/codegen reaches the store without
  them: guarding the helper guarded the convenient path and left the sink open. It runs the
  editor's own rules (`normalizeFieldSchema`/`normalizeRegions`/`normalizeDefaultBlocks`), reports
  EVERY bad definition at once, and throws at APP CONSTRUCTION like `validateCollections` /
  `validateMigrations`, which is not the "logged, never fatal" rule above: that governs the
  `BootstrapFn` at boot, and there each row is reconciled in its own try/catch so one failure
  can't skip the rest and both sweeps. `define*` stay PURE constructors, so `BlockFieldsOf<typeof
  def>` still describes the array that gets stored (canonicalizing there rebuilt every entry and
  made the `as unknown as F` cast a lie). `listCmsCapabilities().codeDefinedTypes` declares the
  whole thing, because `@pramen/cms-editor` has no dependency on `@pramen/cms` and a newer editor
  against an older server reads "no owner on any row" as "nothing is code-defined": #48 again, in
  the deployment that upgraded to fix it.
- Data migrations (structure is declarative, DATA is imperative and RECORDED): `app.migrations:
  DataMigration[]` (`{ id, partition?, up(ctx) }`) runs in DECLARATION order after `migrate()`
  and before `bootstrap`, each at most ONCE per `(id, partition)`, recorded in the internal
  `_pramen_migrations` ledger IN THE SAME TRANSACTION as its work (`runtime/data-migrations.ts`).
  `migrate()` diffs SHAPES, so it can only enact structure: a backfill/split/unit-rewrite/json
  normalization has no declarative form. `ctx` is `{ db, driver, schema, partition }`: privileged,
  SYSTEM-scoped, triggers suppressed (`MigrationContext<typeof schema>` for a typed `db`); prefer a
  bulk `driver.exec` UPDATE over walking rows. The deliberate INVERSE of `bootstrap` on every axis:
  once-ever vs every-boot, NOT-required-idempotent vs must-be, user rows vs reference data, and
  **fail closed** vs logged-and-swallowed: a throw writes no ledger row, aborts the boot (so the
  later migrations don't run either) and retries on the next fetch; swallowing a half-finished
  backfill is the one outcome worth bricking a boot over. The schema hash proves nothing here (it
  hashes the declared shape). Keyed `(id, partition)` like `schema_hash:<partition>`: each
  partition-DO runs its OWN partition's migrations; D1 is one shared DB with no partition split, so
  there EVERY declared migration runs (recorded under its own partition key). The ledger row is
  CLAIMED UNDER A LEASE before the work, not written after: on D1 there is no single writer and
  the boot memo is per-isolate, so without a lock two cold isolates would each read an empty ledger and
  both run a `n = n * 2` backfill. One atomic upsert (`ON CONFLICT … DO UPDATE … WHERE leaseUntil <=
  now RETURNING`) inserts, or STEALS an expired lease, or does nothing; `RETURNING` says which.
  `leaseUntil` non-NULL = in flight, NULL = applied, and only applied counts (an in-flight row reads
  as PENDING in the admin ledger). A runner meeting a LIVE lease WAITS (≤5s) then fails closed: it
  must never skip past one, which would serve traffic against half-migrated data and strand the
  migration if the holder failed. `DEFAULT_LEASE.ttlMs` (60s) must EXCEED the slowest migration or
  the lease expires under a live holder and you get the double-apply back. D1's `transaction(fn) =
  fn()` means claim and work are NOT atomic there, so a throw RELEASES the claim (a compensating
  DELETE guarded on `leaseUntil IS NOT NULL`, rolled back harmlessly on the DO) and a holder that
  DIES without releasing is recovered by the lease expiring, so prefer `WHERE col IS NULL`-shaped SQL. NO down migrations. `up()` runs inside `blockConcurrencyWhile` on
  a tenant's first fetch with no chunking/resume, so keep backfills bounded or you stall that request
  and risk the DO wall-clock limit. PRUNING TRAP (same as `renamedFrom`): migration is lazy and
  per-DO, so a cold tenant is unmigrated until touched. Never delete an id on a hunch; check
  `pramen migrations status --all-tenants` (`GET /admin/migrations?tenant=&partition=`, admin-gated,
  both stores; `--store d1` for a D1 deploy) first. That read is deliberately READ-ONLY on both paths
  (routed BEFORE `ensureMigrated` in the DO and skipping `ensureD1Migrated` in the Worker, tolerating
  an absent ledger table, because a probe that boots the store would apply every pending backfill as
  a side effect of ASKING, could never report PENDING, and would silently migrate the whole fleet on
  `--all-tenants`. `validateMigrations` (called from `createPramen`) rejects an empty/duplicate id
  or an unknown partition at boot.
- CMS collections (`@pramen/cms`): the block/page model is one opinionated shape (a routable
  page with a mandatory slug + regions of blocks). A **collection** is the generic escape
  hatch: it points the CMS editor at **one of YOUR OWN pramen entities** (spread into
  `defineSchema` next to `cmsSchema`) and edits it with the SAME `FieldDefinition[]` DSL that
  blocks use, so e.g. "Lectures" is a first-class, queryable entity (real columns, relations,
  cell-ACL) that ALSO gets a list/form UI, with no `cms_pages` row and no mandatory slug.
  `collection(slug, { entity, label, fields, list?, titleField?, idField?, orderBy? })`
  declares one (**column-mapped**: each scalar field is a real column; repeater/group map to a
  `t.json()` column). Wire with `createCollectionHandlers(collections, { schema })` (the schema is
  REQUIRED: the whole registry is validated against your entities at boot: managed columns
  exist and are nullable TEXT, declared fields map to columns that can hold them, `idField`
  is the PK, `orderBy` names a real column, the entity is in the default partition, and no
  two collections share an entity, which the ACL would OR-merge into a widened read scope;
  spread into handlers:
  `listCollections` for editor discovery + `collectionList`/`Get`/`Create`/`Update`/`Delete`,
  all `editorRoles`-gated AND row-ACL'd through `ctx.db`) and `collectionPolicies(collections)`
  (spread into the editor/admin role). Security: the generic handlers dispatch through a
  registry keyed by `slug` (an unknown slug is a 400, never a raw table reference) and writes
  are **whitelisted to declared fields** (a caller can't set an undeclared column like a
  `passwordHash`). The editor discovers collections at runtime (one generic editor, N
  collections, zero per-collection code): nav + `/collections/:slug` list + `/collections/:slug/:id`
  edit routes, all driven by `FieldForm`, plus the `supports` controls (publish/unpublish,
  schedule, preview link, revision restore) on a row. `supports` gates VISIBILITY, not
  content: a collection is column-mapped, so an edit to a published row goes live at once
  (no page-style staged snapshot). Scheduling converges in any drain order: a publish task
  that drains after its own takedown instant lands the row DOWN rather than publishing and
  discarding the takedown. See `example/app.ts` (the `lectures` collection).
- CMS site furniture (`@pramen/cms`): menus, redirects, taxonomies and widget areas, the
  WordPress-parity, SITE-level (not page-level) surface. Public READS (`getMenu`,
  `resolveRedirect`, `listTaxonomies`/`getTermTree`/`listPagesByTerm`, `getWidgetArea`),
  editor-gated writes; the tables are in both `cmsPolicies()` fragments. A **menu** is one
  `t.json()` document because it is read and written whole, and its items store a REFERENCE
  (`kind: "page" | "term" | "collection"`, `ref`) rather than the href an editor typed. The
  url is minted at read time through `menuHref`, so a link follows its page's slug. That
  resolution goes through `ctx.db`, so the anonymous page scope decides it: an item pointing
  at an unpublished page is DROPPED (with its subtree) instead of rendered as a dead link, and
  the editor reads `listMenus` (RAW) so editing against the resolved view can't delete those
  items on save. A **redirect**'s `fromPath` is canonicalized on write (trailing slash, query,
  fragment) because matching is an exact lookup on a unique column; there is deliberately NO
  hit counter, which would make the one handler anonymous 404 traffic calls a WRITE. **Terms**
  hang off `cms_page_terms`, an explicit `manyToMany` junction, with real `ON DELETE` FKs
  (cascade on an assignment, setNull on a parent, since cascade would silently delete a subtree)
  and a write-side cycle check, the only place a cycle is preventable (the FK keeps `parentId`
  pointing at a real row but says nothing about shape). **Widget areas** stay their own entity
  rather than a page-less `cms_blocks` region: making `pageId` nullable would push a null
  branch through every placement read and page-scoped policy to model something that shares
  no field with a page. `listCmsCapabilities().siteFurniture` declares the handlers exist, so
  an older server renders no section rather than one whose every screen 404s.
- Authoring a field SCHEMA (`normalizeFieldSchema`/`normalizeRegions`/`normalizeDefaultBlocks`)
  is checked server-side now that the editor writes it: `validateFields` checks a VALUE
  against a schema, this checks the schema. It is a refusal, not a warning, because nothing
  downstream fails visibly: `FieldForm` renders nothing for an unknown type, `validateFields`
  is documented as lenient about them, and the field's content is silently lost on every save;
  a duplicate sibling name is worse (two controls, one key, one of them unsaveable). Both a block
  type's and a content type's slug go through `assertRegistryKey`, so both admit `_`. They
  were split (block types yes, content types no) for no reason that survived inspection, and
  the example itself ships `seeded_doc`. A `defaultBlocks` entry naming an undeclared
  region, or a type its region disallows, is a 400 at declaration, but `createPage` STILL
  skips such a block, because a later `updateContentType` can narrow `allowedTypes` alone.
- Editor nav placement: `buildNav` (`cms-editor/src/nav.ts`) returns ORDERED entries and the
  layout only renders them. `NAV_ORDER` (in the leaf `cms/src/nav.ts`, mirrored in the
  editor's `types.ts`, since the editor has no server dependency) spaces the built-ins 100 apart;
  `CollectionDef.navOrder`, `AdminPageDef.navOrder` and an `extraNav` link's `order` place
  against them, and anything unset keeps the position it had. The sort is STABLE, which is
  what carries the groupings with no numeric expression (content-type tabs, collections
  sharing a position). This is what stops a project section from being structurally the last
  nav item in a new tab.
- `reference` field type: an OPAQUE id pointing at a row we may not own, resolved by a
  `referenceFrom` query handler that answers TWO shapes: `{ search?, limit, offset }` to
  browse and `{ ids }` to resolve labels for values already stored. The second is what
  `select` + `optionsFrom` cannot do: it fetches one page, so a stored value outside it
  renders as a uuid. `multiple: true` stores an array and needs a `t.json()` column
  (`fieldColumnTypes` is the one place a field's storage depends on a second flag).
- Block Kit / custom admin pages (`adminPage()` + `createAdminPageHandlers`, `cms/src/blockkit.ts`):
  the server describes a whole admin SCREEN as JSON and the editor renders it at `/apps/:slug`,
  so a project's odd 10% lives inside the chrome instead of behind an `extraNav` link in a new
  tab. `render` is an ordinary handler body with the CALLER's ctx: it removes the browser
  code, not the ACL, and is generic over the app schema (`adminPage<typeof schema>`, like
  `MigrationContext`). `listAdminPages` is role-FILTERED, and a forbidden page answers exactly
  as an unknown one (a distinct refusal tells an unauthorized caller which pages exist).
  `adminPageInteract` is a MUTATION even for `page_load`: otherwise which of the two entry
  points into the same function was transactional would depend on the `type` the client sent.
  The WHOLE page comes back on every interaction, with no patch protocol, which would have to
  agree with the host about what is on screen. `image.url` is `isSafeHref`-checked on the way
  OUT, because a page builds blocks from stored data. Deliberately NOT called a "virtual
  collection": `collection()` promises ACL, row scope, cell projection and `where` traversal
  because it is a REAL TABLE, and a handler-backed thing wearing that name would void all four.
- `@pramen/cms-astro` front door: `pramenCms({ backend: { url, tenant?, token? }, collections?, locale? })`
  is an Astro INTEGRATION (issue #35): it builds the client once and exposes it, `resolve()`
  and the generated collections through a `pramen:cms` virtual module (types injected). The
  site re-exports once: `export { collections } from "pramen:cms"`. Astro has NO API for an
  integration to define content collections (checked against Astro 7), so that one line is
  the honest version of "auto-registered". `collections: "auto"` (default) reads the un-gated
  `listPublicContentTypes` at `astro:config:setup` (build time has no editor session; slug +
  name only, never the regions/field schema) and FAILS the build if the CMS is unreachable:
  generating zero collections would deploy an empty site green. `createCmsClient`/`cmsLoader`
  stay exported for hand-wired collections.
- Native queues: `ctx.queue.send(binding, body, { delaySeconds?, contentType? })` /
  `sendBatch(binding, msgs, opts?)` (`runtime/queue.ts`): a facade + adapter seam (like
  `ctx.mail`) over **Cloudflare Queues**, distinct from `ctx.tasks` (NOT transactional with
  the write, but higher-throughput with platform batching/retry/DLQ and a cross-Worker
  consumer). Producer addressed by BINDING name; `createQueue` discovers any env binding
  with both `send`+`sendBatch`; an undeclared queue FAILS CLOSED (throws). Declare a
  `new Queue({ name, binding: "both", consumer })` in `oblaka.ts`. Consume via `app.queues`
  (keyed by queue NAME, env-prefixed remotely, matched leniently by `routeQueue`:
  exact→suffix→single-handler), dispatched by `createPramen().queue` (the CF
  `queue(batch,env)` entry; wire it next to `fetch`/`scheduled`). A consumer is
  Worker-level (no `ctx.db`): its ctx is `{ env, kv, mail, queue, callPrivileged }`. Reach a
  tenant DO via `callPrivileged` (the message carries the tenant). Per-message ack on
  resolve / retry on throw; an unrouted batch is retried whole, never silently acked
  (`runtime/queue-consumer.ts`).
- Email: `ctx.mail.send({ to, subject, text/html, from?, replyTo? })` (`runtime/mail.ts`)
  is a facade + adapter seam (like `ctx.files`). Transport from env, in this order:
  `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` + `MAIL_FROM` → **Mailgun** (`MAILGUN_API_BASE`
  for the EU region); `EMAIL` binding + `MAIL_FROM` → Cloudflare Email Sending (no API
  keys); `MAIL_CAPTURE=true` → capture to KV (`mail:<to>`, dev inbox); else `send` FAILS
  CLOSED (throws) so a misconfigured prod doesn't silently stash security emails. Built
  in dispatch + the task-drain contexts. Cloudflare only sends FROM a zone in the same
  account; Mailgun needs the domain verified once and is not tied to the account.
- `ctx.env` is the Worker/DO environment (bindings + vars + secrets), loosely typed.
  Use it to call external services from handlers (`ctx.env.STRIPE_SECRET_KEY as string`).
- No raw SQL in handlers: go through `ctx.db` (`find` is compiled by
  `runtime/read-engine.ts`). `ctx.db.exec` is an escape hatch.
- Reads are **column-projected**, never `SELECT *`: the compiled SELECT names the caller's
  readable columns (base ∪ conditional-`when` fields, or all-non-hidden when unrestricted)
  plus the PK / order / relation-join / `when`-input columns the engine needs, so
  `hidden()` and unreadable-for-this-caller columns never cross RPC (they were fetched by
  `SELECT *` then dropped in JS before). `find`/`page` also take an optional **`select:
  [...]`** projection to fetch only named columns (each must be readable; a hidden/
  unreadable one is a 403); the wide column a handler doesn't need then stays off the wire.
  This is the D1-over-RPC fix from GitHub #22. `Db.projectionColumns` in `runtime/db.ts`.
- `insert`/`update` echo the persisted row projected to the caller's readable fields
  ∪ the columns they wrote ∪ the PK. Never leaks an unreadable field, never `{}`
  (a write-only caller still gets the generated id). `projectWrite` in `runtime/db.ts`.
  "Readable" includes the read scope's `where`, judged on the persisted row (post-image):
  a caller who may update or create rows it cannot READ gets back only the PK and what it
  wrote. It used to get every readable column of such a row, which a `find` would never
  have returned. So a trash move (`deletedAt` set, row leaves a `deletedAt IS NULL` read
  scope) echoes narrowly too; read the row back with a scope that admits it if you need it.
- SQLite (DO) has no boolean type: booleans are stored as INTEGER 0/1; binding
  coercion lives in `runtime/db.ts` and `read-engine.ts`.
- CORS for browser clients is opt-in via the `CORS_ORIGINS` var (comma-separated
  origins or `*`); unset means same-origin only.

## DO SQLite

pramen runs on **Cloudflare DO SQLite**, its own engine, not stock sqlite3, so
don't assume sqlite3 C internals. Stick to the `SqlStorage` API
(`ctx.storage.sql.exec(sql, ...params)` → cursor `.toArray()`).
