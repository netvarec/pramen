# Changelog

All notable changes to the `@pramen/*` packages are recorded here. The eight packages —
`@pramen/server`, `@pramen/client`, `@pramen/react`, `@pramen/auth`, `@pramen/cms`,
`@pramen/cms-astro`, `@pramen/cms-editor`, `@pramen/admin` — publish in lockstep under one
shared version.

> **Gap in this file:** entries between 0.0.15 and 0.0.51 were not recorded. The `git log`
> is the record for that range; this file resumes at 0.0.52 rather than reconstructing it.

The format is based on [Keep a Changelog](https://keepachangelog.com/). This project is
**pre-1.0 and under active development**: 0.0.x releases may include breaking changes —
there are no backward-compatibility guarantees yet.

## [Unreleased]

Nothing yet.

## [0.0.52] — 2026-08-30

### Added

- **OIDC login (`@pramen/auth`).** `createOidcAuth({ issuer, clientId, clientSecret, redirectUri,
  successRedirect })` adds the authorization-code + PKCE flow as pre-auth routes: discovery via
  `/.well-known/openid-configuration`, `state` + `nonce` held in KV and consumed
  read-and-delete, and the ID token verified through the same `JwksStrategy` the Worker uses,
  plus a nonce match binding it to the request that started it.

  It mints a **pramen session**, not a passthrough of the provider's token — that is what
  keeps `refreshSession`, the KV revocation denylist and role-in-token ACL working, instead
  of putting role resolution on every request's hot path. The session arrives in the
  redirect's URL **fragment**, which is never sent to a server.

  Roles differ per provider and getting them wrong fails silently as "everyone has no
  roles": Entra puts them in a top-level `roles` claim, Auth0/Okta in a namespaced one,
  Google Workspace ships none. So `mapRoles(claims)` makes the IdP authoritative where there
  is something to read (removals included); otherwise roles live on the user's row.

  Accounts key on the **verified** email by default, so an OIDC login lands on the same row
  as a magic-link or password login. An unverified address is refused rather than trusted or
  silently keyed on `sub` — a provider allowing arbitrary addresses would otherwise be a
  takeover path into an existing account. `accountKey: "sub"` namespaces by issuer instead.

  The verify-only path is unchanged: a frontend that already holds an IdP token still needs
  only `JWKS_URL`.

- **`ctx.callPrivileged` works on the D1 store.** A pre-auth route has no `ctx.db` and
  reached handlers by forwarding to a Durable Object, so everything built on such a route —
  signed preview links, the sitemap — was DO-only, and `@pramen/cms` had to refuse to mint
  preview links on D1 rather than hand out one that could never be redeemed. On D1 the
  engine runs in the Worker, so it now dispatches locally, through one shared `dispatchD1`
  that the request path uses too (migration, bootstrap, the multi-tenant guard and the
  outbox drain cannot drift between them).

  This is what makes D1 a first-class CMS store — and D1 is the only store that can live
  inside an Astro site's Worker, because it is a binding while a DO must be exported from
  the worker entry.

- **`pramenCms()` — an Astro integration for `@pramen/cms-astro`** (closes #35). One entry in
  `integrations` configures the backend; a `pramen:cms` virtual module exports the client,
  a bound `resolve()` and the generated collections, with types injected. `collections:
  "auto"` reads the store's content types at config time via a new public
  `listPublicContentTypes` (slug + name only) and **fails the build** if the CMS is
  unreachable, because zero collections would deploy an empty site green.

  Astro has no API for an integration to define content collections, so a site re-exports
  once: `export { collections } from "pramen:cms"`.

- **CMS locales are declared, not inferred.** `createCmsHandlers({ locales: ["cs", "en"] })`
  and `listCmsCapabilities` — the pages-side counterpart to a collection's `supports: [...]`.
  One locale means monolingual: no i18n chrome, and `locale` comes off the wire entirely so
  nothing can overwrite a field the editor no longer shows. `locales[0]` is the default
  stamp, derived rather than a second option that can disagree. Deliberately not inferred
  from the data: `createTranslation` is reachable only from the panel that would be hidden,
  so "show i18n once a second locale exists" could never become true.

- **A host-configurable wordmark in `@pramen/cms-editor`.** The editor ships as a package an
  agency installs for a client, so `brand: { name, suffix }` in `/config.js` replaces
  "pramen · cms" in the topbar, on the Setup screen and in the browser tab. Configuring
  nothing renders exactly as before.

### Fixed

- **A failed mutation on D1 now says it was partially applied.** D1 has no interactive
  transactions, so `transaction(fn)` runs `fn` as-is and a mutation that throws midway keeps
  what it wrote. That is unavoidable — pramen mutations interleave reads, writes, `RETURNING`
  and trigger-into-outbox, and `batch()` cannot read mid-batch — but it used to be invisible:
  a half-applied mutation looked exactly like an ordinary 500. The Worker now logs the
  handler and how many statements had committed.

- **A missing Cron trigger on the D1 store is no longer silent.** The DO self-drains via an
  alarm; D1 has none, so a delayed task — a scheduled publish, a retry backoff — runs only
  under a Cron trigger, and forgetting it meant the row simply never went live. The Worker
  warns once per isolate when a request-tail drain leaves a future-due task and no Cron drain
  has been seen, and stops once one fires.

- **`@pramen/cms` collection workflow (`supports`), from a review of #42.** Scheduling now
  converges in any drain order: a publish task draining after its own takedown instant lands
  the row **down** instead of publishing and discarding the takedown, and the takedown task
  spends the pending publish token so a late retry cannot resurrect the row. A reschedule can
  no longer move the publish past a pending takedown. Schedule epochs are range-checked, so
  an epoch-microseconds slip is a 400 rather than a `RangeError` 500, and a year-10000 value
  can no longer mint a timestamp that sorts before every real one.

  Revision history stopped leaking: `collectionListRevisions` projects each snapshot to the
  caller's readable fields (it returned the raw JSON from a flatly-granted table), restore
  writes back only that set, and `cmsPolicies` no longer grants update/delete on the
  append-only revisions table. The generic CRUD handlers gained input validation — an
  operator object where an id belongs returned an arbitrary row — and `collectionList` clamps
  its limit.

  `createCollectionHandlers` now requires your schema and validates the whole registry at
  boot: managed columns are checked for type, nullability and `hidden()` rather than by name
  alone; declared fields must be real columns that can hold their type; `orderBy` must name a
  real column (SQLite resolves an unknown quoted name to a *constant*, so a typo sorted every
  row equal, silently); the entity must be in the default partition; and two collections may
  not share an entity, since the ACL OR-merges their policies and would widen the public
  scope.

  The public read scope treats `publishedAt IS NULL` as published, so rows seeded or imported
  without a stamp no longer vanish the moment `scheduling` is enabled, and it grants
  `publishedAt` so "newest published first" stops 403ing for anonymous.

- **The collection editor can publish.** With `drafts` enabled there was no UI path at all —
  `collectionCreate` seeds `status: "draft"` and `collectionUpdate` strips `status` — so a row
  authored in the editor could never be made public. Adds publish/unpublish, a schedule
  picker, a preview link and a restorable revision list, all driven by `supports`.

### Removed

- **`embed` for `@pramen/cms-astro` and the Worker's `basePath`,** both reverted before
  release. `embed` generated a Worker entrypoint against a `dist/_worker.js` layout only
  `@astrojs/cloudflare` v12 emits; v13/v14 hand the build to `@cloudflare/vite-plugin` and
  emit no such file, so the generated entry could not resolve its first import. `basePath`
  had no other consumer and four defects that only surface once something is mounted —
  `/files` and `/media` were dead under a prefix, minted URLs did not know about it, and
  `basePath: "/"` 404'd everything. Both will return built against the current adapter.

## [Shipped, version unrecorded — between 0.0.15 and 0.0.51]

These entries sat under "Unreleased" while the file went untended. The work SHIPPED; which
release carried it was never recorded, so they are kept verbatim rather than assigned a
version they might not belong to.

### Added

- **Session revocation, without a session store.** Tokens are stateless (roles baked in at
  login), so a token used to outlive any change to the account behind it. Two mechanisms
  close that gap. **`refreshSession()`** (`@pramen/auth`, authenticated — in both
  `authHandlers` and `createMagicLinkAuth`) re-reads `roles`/`active` and reissues a token:
  refreshing at ~half-TTL keeps `AUTH_SESSION_TTL_SECONDS` short (bounding how long a stale
  role lingers) and picks up a role **grant** immediately — e.g. after a subscription
  checkout — with no re-login. It 401s for a deleted or deactivated account, so a refresh
  can't launder a revoked session into a longer-lived one. For hard revocation, a **KV
  denylist**: `setUserActive(false)` / `deleteUser` write `authDenied:<username>`, which the
  Worker checks right after resolving identity — before both the DO and D1 paths — and fails
  **closed** with 401 (never a silent downgrade to anonymous), covering HTTP and the
  WebSocket upgrade. The entry self-expires at the session TTL, so the list never grows;
  reactivation lifts it (the key is username-scoped and would otherwise block a fresh login).
  `denySession` / `allowSession` / `isSessionDenied` are exported from `@pramen/server` for
  app-driven revocation.

### Fixed

- **The admin dashboard rendered blank against any real deployment.** `GET /tenants`
  returns `DoRef[]` (`{tenant, partition}` — one entry per registered Durable Object),
  but `@pramen/admin` typed the call `string[]` and passed each entry straight to
  `<SelectItem>`. React throws on an object child, so the whole dashboard failed to
  render for anyone whose deployment had even one tenant, which is all of them. Present
  since the tenant picker was added and shipped through 0.0.44.

  The client now normalizes: tenant names are extracted, deduped (a tenant spanning
  several partitions is one choice in a picker that selects tenants) and sorted, so KV
  listing order cannot reshuffle the list. A plain `string[]` is still accepted — the
  admin is a client you point at arbitrary deployments, which need not run the version
  that built the bundle.

  The server side is unchanged: its shape carries the partition, and flattening it there
  would have been a lossy breaking change to fix a consumer's parse. The new test pins
  the contract by annotating the fixture with the server's own exported `DoRef` type, so
  a change to that shape now fails `bun run typecheck` instead of silently blanking the
  admin again.

- **`@pramen/auth` was unusable on Cloudflare.** Password hashing used 600k PBKDF2
  iterations (OWASP guidance), but workerd caps PBKDF2 at **100k** and throws rather than
  clamping — `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
  supported`. Every `signup` and `login` returned a 500 on any real deployment. New hashes
  are now written at the platform maximum, which is also the strongest KDF Workers offers
  (WebCrypto there has no scrypt or argon2). Lowering the count is safe because the
  iteration count is encoded in the stored string and read back on verify.

  This escaped the entire test suite because Bun — which runs the tests, and which
  `lopata` runs workers on — has no such cap, so the bug was reachable only by deploying.
  The new regression test therefore asserts the **number recorded in the stored hash**
  rather than any behaviour, since behaviour under Bun cannot tell 100k from 600k.

  Verification also gained a diagnosis: the count comes FROM the stored hash, so a row
  written at 600k by an earlier release (or by a Bun/Node deployment sharing a database
  with a Worker) can never be verified on Workers. That now raises an error naming the
  count, the cap and the remedies, instead of a bare `NotSupportedError` — or, if a caller
  swallowed it, a silent "wrong password" that locks the account out with nothing logged.
- **A live WebSocket could outlive its token.** The token was verified once at upgrade and
  the identity fixed for the life of the socket, so a long-lived or hibernating connection
  kept calling and receiving pushes indefinitely past `exp` — role changes and revocation
  only ever bit on reconnect. The DO now re-checks `exp` on every message: an expired socket
  gets an `unauthorized` error frame and is closed with **4401**, and expired sockets are
  dropped from the broadcast path instead of pushed to. `Identity` carries `exp` (a standard
  claim, so it needed explicit plumbing past the custom-claim passthrough); synthetic
  `callPrivileged` identities carry none and are never treated as expired.

- **`@pramen/client` `call()` no longer silently resolves `undefined`.** A 2xx response
  that isn't the `{ ok: true, result }` envelope (e.g. a trailing-slash base url routed to
  the Worker help page) now throws a `PramenError` with the status instead of resolving
  `undefined`. The base url is also normalized (trailing slash stripped) so `${url}/rpc`
  can't become `//rpc`.
- **`@pramen/client` D1 read-your-writes bookmark keeps the maximum**, not
  last-response-wins — a slower earlier response can no longer clobber a newer bookmark and
  regress read-your-writes under concurrency.
- **`@pramen/client` surfaces live-connection failures.** A missing WebSocket
  implementation, or a socket that keeps closing past `maxReconnectAttempts` (default 8),
  now fires a new optional `onConnectionError` subscribe callback instead of hanging
  forever behind a permanent loading state. Reconnect backoff gained jitter and only resets
  after the connection has stayed open a few seconds (no accept-then-close hot-loop).

### Changed

- **`pramen schema diff` now reports modifier and partition changes**, not just column
  types — `notNull`/`unique`/`primaryKey`/`generated`/`default`/`hidden` changes and
  entity partition moves are surfaced, each labeled `[NOT applied on boot]` because the
  boot migrator only rebuilds on a type change (partition moves need a manual cross-DO data
  migration).
- **Migration docs corrected:** destructive migrations are gated behind
  `PRAMEN_ALLOW_DESTRUCTIVE` (off by default), not auto-applied. Fixed the misleading
  "auto-applied" wording in the CLI, `schema diff`, and the README/docs.

## [0.0.14] — 2026-06-25

### Added

- **`ctx.queue` — native Cloudflare Queues.** A producer + consumer seam (the same shape
  as `ctx.mail`): `ctx.queue.send(binding, body, opts?)` / `sendBatch(...)` over a
  `QueueAdapter` (Cloudflare / in-memory), plus a consumer dispatch — register handlers in
  `app.queues` (keyed by queue name) and wire `createPramen(app).queue` as the Cloudflare
  `queue(batch, env)` entry. Distinct from `ctx.tasks` (the transactional outbox): a queue
  send is **not** transactional with the write, but gets platform-native batching, retry,
  and dead-letter, and a consumer that can run in another Worker. Sending to an undeclared
  queue fails closed.
- **D1 read replicas via the Sessions API.** The D1 store opens one `db.withSession()` per
  request: mutations anchor `first-primary` (reads see current data, writes go to the
  primary), queries `first-unconstrained` (nearest replica). Responses carry an
  `x-pramen-d1-bookmark` header that `@pramen/client` captures and replays for transparent
  **read-your-writes**. `PRAMEN_STORE=d1` makes the D1 path the app-wide default (the
  `x-pramen-store` header still overrides per request).

### Fixed

- **Reserved-word identifiers.** The DDL generator and migrator emitted bare identifiers,
  so a column or table named after a SQL keyword (`order`, `group`, …) broke the migration
  outright — and would have broken every read/write once created. All identifiers are now
  double-quoted through a single `quoteIdent` authority (DDL, the table-rebuild, reads, and
  writes). Backward-compatible — existing stores don't re-migrate.
- **Live queries under `PRAMEN_STORE=d1`.** The D1 default routed `/live` onto the D1 path
  and returned a `400` instead of falling through to the Durable Object — silently
  disabling live subscriptions. Live queries now always use the DO.
- **Unbound Durable Object.** A request routed to the DO with no DO bound crashed the whole
  RPC surface (`Cannot read 'get' of undefined`). It now returns a clear `400`, and
  `partitionStubFor` throws an actionable message pointing at the `x-pramen-store: d1`
  header.

### Documentation

- The `x-pramen-store: d1` **header is the reliable way to pin the D1 store** — a
  `PRAMEN_STORE` env default can be dropped by some adapters' `cloudflare:workers` env
  proxies (e.g. Astro's).
- A trailing-slash-enforcing framework (Astro `trailingSlash: 'always'`) 308-redirects
  `/rpc/*` and browsers drop the POST body on the redirect — use `'ignore'` / `'never'`
  for the API routes.

## [0.0.13] — 2026-06-23

### Added

- **Per-handler authorization.** `query` / `mutation` accept an `auth` option
  (`"authenticated"` | role list | `(identity) => boolean`), enforced before the handler
  runs — to gate handlers that reach `ctx.kv` / `ctx.env` / `ctx.mail` / `ctx.queue`
  directly (those bypass the row-level ACL).

## [0.0.12] — 2026-06-23

### Added

- **`ctx.mail` facade.** Send email through an adapter seam — Cloudflare Email Sending (the
  `EMAIL` / `send_email` binding, no API keys), with a dev capture mode and an in-memory
  adapter for tests. Available in handlers and task-drain contexts.

### Fixed

- `ctx.mail` **fails closed** when unconfigured, so a misconfigured production never
  silently stashes a security email; the example's dev inbox handlers are admin-gated.

## [0.0.11] — 2026-06-23

### Added

- **Declarative `$triggers`.** An entity may declare
  `triggers: [trigger({ task, on: { create?, update?, delete? } })]`; a matching ORM write
  auto-enqueues the task in the write's transaction — no `ctx.tasks.enqueue` in the handler.

### Fixed

- Closed the trigger security + production gaps from the audit: `hidden()` columns stripped
  from payloads, a loop guard for task-handler writes, value-change semantics on
  field-filtered updates, and fail-fast validation of trigger → task wiring.

## [0.0.10] — 2026-06-23

### Added

- **Deferred tasks — transactional outbox.** `ctx.tasks.enqueue({ kind, payload, delayMs? })`
  writes to an outbox table **atomically with the mutation**; a drainer runs the matching
  `app.tasks` handler after commit, off the write path. At-least-once with retry/backoff,
  dead-letter, and a `meta.id` idempotency key. The DO self-drains via an alarm; the D1
  store drains via a Cron Trigger (`createPramen().scheduled`).

### Fixed

- Production-hardened the outbox: claim-based concurrent drains (disjoint batches),
  retention pruning, and stale-claim reclaim.

## [0.0.9] — 2026-06-23

### Added

- `createUserHandlers({ table })` + `authPolicies(...)` — user management (admin + self)
  over any `authSchema`-shaped table.

### Fixed

- **Security:** magic-link login keys on the immutable `username`, not the mutable `email`
  — prevents account takeover and a PK-collision migration regression.

## [0.0.8] — 2026-06-23

### Added

- `@pramen/auth` user management (admin + self) plus hardening.

### Fixed

- `update` / `delete` / relation loads resolve the real primary key (not a hardcoded `id`),
  fixing entities whose PK isn't `id` (e.g. `auth_users`, PK = `username`); `hidden()`
  columns are stripped from every read projection.

## [0.0.7] — 2026-06-23

### Added

- Passwordless **magic-link login** (`createMagicLinkAuth`) via Cloudflare Email Sending.

### Fixed

- Publish: rewrite `workspace:*` dependency ranges to concrete versions before
  `npm publish` — the previously published `@pramen/react` / `@pramen/auth` shipped an
  unrewritten `workspace:*` dep and were uninstallable.

## [0.0.6] — 2026-06-23

### Changed

- Release-workflow / CI maintenance (GitHub Action version bumps); no library changes.

## [0.0.5] — 2026-06-22

### Added

- **SQL-expression column defaults** — `defaultTo(t.text(), expr.now())` / `expr.raw(sql)`,
  emitted unquoted and parenthesized in the DDL.

## [0.0.4] — 2026-06-22

### Added

- **Durable Object partitions.** An entity may declare a `partition` (the DO class it lives
  in); partition-aware routing, per-partition migrate + admin endpoints, a self-maintained
  `(tenant, partition)` registry, and static rejection of cross-partition relations.
- **`uuid` field type** — `t.uuid()` with `generated()` + `primaryKey()`, validated on write.

## [0.0.3] — 2026-06-22

### Fixed

- Relation-aware `WhereClause` for relationless entities; annotated release tags in the
  bump script.

## [0.0.2] — 2026-06-22

First published release — the foundational runtime:

- Schema + handlers + ORM over a `Driver` / `Dialect` substrate seam (DO SQLite + D1).
- Deny-by-default **ACL**: roles, policies, row-level scopes, cell-level field permissions,
  and dynamic resolvers.
- **Live queries** over Hibernatable WebSockets with row-level (digest-diff) invalidation.
- Additive **schema migrations** on boot; query operators, OR/AND, cursor pagination,
  count + aggregates.
- **File storage** on R2 (`fileRef` column + `ctx.files` signed URLs).
- `ctx.kv`, `ctx.env`, CORS, public pre-auth routes + an anonymous role.
- Tenant registry + authorization + point-in-time recovery; the admin data API and the
  `@pramen/admin` dashboard; `@pramen/auth` (credential → JWT) and the `@pramen/client` /
  `@pramen/react` clients.

_(The project was briefly named `mrak` during pre-release development.)_

[0.0.14]: https://github.com/netvarec/pramen/compare/v0.0.13...v0.0.14
[0.0.13]: https://github.com/netvarec/pramen/compare/v0.0.12...v0.0.13
[0.0.12]: https://github.com/netvarec/pramen/compare/v0.0.11...v0.0.12
[0.0.11]: https://github.com/netvarec/pramen/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/netvarec/pramen/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/netvarec/pramen/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/netvarec/pramen/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/netvarec/pramen/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/netvarec/pramen/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/netvarec/pramen/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/netvarec/pramen/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/netvarec/pramen/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/netvarec/pramen/releases/tag/v0.0.2
