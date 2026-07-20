# Changelog

All notable changes to the `@pramen/*` packages are recorded here. The five packages —
`@pramen/server`, `@pramen/client`, `@pramen/react`, `@pramen/auth`, `@pramen/admin` —
publish in lockstep under one shared version.

The format is based on [Keep a Changelog](https://keepachangelog.com/). This project is
**pre-1.0 and under active development**: 0.0.x releases may include breaking changes —
there are no backward-compatibility guarantees yet.

## [Unreleased]

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
