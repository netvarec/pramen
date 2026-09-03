# pramen

Reactive backend runtime for TypeScript on **Cloudflare**. Define schema +
handlers, get a backend deployed as a Worker + Durable Object — the platform
provides the single-writer/storage/replication stack. Read `DESIGN.md` for the
architecture.

## WIP — everything is subject to change

Active development; nothing is stable. No backward-compat constraints — redesign
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

- **`@pramen/server`** (`.` export) is authoring-only — `Entity`/`defineSchema`,
  `createApp`, `query`/`mutation`, ACL, files, errors, the substrate seam. The
  **deploy** half — `createPramen` + the Durable Object — is **`@pramen/server/worker`**,
  split off because only it imports `cloudflare:workers`. So the CLI/tests/codegen
  can load an `app.ts` for its schema without dragging in the DO runtime.
- The DO + Worker are **parameterized by the app** (`pramenDO(app)` / `makeWorker(app)`),
  closed over by `createPramen` — no static app import in the runtime.
- **The DO is the database.** Single-writer serialization is free (a DO handles
  one request at a time), per-tenant via `idFromName`.
- **D1 is NOT the DO's write path** — it's over-RPC, not in-process; the DO's
  SQLite is its transactional store. D1 is instead available as a separate
  substrate via the Worker (`x-pramen-store: d1`) — see the Substrate seam below.
- **SDK (`packages/server/src/sdk/`) is platform-agnostic** — the portable product.
  `packages/server/src/runtime/` is the Cloudflare glue.

## Commands

```bash
bun install
bun run dev          # lopata dev (Bun runtime; fast reload + /__dashboard); http://localhost:8787
bun run dev:wrangler # wrangler dev (miniflare) — workerd-parity check before deploy
bun run typecheck    # tsc --noEmit (server + client + react)
bun run build        # tsc → dist (JS + .d.ts) for all 3 packages (for published Node consumers)
bun run deploy       # wrangler deploy
```

Prod config: secrets via `wrangler secret put` (AUTH_SECRET; FILES_SECRET ≥16 chars or
files fail closed). Destructive migrations are OFF unless `PRAMEN_ALLOW_DESTRUCTIVE=true`
(local dev sets it on). Packages use conditional `exports`: the `development`/`bun`/
`workerd` conditions resolve to `src` (so in-repo typecheck/tests/dev/deploy need no
build), while published Node consumers fall through to `dist` (`default`/`types`).
tsconfigs set `customConditions: ["development"]`.

Local dev runs on **lopata** (Bun-based CF runtime; fully emulates DO SQLite +
WebSocket Hibernation). It reads the oblaka-generated `wrangler.jsonc` unchanged and
serves a dashboard at `/__dashboard`. The e2e suite still boots real `wrangler dev`
(miniflare); run `bun run dev:wrangler` once before deploying to catch any
Bun-vs-workerd differences.

> pramen uses the published **lopata `^0.19.2`** from npm. It carries the two fixes
> pramen relies on: the proxy-to-DO deadlock (the canonical
> `stub.fetch(new Request(request, { headers }))` tripped a Bun `new Request(req)`
> stream-body clone bug) and DO SQLite surfacing `RETURNING` rows from `exec()`.
> `bunfig.toml` exempts lopata from a global `minimumReleaseAge` so a fresh lopata
> release installs immediately (other deps still honor the policy).

## Substrate seam (Driver/Dialect)

The data layer runs over a `Driver` (async `exec` + `transaction`) + `Dialect`
(`packages/server/src/runtime/driver.ts`), so the ACL/read/write engine is substrate-agnostic:

- **`DoSqliteDriver`** — the DO's in-process SQLite (the default write path).
- **`D1Driver`** — the SAME engine over a real D1 binding, run **in the Worker**
  (no DO) and selected per-request with the `x-pramen-store: d1` header. RPC only —
  live queries need the DO (single writer + socket host). Proven end-to-end in
  miniflare by `test/suites/d1.ts` (ACL, row scope, field/cell-level projection,
  RETURNING writes, aggregates). The D1 binding is declared in `oblaka.ts`.
- **The D1 boot is a `SharedBoot`, never a bare memoized promise** (`runtime/boot.ts`, #51).
  Workers rule: async work belongs to the invocation that started it, and when that invocation
  ends (the caller disconnects) its pending I/O is canceled — a promise chained on canceled I/O
  NEVER SETTLES, it does not reject. A once-per-isolate boot memoized from the first request's
  D1 calls therefore wedged every later fetch in the isolate for its lifetime (0 ms CPU, no logs)
  once a proxy timed out the legitimately slow first request after a deploy; crons in another
  isolate stayed healthy, a redeploy "fixed" it. So: the starter puts the boot under
  `ctx.waitUntil` (pass `ctx` from EVERY entry — fetch, routes, admin, `scheduled`), and awaiters
  treat a boot with no statement progress for `D1_BOOT_STALE_MS` (30 s, the `waitUntil` cap) as
  orphaned and start their own. Apply the same rule to any future per-isolate memo of I/O.
- **`postgresDialect`** — shows the SQL shape for a future Hyperdrive/Postgres port
  (quoting + `$n` placeholders); needs a pg `Driver` over Hyperdrive.

## File storage (R2)

Files live in **R2**, not the DB. A `fileRef` column (`t.fileRef()`) stores only
JSON metadata (`FileRef`: `{ key, size, contentType, filename?, uploadedAt? }`) in a
TEXT cell — the bytes are an R2 object addressed by a tenant-scoped key. The object
store is behind a `StorageAdapter` seam (`R2Adapter`/`MemoryAdapter` in
`runtime/storage.ts`), mirroring the Driver/Dialect seam.

- Handlers use **`ctx.files`** — never the R2 binding directly:
  - `signUpload({ contentType, filename?, maxSize?, prefix? })` → `{ url, ref }` (a
    signed PUT url + draft metadata to attach later).
  - `signDownload(ref, { download? })` → `{ url, expiresAt }` — mint ONLY after an
    ACL'd `ctx.db` read; knowing a key is not authorization.
  - `head(key)` / `delete(key)` for upload-verify and cascade.
- The Worker serves `/files/upload` (PUT) + `/files/download` (GET), authorized by an
  HMAC token (`FILES_SECRET`, falls back to `AUTH_SECRET`) in the url. Bytes stream
  in the Worker — they never pass through the DO. Signed urls are RELATIVE; the
  client resolves them (`@pramen/client` `fileUrl()`/`upload()`).
- The object↔JSON codec lives at the `Db` chokepoint, so handlers always see/write
  `FileRef` objects. R2 is declared in `oblaka.ts` (`FILES` binding).

The same shape (adapter + `ctx.<service>` facade + Worker glue) is how other
Cloudflare services should be added (e.g. email via the Send service as `ctx.mail`).

## Partitions

An entity may declare a **`partition`** — the Durable Object class it lives in:
`Entity(t => ({...}), undefined, { partition: "audit" })`. The default is a single
partition (`"default"`), i.e. **one DO per tenant** — the original model. Partitioning
splits a tenant's data across multiple DOs (e.g. a hot path vs. an append-only audit
log) for independent single-writer serialization and storage.

- A partition-DO **only sees its own partition's tables**: migrate/admin/CLI are all
  **per-partition** — each partition is migrated, hashed (`schema_hash:<partition>` in
  `_pramen_meta`), and reported independently. `sdk/schema.ts` provides
  `partitionsOf(schema)` / `entitiesInPartition(schema, p)` / `partitionOf(schema, e)`
  / `DEFAULT_PARTITION` to enumerate/resolve them; `validateSchema(schema)` enforces the
  static invariants (relation targets exist; no relation crosses a partition).
- **Cross-partition relations, `with` eager-loads, and transactions are rejected** — a
  DO can't reach into another DO's SQLite. A relation whose source and target are in
  different partitions fails `validateSchema` at boot (and codegen). Keep related
  entities in the same partition.
- **Backward-compat invariant — DO NOT break:** the default partition uses the **bare**
  DO key `idFromName(tenant)` (NOT `idFromName(tenant:default)`), so a pre-partitions
  store is byte-for-byte the same DO. `partitionDoName(tenant, partition)` in
  `runtime/registry.ts` encodes this: bare `tenant` for `"default"`, `${tenant}:${partition}`
  otherwise. Routing and the tenant registry both go through it, so they stay in lockstep —
  any future change to DO addressing must preserve the bare-key form for the default partition.
- Admin/CLI address one partition at a time: `/admin/schema?tenant=&partition=` returns
  that partition's applied schema; `/tenants` returns `{ tenant, partition }[]`. The CLI's
  `schema status` loops `partitionsOf(app.schema)`, fetching + comparing each partition
  (a single-partition app reads identically to before).

## Conventions

- Schema: `Entity(t => ({ id: t.id(), ... }))` + `defineSchema({ table: Entity })`.
  Field builders: `id`/`textId`/`text`/`int`/`real`/`bool`/`json`/`fileRef`/`uuid`. `json`
  and `fileRef` are stored as TEXT and object↔JSON-codec'd at the `Db` chokepoint —
  handlers read/write the parsed value (a `JsonValue` / `FileRef`). `uuid` is a TEXT
  column typed as `string`; a supplied value is validated (`isValidUuid`) on write and
  rejected (400) if malformed. Modifiers are wrapper helpers (compose like
  `renamedFrom`): `notNull()`, `unique()`, `indexed()`, `defaultTo(v)`, `primaryKey()`,
  `generated()`, `hidden()` — e.g. `code: unique(t.text())`, `status: defaultTo(t.text(), "pending")`.
  `hidden()` marks a column never-readable through the ORM (stripped from every read
  projection — find/get, mutation echoes, relation loads, SYSTEM-mode `/admin/data` —
  even under `allow()`/SYSTEM; still writable + visible to raw `ctx.db.exec`). For
  secrets like a password hash. `primaryKey()` marks any column the PK (implies NOT NULL); `generated()` auto-mints a
  uuid on insert via `crypto.randomUUID()` (uuid-only) and makes the column optional on
  insert. The canonical UUID primary key is `id: primaryKey(generated(t.uuid()))`.
  `defaultTo` also takes a SQL-expression default via the `expr` helper — `expr.now()`
  (the current UTC instant as ISO-8601 TEXT with millis and a `Z`, byte-identical to
  `new Date().toISOString()`) or `expr.raw(sql)` — emitted unquoted and parenthesized
  (`DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`), e.g.
  `createdAt: defaultTo(t.text(), expr.now())`. Expr-default columns are optional on
  insert (the DB fills them); adding one to an existing table triggers a table rebuild
  (SQLite forbids `ALTER ADD COLUMN` with a non-constant default), which is additive
  (backfills existing rows) and ungated.
- `expr.now()` EMITS ISO-8601 (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), not the
  `datetime('now')` space form it used to. Two reasons, both silent failures: the space form
  does not compare against `$now()` (which is ISO), and it is second-resolution. The
  comparison bug is narrower than "inconsistent" and worth knowing exactly — both forms open
  with `YYYY-MM-DD`, so different DATES still order correctly; it is the SAME date that
  breaks, where index 10 decides and `' '` (0x20) always sorts below `'T'` (0x54) whatever
  the time-of-day. So a space-form value dated today is always `<= $now()`, i.e. a row
  scheduled for later TODAY reads as already published until midnight. Changing the default
  is a MODIFIER change, so `migrate()` rebuilds the table — and a rebuild COPIES values
  through, leaving both formats mixed in one column. `isoTimestampBackfill()` (from
  `@pramen/server`, `sdk/iso-timestamps.ts`) is the rewrite: a `DataMigration` an app spreads
  into `app.migrations`, scanning the schema for `expr.now()` columns plus any the app names
  via `extraColumns` (`@pramen/cms` exports `CMS_LEGACY_TIMESTAMP_COLUMNS` for
  `cms_pages.publishedAt`, which was stamped from handler code and so has no default to
  find). Bulk `driver.exec` UPDATE, guarded on `length=19 AND substr(col,11,1)=' '` — a third
  format is left alone rather than guessed at, and the guard makes it idempotent by shape.
  Safe to declare on a fresh store: every UPDATE matches no rows. In `@pramen/cms` this
  collapsed `nowStamp`/`isoStamp` into one helper — the two existed only because one column
  could not satisfy both comparison requirements.
- Auth/ACL: an unauthenticated caller is the `anonymous` role (define it for public
  reads/writes; absent ⇒ deny). A policy `where` may use `$identity("path")` (caller),
  `$input("path")` (request input — a capability/by-unguessable-key read), or `$now()`
  (the evaluation instant, as an ISO-8601 UTC string — for a time-boxed grant like
  scheduled publication: `{ publishedAt: { lte: $now() } }`, which `isNull: false`
  can't express since a future timestamp is non-null. Lexicographic TEXT comparison, so
  the column must hold `toISOString()` values — which `expr.now()` now produces, having
  emitted the `datetime('now')` space form until `isoTimestampBackfill()` landed). Public,
  pre-auth routes go in `app.routes` (matched before auth; use `ctx.callPrivileged`
  to run a privileged handler) — for signature-authed webhooks.
- `ctx.callPrivileged` works on BOTH stores. It used to only forward to the DO, so
  everything built on a pre-auth route (signed preview links, the sitemap) was DO-only and
  the CMS REFUSED to mint preview links on D1 rather than hand out a dead one. On D1 the
  engine runs in the Worker, so it now dispatches locally there — both paths share one
  `dispatchD1`, so migration/bootstrap/the multi-tenant commingling guard/the outbox drain
  cannot drift, and a privileged call pins `first-primary` because it may write. This is
  what makes D1 a first-class CMS store, which matters because D1 is a BINDING: nothing
  needs exporting from the worker entry, so the CMS can live inside an Astro site's Worker.
  The store is per-REQUEST and a browser redeeming a link sends no `x-pramen-store`, so a
  mixed deployment needs `PRAMEN_STORE=d1` (an embedded topology sets it anyway).
- Per-handler call authorization (the ACL only gates `ctx.db`): `query(fn, { auth })` /
  `mutation(fn, { auth })` where `auth` is `"authenticated"` | `string[]` (one-of role) |
  `(identity) => boolean`, enforced in `runtime/dispatch.ts` BEFORE the handler runs
  (throws 403). Gate any handler that touches `ctx.kv`/`ctx.env`/`ctx.mail`/`ctx.tasks`
  directly — those bypass the row-ACL, so un-gated they're callable by anyone. Absent ⇒
  open. `authorizeHandler(auth, identity)` is the pure check. `createApp` forwards `auth`.
- `@pramen/auth` (optional, verify-only core stays BYO-IdP): `authSchema` + `authHandlers`
  (`signup`/`login`/`me`, PBKDF2, server-assigned roles, HS256 tokens via `AUTH_SECRET`).
  `signup` takes an OPTIONAL `email` (validated, unique, stored UNVERIFIED). `auth_users`
  columns: `username` (PK = JWT `sub`), `passwordHash` (`hidden()`), `roles`, unique mutable
  `email`, `emailVerified` (epoch ms the current email was confirmed; NULL = unverified),
  `active` (deactivation flag — blocks login). Also:
  `createMagicLinkAuth({ sendEmail })` (passwordless one-time links; transport is the
  app's — Cloudflare Email Sending via the `send_email`/`EMAIL` binding declared in
  `oblaka.ts`; magic-link users keyed on the immutable `username`, never the mutable
  `email`); `createUserHandlers({ table })` + `authPolicies({ table, prefix, adminReadFields, … })`
  for ACL-gated admin (`listUsers`/`setUserRoles`/`setUserActive`/`deleteUser`) + self
  (`changeEmail`/`changePassword`) management — over `auth_users` or your own
  authSchema-shaped table (`changeEmail` clears `emailVerified`, since the new address is
  unconfirmed). Session TTL via `AUTH_SESSION_TTL_SECONDS` (default 3600). The stateless
  verify-only core closes the "roles are baked into the token" gap two ways, no session store:
  **`refreshSession`** (in `authHandlers` + `createMagicLinkAuth`, authenticated) re-reads
  roles/active and reissues a token — a client refreshing at ~half-TTL lets the TTL stay short
  (bounded revocation lag) and picks up a role GRANT immediately (no re-login); and a **KV
  denylist** for HARD revocation — `setUserActive(false)`/`deleteUser` write `authDenied:<username>`
  (self-expiring at the session TTL, lifted on reactivation), which the core Worker checks right
  after `resolveIdentity` and fails a revoked token CLOSED (401 — not a downgrade to anonymous),
  covering HTTP + the WS upgrade. Helpers `denySession`/`allowSession`/`isSessionDenied` are
  exported from `@pramen/server` for app-driven revocation. A live WebSocket also re-checks the
  token's `exp` per message (identity is fixed at upgrade), closing 4401 so a socket can't outlive
  its TTL.
- OIDC login (`@pramen/auth`, opt-in): `createOidcAuth({ issuer, clientId, clientSecret?,
  redirectUri, successRedirect })` → `{ routes }` (spread into `app.routes` — PRE-AUTH) plus
  `oidcHandlers` (spread into handlers). Authorization code + PKCE S256, discovery via
  `/.well-known/openid-configuration`, `state`+`nonce` in KV (single-use: read-and-DELETE
  before the exchange), ID token verified by the same `JwksStrategy` the Worker uses
  (signature/iss/aud/exp) plus a nonce match. Exchanges for a PRAMEN session, not a
  passthrough of the IdP token — that keeps `refreshSession`, the KV denylist and
  role-in-token ACL working. The session lands in the redirect's URL FRAGMENT (never sent to
  a server). Roles: `mapRoles(claims)` when the IdP is authoritative (Entra `roles`,
  Auth0/Okta namespaced claim) — it overwrites stored roles on every login, removals
  included — else the row's stored roles (Google Workspace ships none), else `defaultRoles`.
  Accounts key on the VERIFIED email by default (links with magic-link/password rows); an
  unverified email is REFUSED, not silently keyed on `sub`. `accountKey: "sub"` namespaces by
  issuer instead. `active = false` still blocks login. The write goes through
  `callPrivileged` → `__oidcUpsertUser`, which is `auth: []` so no role can reach it over
  /rpc. The callback sets ONE cookie (`pramen_oidc`, HttpOnly/SameSite=Lax/callback-path,
  cleared on completion) binding `state` to the browser that started the login — without it
  an attacker's valid state+code fed to a victim's browser signs the victim in AS THE
  ATTACKER; sessions themselves stay bearer tokens. The error page escapes centrally and
  echoes only RFC 6749-shaped codes: it is public, pre-auth and reachable with arbitrary
  query params, so raw interpolation was a reflected XSS on the app's own origin.
  Verify-only (BYO-IdP via `JWKS_URL`) remains the zero-config path.
- Password reset + email verification (`@pramen/auth`, opt-in): two one-time-email-token
  flows built on the magic-link machinery — mint a random token, store only its SHA-256
  **hash** + expiry in the shared `emailTokenSchema` table (`auth_email_tokens`, discriminated
  by `purpose` "reset"|"verify"), email the raw token from a TASK (off the write path), redeem
  once. Spread `emailTokenSchema` if you use either; wire the returned `.tasks` or the email
  never sends. **`createPasswordReset({ sendEmail, table?, linkTtlSeconds? })`** →
  `requestPasswordReset({ email })` (anonymous, enumeration-safe — always `{ ok: true }`,
  sends only when an ACTIVE account matches) + `resetPassword({ token, newPassword })`
  (anonymous, single-use, sets `passwordHash`; account must still exist + be active). Default
  link TTL 1h. **`createEmailVerification({ sendEmail, table?, linkTtlSeconds? })`** →
  `requestEmailVerification()` (AUTHENTICATED — verifies the caller's OWN current email; runs
  right after signup when the client holds the session token; no-op if already verified, 400 if
  no email) + `verifyEmail({ token })` (anonymous, stamps `emailVerified`, GUARDS that the
  account's current email still equals the address the token was minted for, so a later
  `changeEmail` invalidates a pending token). Default link TTL 24h. `sendEmail` gets
  `{ email, token, username }`; tasks are `sendPasswordResetEmail` / `sendVerificationEmail`.
  See `example/app.ts` for the wiring (dev `__pwResetInbox`/`__verifyInbox` mirror `__magicInbox`).
- Relations: `belongsTo(target, column)` / `hasMany(target, column)`,
  `oneHasOne(target, column)` / `oneHasOneInverse(target, column)` (single-valued 1:1 —
  mark the FK column `unique()` for the DB guarantee), and
  `manyToMany(target, { through, sourceColumn, targetColumn })` (**logical**: an **explicit
  junction entity** you write to directly — `ctx.db.insert(through, …)` to link, `delete` to
  unlink; no synthetic tables/write API). All must keep source/junction/target in one partition.
- **Real foreign keys** are **opt-in** on an owning relation via `onDelete`:
  `belongsTo(target, column, { onDelete: "cascade" | "setNull" | "restrict" })` (also
  `oneHasOne`) emits a `FOREIGN KEY … REFERENCES … ON DELETE` enforced by the engine on
  both DO and D1 (cascade/set-null/restrict + insert integrity). Without `onDelete` a
  relation stays logical (no constraint, no migration). Adding/changing an FK is a table
  rebuild (SQLite can't ALTER it): deferred on the DO's boot transaction, and via the D1
  driver's atomic `batch()` on D1; an FK over orphaned data is skipped + reported, not fatal.
  Rebuilding a table that live FKs REFERENCE quarantines + restores the referencing tables
  inside the same atomic step (`DROP TABLE parent` implicit-DELETEs its rows, and
  `defer_foreign_keys` defers only checks, NOT ON DELETE actions — without the quarantine a
  parent rebuild would cascade-wipe/null the children or abort on RESTRICT); a
  self-referential FK swaps through a bare FK-less copy for the same reason.
- `where` can traverse relations: `{ owner: { name: "x" } }` (belongsTo/hasMany) or
  `{ tags: { name: "x" } }` (manyToMany, via a nested subquery through the junction)
  compiles to a subquery in both user queries and policy `where`; `with: { tags: true }`
  eager-loads the target list through the junction. The related entity's read scope is
  AND-merged (traversal can't widen access; an unreadable target drops out). Cell-`when`
  predicates stay single-table.
- `where` string ops: `like` (raw `%`/`_` wildcards) plus `contains`/`startsWith`/`endsWith`
  (auto-escape the needle so `%`/`_` are literal; case-insensitive). `NOT: { … }` negates a
  nested clause; `AND`/`OR` take arrays. Composite uniqueness: `Entity(fields, relations,
  { unique: [["a","b"]] })` (a managed multi-column unique index); single-column stays `unique(t.x())`.
- Handlers: `query()` / `mutation()` from `@pramen/server`. Context is
  `{ db, kv, files, env, identity, tasks, mail, queue }`. Mutations are auto-wrapped in
  `storage.transaction()` by `runtime/dispatch.ts` (commit on return, rollback on
  throw) — do not write transaction control in handler code. Raw `BEGIN`/`COMMIT`
  via `sql.exec` is rejected by DO SQLite.
- Deferred side-effects (notification email, webhooks): `ctx.tasks.enqueue({ kind,
  payload, delayMs? })` writes to the `_pramen_outbox` table in the SAME transaction
  as the mutation (atomic), and `app.tasks[kind]` runs it after commit, off the write
  path — at-least-once with retry/backoff, dead-letter, and a `meta.id` idempotency key
  (`runtime/outbox.ts`). The DO self-drains via an alarm scheduled at the next due time;
  the D1 store has NO alarm, so a DELAYED task runs only under a Cron trigger — the Worker
  warns once per isolate when a request-tail drain leaves a future-due task and no Cron
  drain has been seen (`shouldWarnMissingCron`), and stops once one fires;
  the D1/Worker store (no alarm) drains via a Cron Trigger (`createPramen().scheduled`)
  or `POST /admin/tasks/drain` (`x-pramen-store: d1`). Admin: `/admin/tasks/drain`,
  `/admin/tasks/list` (both stores). Concurrent drains claim disjoint batches.
- Declarative triggers: an entity may declare `triggers: [trigger({ task, on: { create?,
  update?: true | string[], delete? } })]` (3rd `Entity` arg). On a matching ORM write the
  `Db` write path auto-enqueues `task` (payload `{ entity, op, id, row }`) in the write's
  transaction — no `ctx.tasks.enqueue` in the handler. A field-filtered update fires only
  on an actual value CHANGE; `hidden()` columns are stripped from the payload; raw
  `ctx.db.exec` and task-handler writes (suppressTriggers) don't fire triggers (no
  cascade); `createPramen` rejects a trigger whose `task` has no `app.tasks` handler.
- CMS locales (`@pramen/cms`): a deployment DECLARES what it publishes in —
  `createCmsHandlers({ locales: ["cs", "en"] })` — and the editor renders its i18n surface
  off `listCmsCapabilities` (the pages-side counterpart to a collection's `supports: [...]`),
  never off a client flag. One locale ⇒ monolingual: no i18n chrome, and the editor stops
  sending `locale` on a save so nothing overwrites a field it no longer shows. `locales[0]`
  IS the default stamp (no separate `defaultLocale` to disagree with it). Deliberately not
  inferred from the data: `createTranslation` is only reachable from the panel that would be
  hidden, so "show i18n once a 2nd locale exists" can never become true. `listLocales` stays
  a DATA query (what is authored), distinct from what is declared.
- Bootstrap (code-defined reference data): `app.bootstrap: BootstrapFn[]` runs once after
  schema migration on each boot (DO first-fetch / D1 isolate init) with a privileged system
  `Db` — converge code-declared reference data (content types, block types, roles, flags)
  into the store so a fresh/reprovisioned DB matches the repo, no manual seeding. Idempotent
  (upsert, don't blind-insert); a throw is logged, never fatal; DO path runs default-partition
  only. `@pramen/cms` ships `defineContentType`/`defineBlockType` + `cmsBootstrap({ blockTypes,
  contentTypes })` (upsert-by-slug) — see `example/app.ts`. Every row `cmsBootstrap` writes is
  stamped **`managedBy: <owner>`**, because convergence and the type editor (#46) point at the same
  rows: an editor added a field, got a 200, and lost it at the next cold start when `upsertBySlug`
  patched `fieldsSchema` back to the literal in `app.ts` — orphaning the block content authored
  against it. `updateBlockType`/`updateContentType` now 409 on an owned row (the row exists and the
  edit is well-formed; the conflict is with a definition the request can't reach) and the builder
  renders it read-only. The guard reads `managedBy` through an explicit `select` and THROWS if the
  column is absent: reads are column-projected, so "absent ⇒ editable" would have disarmed the
  guard for exactly the deployments that restrict read `fields`. An OWNER id, not a boolean,
  because `app.bootstrap` is an ARRAY — a sweep can't tell "not mine" from "no longer declared",
  so two `cmsBootstrap` calls released each other's rows every boot; each now releases only what
  it wrote, and a package can ship block types beside the app's via `{ owner }`. A type that drops
  out of the declaration is released (a lock with nothing behind it is worse than no lock) — and
  `blockTypes: []` DECLARES none (sweeps) where an absent key says nothing about that table, which
  is also the in-band way to hand everything back before deleting the reconciler. `upsertBySlug`
  never ADOPTS a row it doesn't own: overwriting an editor-authored type of the same slug and then
  locking it was #48's mirror image, unrepairable from the editor.
  Validation lives on `cmsBootstrap`, NOT on `define*`: those helpers are optional and
  `BlockTypeDef` is a structural interface, so a literal/`.map`/codegen reaches the store without
  them — guarding the helper guarded the convenient path and left the sink open. It runs the
  editor's own rules (`normalizeFieldSchema`/`normalizeRegions`/`normalizeDefaultBlocks`), reports
  EVERY bad definition at once, and throws at APP CONSTRUCTION like `validateCollections` /
  `validateMigrations` — which is not the "logged, never fatal" rule above: that governs the
  `BootstrapFn` at boot, and there each row is reconciled in its own try/catch so one failure
  can't skip the rest and both sweeps. `define*` stay PURE constructors, so `BlockFieldsOf<typeof
  def>` still describes the array that gets stored (canonicalizing there rebuilt every entry and
  made the `as unknown as F` cast a lie). `listCmsCapabilities().codeDefinedTypes` declares the
  whole thing, because `@pramen/cms-editor` has no dependency on `@pramen/cms` and a newer editor
  against an older server reads "no owner on any row" as "nothing is code-defined" — #48 again, in
  the deployment that upgraded to fix it.
- Data migrations (structure is declarative, DATA is imperative and RECORDED): `app.migrations:
  DataMigration[]` — `{ id, partition?, up(ctx) }` — runs in DECLARATION order after `migrate()`
  and before `bootstrap`, each at most ONCE per `(id, partition)`, recorded in the internal
  `_pramen_migrations` ledger IN THE SAME TRANSACTION as its work (`runtime/data-migrations.ts`).
  `migrate()` diffs SHAPES, so it can only enact structure — a backfill/split/unit-rewrite/json
  normalization has no declarative form. `ctx` is `{ db, driver, schema, partition }`: privileged,
  SYSTEM-scoped, triggers suppressed (`MigrationContext<typeof schema>` for a typed `db`); prefer a
  bulk `driver.exec` UPDATE over walking rows. The deliberate INVERSE of `bootstrap` on every axis:
  once-ever vs every-boot, NOT-required-idempotent vs must-be, user rows vs reference data, and
  **fail closed** vs logged-and-swallowed — a throw writes no ledger row, aborts the boot (so the
  later migrations don't run either) and retries on the next fetch; swallowing a half-finished
  backfill is the one outcome worth bricking a boot over. The schema hash proves nothing here (it
  hashes the declared shape). Keyed `(id, partition)` like `schema_hash:<partition>`: each
  partition-DO runs its OWN partition's migrations; D1 is one shared DB with no partition split, so
  there EVERY declared migration runs (recorded under its own partition key). The ledger row is
  CLAIMED UNDER A LEASE before the work, not written after: on D1 there is no single writer and
  the boot memo is per-isolate, so without a lock two cold isolates would each read an empty ledger and
  both run a `n = n * 2` backfill. One atomic upsert (`ON CONFLICT … DO UPDATE … WHERE leaseUntil <=
  now RETURNING`) inserts, or STEALS an expired lease, or does nothing — `RETURNING` says which.
  `leaseUntil` non-NULL = in flight, NULL = applied, and only applied counts (an in-flight row reads
  as PENDING in the admin ledger). A runner meeting a LIVE lease WAITS (≤5s) then fails closed — it
  must never skip past one, which would serve traffic against half-migrated data and strand the
  migration if the holder failed. `DEFAULT_LEASE.ttlMs` (60s) must EXCEED the slowest migration or
  the lease expires under a live holder and you get the double-apply back. D1's `transaction(fn) =
  fn()` means claim and work are NOT atomic there, so a throw RELEASES the claim (a compensating
  DELETE guarded on `leaseUntil IS NOT NULL`, rolled back harmlessly on the DO) and a holder that
  DIES without releasing is recovered by the lease expiring — prefer `WHERE col IS NULL`-shaped SQL. NO down migrations. `up()` runs inside `blockConcurrencyWhile` on
  a tenant's first fetch with no chunking/resume — keep backfills bounded or you stall that request
  and risk the DO wall-clock limit. PRUNING TRAP (same as `renamedFrom`): migration is lazy and
  per-DO, so a cold tenant is unmigrated until touched — never delete an id on a hunch; check
  `pramen migrations status --all-tenants` (`GET /admin/migrations?tenant=&partition=`, admin-gated,
  both stores; `--store d1` for a D1 deploy) first. That read is deliberately READ-ONLY on both paths
  — routed BEFORE `ensureMigrated` in the DO and skipping `ensureD1Migrated` in the Worker, tolerating
  an absent ledger table — because a probe that boots the store would apply every pending backfill as
  a side effect of ASKING, could never report PENDING, and would silently migrate the whole fleet on
  `--all-tenants`. `validateMigrations` (called from `createPramen`) rejects an empty/duplicate id
  or an unknown partition at boot.
- CMS collections (`@pramen/cms`): the block/page model is one opinionated shape (a routable
  page with a mandatory slug + regions of blocks). A **collection** is the generic escape
  hatch — it points the CMS editor at **one of YOUR OWN pramen entities** (spread into
  `defineSchema` next to `cmsSchema`) and edits it with the SAME `FieldDefinition[]` DSL that
  blocks use, so e.g. "Lectures" is a first-class, queryable entity (real columns, relations,
  cell-ACL) that ALSO gets a list/form UI — no `cms_pages` row, no mandatory slug.
  `collection(slug, { entity, label, fields, list?, titleField?, idField?, orderBy? })`
  declares one (**column-mapped**: each scalar field is a real column; repeater/group map to a
  `t.json()` column). Wire with `createCollectionHandlers(collections, { schema })` (the schema is
  REQUIRED — the whole registry is validated against your entities at boot: managed columns
  exist and are nullable TEXT, declared fields map to columns that can hold them, `idField`
  is the PK, `orderBy` names a real column, the entity is in the default partition, and no
  two collections share an entity, which the ACL would OR-merge into a widened read scope;
  spread into handlers —
  `listCollections` for editor discovery + `collectionList`/`Get`/`Create`/`Update`/`Delete`,
  all `editorRoles`-gated AND row-ACL'd through `ctx.db`) and `collectionPolicies(collections)`
  (spread into the editor/admin role). Security: the generic handlers dispatch through a
  registry keyed by `slug` (an unknown slug is a 400, never a raw table reference) and writes
  are **whitelisted to declared fields** (a caller can't set an undeclared column like a
  `passwordHash`). The editor discovers collections at runtime (one generic editor, N
  collections, zero per-collection code) — nav + `/collections/:slug` list + `/collections/:slug/:id`
  edit routes, all driven by `FieldForm` — plus the `supports` controls (publish/unpublish,
  schedule, preview link, revision restore) on a row. `supports` gates VISIBILITY, not
  content: a collection is column-mapped, so an edit to a published row goes live at once
  (no page-style staged snapshot). Scheduling converges in any drain order — a publish task
  that drains after its own takedown instant lands the row DOWN rather than publishing and
  discarding the takedown. See `example/app.ts` (the `lectures` collection).
- CMS site furniture (`@pramen/cms`): menus, redirects, taxonomies and widget areas — the
  WordPress-parity, SITE-level (not page-level) surface. Public READS (`getMenu`,
  `resolveRedirect`, `listTaxonomies`/`getTermTree`/`listPagesByTerm`, `getWidgetArea`),
  editor-gated writes; the tables are in both `cmsPolicies()` fragments. A **menu** is one
  `t.json()` document because it is read and written whole, and its items store a REFERENCE
  (`kind: "page" | "term" | "collection"`, `ref`) rather than the href an editor typed — the
  url is minted at read time through `menuHref`, so a link follows its page's slug. That
  resolution goes through `ctx.db`, so the anonymous page scope decides it: an item pointing
  at an unpublished page is DROPPED (with its subtree) instead of rendered as a dead link, and
  the editor reads `listMenus` (RAW) so editing against the resolved view can't delete those
  items on save. A **redirect**'s `fromPath` is canonicalized on write (trailing slash, query,
  fragment) because matching is an exact lookup on a unique column; there is deliberately NO
  hit counter, which would make the one handler anonymous 404 traffic calls a WRITE. **Terms**
  hang off `cms_page_terms`, an explicit `manyToMany` junction, with real `ON DELETE` FKs
  (cascade on an assignment, setNull on a parent — cascade would silently delete a subtree)
  and a write-side cycle check, the only place a cycle is preventable (the FK keeps `parentId`
  pointing at a real row but says nothing about shape). **Widget areas** stay their own entity
  rather than a page-less `cms_blocks` region: making `pageId` nullable would push a null
  branch through every placement read and page-scoped policy to model something that shares
  no field with a page. `listCmsCapabilities().siteFurniture` declares the handlers exist, so
  an older server renders no section rather than one whose every screen 404s.
- Authoring a field SCHEMA (`normalizeFieldSchema`/`normalizeRegions`/`normalizeDefaultBlocks`)
  is checked server-side now that the editor writes it: `validateFields` checks a VALUE
  against a schema, this checks the schema. It is a refusal, not a warning, because nothing
  downstream fails visibly — `FieldForm` renders nothing for an unknown type, `validateFields`
  is documented as lenient about them, and the field's content is silently lost on every save;
  a duplicate sibling name is worse (two controls, one key, one of them unsaveable). Both a block
  type's and a content type's slug go through `assertRegistryKey`, so both admit `_` — they
  were split (block types yes, content types no) for no reason that survived inspection, and
  the example itself ships `seeded_doc`. A `defaultBlocks` entry naming an undeclared
  region, or a type its region disallows, is a 400 at declaration — but `createPage` STILL
  skips such a block, because a later `updateContentType` can narrow `allowedTypes` alone.
- Editor nav placement: `buildNav` (`cms-editor/src/nav.ts`) returns ORDERED entries and the
  layout only renders them. `NAV_ORDER` (in the leaf `cms/src/nav.ts`, mirrored in the
  editor's `types.ts` — the editor has no server dependency) spaces the built-ins 100 apart;
  `CollectionDef.navOrder`, `AdminPageDef.navOrder` and an `extraNav` link's `order` place
  against them, and anything unset keeps the position it had. The sort is STABLE, which is
  what carries the groupings with no numeric expression (content-type tabs, collections
  sharing a position). This is what stops a project section from being structurally the last
  nav item in a new tab.
- `reference` field type: an OPAQUE id pointing at a row we may not own, resolved by a
  `referenceFrom` query handler that answers TWO shapes — `{ search?, limit, offset }` to
  browse and `{ ids }` to resolve labels for values already stored. The second is what
  `select` + `optionsFrom` cannot do: it fetches one page, so a stored value outside it
  renders as a uuid. `multiple: true` stores an array and needs a `t.json()` column
  (`fieldColumnTypes` is the one place a field's storage depends on a second flag).
- Block Kit / custom admin pages (`adminPage()` + `createAdminPageHandlers`, `cms/src/blockkit.ts`):
  the server describes a whole admin SCREEN as JSON and the editor renders it at `/apps/:slug`,
  so a project's odd 10% lives inside the chrome instead of behind an `extraNav` link in a new
  tab. `render` is an ordinary handler body with the CALLER's ctx — it removes the browser
  code, not the ACL — and is generic over the app schema (`adminPage<typeof schema>`, like
  `MigrationContext`). `listAdminPages` is role-FILTERED, and a forbidden page answers exactly
  as an unknown one (a distinct refusal tells an unauthorized caller which pages exist).
  `adminPageInteract` is a MUTATION even for `page_load`: otherwise which of the two entry
  points into the same function was transactional would depend on the `type` the client sent.
  The WHOLE page comes back on every interaction — no patch protocol, which would have to
  agree with the host about what is on screen. `image.url` is `isSafeHref`-checked on the way
  OUT, because a page builds blocks from stored data. Deliberately NOT called a "virtual
  collection": `collection()` promises ACL, row scope, cell projection and `where` traversal
  because it is a REAL TABLE, and a handler-backed thing wearing that name would void all four.
- `@pramen/cms-astro` front door: `pramenCms({ backend: { url, tenant?, token? }, collections?, locale? })`
  is an Astro INTEGRATION (issue #35) — it builds the client once and exposes it, `resolve()`
  and the generated collections through a `pramen:cms` virtual module (types injected). The
  site re-exports once: `export { collections } from "pramen:cms"` — Astro has NO API for an
  integration to define content collections (checked against Astro 7), so that one line is
  the honest version of "auto-registered". `collections: "auto"` (default) reads the un-gated
  `listPublicContentTypes` at `astro:config:setup` (build time has no editor session; slug +
  name only, never the regions/field schema) and FAILS the build if the CMS is unreachable —
  generating zero collections would deploy an empty site green. `createCmsClient`/`cmsLoader`
  stay exported for hand-wired collections.
- Native queues: `ctx.queue.send(binding, body, { delaySeconds?, contentType? })` /
  `sendBatch(binding, msgs, opts?)` (`runtime/queue.ts`) — a facade + adapter seam (like
  `ctx.mail`) over **Cloudflare Queues**, distinct from `ctx.tasks` (NOT transactional with
  the write, but higher-throughput with platform batching/retry/DLQ and a cross-Worker
  consumer). Producer addressed by BINDING name; `createQueue` discovers any env binding
  with both `send`+`sendBatch`; an undeclared queue FAILS CLOSED (throws). Declare a
  `new Queue({ name, binding: "both", consumer })` in `oblaka.ts`. Consume via `app.queues`
  (keyed by queue NAME — env-prefixed remotely, matched leniently by `routeQueue`:
  exact→suffix→single-handler), dispatched by `createPramen().queue` (the CF
  `queue(batch,env)` entry; wire it next to `fetch`/`scheduled`). A consumer is
  Worker-level (no `ctx.db`): its ctx is `{ env, kv, mail, queue, callPrivileged }` — reach a
  tenant DO via `callPrivileged` (the message carries the tenant). Per-message ack on
  resolve / retry on throw; an unrouted batch is retried whole, never silently acked
  (`runtime/queue-consumer.ts`).
- Email: `ctx.mail.send({ to, subject, text/html, from?, replyTo? })` (`runtime/mail.ts`)
  — a facade + adapter seam (like `ctx.files`). Transport from env, in this order:
  `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` + `MAIL_FROM` → **Mailgun** (`MAILGUN_API_BASE`
  for the EU region); `EMAIL` binding + `MAIL_FROM` → Cloudflare Email Sending (no API
  keys); `MAIL_CAPTURE=true` → capture to KV (`mail:<to>`, dev inbox); else `send` FAILS
  CLOSED (throws) so a misconfigured prod doesn't silently stash security emails. Built
  in dispatch + the task-drain contexts. Cloudflare only sends FROM a zone in the same
  account; Mailgun needs the domain verified once and is not tied to the account.
- `ctx.env` is the Worker/DO environment (bindings + vars + secrets), loosely typed —
  use it to call external services from handlers (`ctx.env.STRIPE_SECRET_KEY as string`).
- No raw SQL in handlers — go through `ctx.db` (`find` is compiled by
  `runtime/read-engine.ts`). `ctx.db.exec` is an escape hatch.
- Reads are **column-projected**, never `SELECT *`: the compiled SELECT names the caller's
  readable columns (base ∪ conditional-`when` fields, or all-non-hidden when unrestricted)
  plus the PK / order / relation-join / `when`-input columns the engine needs — so
  `hidden()` and unreadable-for-this-caller columns never cross RPC (they were fetched by
  `SELECT *` then dropped in JS before). `find`/`page` also take an optional **`select:
  [...]`** projection to fetch only named columns (each must be readable — a hidden/
  unreadable one is a 403); the wide column a handler doesn't need then stays off the wire.
  This is the D1-over-RPC fix from GitHub #22. `Db.projectionColumns` in `runtime/db.ts`.
- `insert`/`update` echo the persisted row projected to the caller's readable fields
  ∪ the columns they wrote ∪ the PK — never leaks an unreadable field, never `{}`
  (a write-only caller still gets the generated id). `projectWrite` in `runtime/db.ts`.
- SQLite (DO) has no boolean type — booleans are stored as INTEGER 0/1; binding
  coercion lives in `runtime/db.ts` and `read-engine.ts`.
- CORS for browser clients is opt-in via the `CORS_ORIGINS` var (comma-separated
  origins or `*`); unset means same-origin only.

## DO SQLite

pramen runs on **Cloudflare DO SQLite** — its own engine, not stock sqlite3, so
don't assume sqlite3 C internals. Stick to the `SqlStorage` API
(`ctx.storage.sql.exec(sql, ...params)` → cursor `.toArray()`).
