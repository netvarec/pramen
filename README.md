# pramen

Reactive backend runtime for TypeScript — **on Cloudflare**. Define a schema and
handlers; get a complete backend deployed as a Worker + Durable Object, where the
platform provides the single-writer/storage/replication stack. See
[DESIGN.md](./DESIGN.md).

## Quick start

```bash
bun install
bun run dev            # lopata dev (Bun runtime; fast reload + /__dashboard) on http://localhost:8787
# bun run dev:wrangler # wrangler dev (miniflare) — workerd-parity check before deploy

# Requests need a signed bearer JWT (deny-by-default; see Auth/ACL below). The
# token must be authorized for the tenant (here the default "main") via a
# `tenants` claim — admins may access any tenant.
TOKEN=$(bun -e 'import {token} from "./scripts/jwt"; console.log(await token("alice",["author"],{tenants:["main"]}))')

# create a note
curl -s -X POST http://localhost:8787/rpc/createNote \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"title":"hello","body":"from pramen"}'

# list notes
curl -s -X POST http://localhost:8787/rpc/listNotes -H "authorization: Bearer $TOKEN"
```

### Auth

The Worker verifies a **bearer JWT** (WebCrypto), checks `exp`/`nbf`, and maps
claims to an Identity (`sub`→userId, `roles`/`role`→roles, custom claims pass
through). A forged or unsigned request gets no identity. Verification is pluggable
(`VerifyStrategy` in `packages/server/src/auth.ts`):

- **HS256** (`HmacStrategy`) — shared secret in `AUTH_SECRET` (dev value in
  `wrangler.jsonc`; production via `wrangler secret put AUTH_SECRET`). The default.
- **RS256 via JWKS** (`JwksStrategy`) — set `JWKS_URL` to your identity provider's
  JWKS endpoint and tokens are verified asymmetrically against the fetched public
  keys (cached, with `kid` selection and rotation handling). When `JWKS_URL` is
  set it takes over from `AUTH_SECRET`.

The core only *verifies* (bring your own IdP — Clerk/Auth0/WorkOS/Cloudflare Access
all work via JWKS). To *issue* logins without a third party, add the optional
**`@pramen/auth`**: spread `authSchema` into your schema and `authHandlers` into your
handlers to get `signup`/`login`/`me` — PBKDF2-hashed passwords, returning HS256
tokens the verifier above accepts (needs `AUTH_SECRET`):

```ts
import { authSchema, authHandlers } from "@pramen/auth";
const schema = defineSchema({ ...authSchema, notes: Entity(/* … */) });
const handlers = { ...authHandlers, /* your handlers */ };
// client: const { token } = await pramen.call("login", { username, password });
```

`@pramen/auth` also provides **passwordless magic-link login** —
`createMagicLinkAuth({ sendEmail })` + `magicLinkSchema`, with a pluggable `sendEmail`
(wire **Cloudflare Email Sending** via the `send_email` binding, no API keys) — and
**user management** — `createUserHandlers()` + `authPolicies()` for ACL-gated admin
(`listUsers`/`setUserRoles`/`setUserActive`/`deleteUser`) and self-service
(`changeEmail`/`changePassword`), over `auth_users` or your own authSchema-shaped
table (e.g. with an extra `tenants` column). See the
[Auth & Tenancy docs](docs/src/content/docs/auth-and-tenancy.md).

### ACL

Access is **deny-by-default**; roles grant it. Define roles/policies on the app
(`example/app.ts`); identity comes from the verified token (`packages/server/src/auth.ts`). Grants
OR-merge across an identity's roles; row-level `where` scopes are AND-merged into
queries, and `fields` restrict read projection / writable columns.

```ts
role("author", [
  policy("author:read",   "notes", "read",   { where: { ownerId: $identity("userId") } }),
  policy("author:create", "notes", "create", allow()),
  policy("author:update", "notes", "update", { where: { ownerId: $identity("userId") } }),
]);
```

ACL `where` rules accept the same operators and `AND`/`OR` as queries, with
`$identity` markers usable anywhere (including inside `in`):

```ts
// reads notes owned by anyone on the caller's team; no `team` claim -> sees none
policy("manager:read", "notes", "read", { where: { ownerId: { in: $identity("team") } } });
```

**Relation traversal in `where`.** A `where` key naming a relation takes a nested
clause over the related entity — in queries *and* ACL rules — compiled to a subquery
(`belongsTo` → `fk IN (SELECT pk FROM target …)`, `hasMany` → `pk IN (SELECT fk …)`).
The related entity's read scope is AND-merged, so traversal can't reveal rows you
couldn't read directly.

```ts
// query: notes whose owner is named "Alice"
ctx.db.find({ from: "notes", where: { owner: { name: "Alice" } } });
// ACL: read notes you own, expressed by traversing the relation
policy("owner:read", "notes", "read", { where: { owner: { id: $identity("userId") } } });
```

**Cell-level (per-row) field ACL.** Beyond the flat `fields` list, a policy can
grant fields *conditionally per row* — visibility that depends on the row's data,
not just the (entity, action). Use the declarative `conditionalFields` (a row
predicate, statically analyzable) or the `fieldsFn` escape hatch for arbitrary
logic. Conditional grants are **additive** — they only ever add fields to the base.

```ts
// teammate reads every note, but sees `body` only on the notes they own
policy("teammate:read", "notes", "read", {
  fields: ["id", "title", "ownerId", "createdAt"],
  conditionalFields: [{ fields: ["body"], when: { ownerId: $identity("userId") } }],
  // or, equivalently, the function form:
  // fieldsFn: (identity, row) => (row.ownerId === identity?.userId ? ["body"] : []),
});
```

The same rules enforce writes per row (insert checks the candidate values, update
the post-merge row), so a teammate can edit `body` on their own note but not on
another's. A conditionally-visible column can't be aggregated or used in `orderBy`
(that would leak its value across rows).

The example roles (`example/app.ts`): `admin` (full access), `author` (own notes
only — mint a token with `sub` = the owner), `reader` (reads all, no `body`),
`member` (read unlocked dynamically once you've authored a note). Live
subscriptions inherit the connecting identity, so pushes respect row-level scope.

**Relations & nested ACL.** Entities declare `belongsTo`/`hasMany`; eager-load via
`find({ with: { owner: true } })`. Each traversal is independently ACL-checked: a
relation loads under the related entity's own read scope, or via a parent policy's
`relations: { owner: { directAccess: true, fields: [...] } }` grant (traversal-only
access to an otherwise unreadable entity, optionally field-restricted). So an
author can see `note.owner` (id + name) without being able to list users or see
their email. Covered by `bun test`.

**Write-side ACL.** A write policy may `set` server-controlled columns (forced,
overriding client input — e.g. `set: { ownerId: (i) => i?.userId }` so a note's
owner can't be forged) and `validate` the final values (throw to reject):

```ts
policy("author:create", "notes", "create", {
  set: { ownerId: (i) => i?.userId },
  validate: ({ values }) => { if (!values.title) throw new Error("title required"); },
});
```

**Authorizing handlers.** Policies gate `ctx.db`; a handler that reaches `ctx.kv` /
`ctx.env` / `ctx.mail` directly bypasses them. Gate the *call* with `auth` (enforced
before the handler runs, `403` on failure):

```ts
adminStats: query((ctx) => ctx.kv.get("stats", "json"), { auth: ["admin"] });
whoami: query((ctx) => ctx.identity, { auth: "authenticated" });
```

`auth` is `"authenticated"`, a role list, or a `(identity) => boolean` predicate.

```bash
bun test    # boots wrangler dev once and runs all e2e suites
```

### Live queries (WebSocket)

Connect to `ws://localhost:8787/live` and subscribe to a query. The server pushes
fresh results whenever a mutation writes a table the query reads — over HTTP *or*
over the socket. Single-writer DOs see every write, so invalidation is exact.

```jsonc
// client -> server
{ "type": "subscribe",   "id": "s1", "name": "listNotes" }
{ "type": "call",        "id": "c1", "name": "createNote", "input": { "title": "hi", "body": "x" } }
{ "type": "unsubscribe", "id": "s1" }
// server -> client
{ "type": "data",   "id": "s1", "result": [ /* ... */ ] }  // initial + every update
{ "type": "result", "id": "c1", "result": { /* ... */ } }  // reply to a call
{ "type": "error",  "id": "s1", "error": "..." }
```

### D1 store (Worker + D1, no DO)

The same schema / ACL / read engine runs over a **D1 database** instead of a Durable
Object — selected per-request with the header `x-pramen-store: d1`, or made the app
default with `PRAMEN_STORE=d1` (the header still overrides per-request; `x-pramen-store:
do` forces the DO). Set the default and you don't sprinkle the header on every client:

```jsonc
// wrangler.jsonc / oblaka vars
"vars": { "PRAMEN_STORE": "d1" }   // requires the DB binding bound
```

> **The header is the reliable way to pin the store.** `PRAMEN_STORE` is convenient, but
> some adapters' `cloudflare:workers` env proxies (e.g. Astro's) don't surface a `vars`
> default in-process, so the Worker may not see it. `x-pramen-store: d1` per request is
> always honored. If a request routes to the DO with no DO bound, you now get a clear
> `400` ("no Durable Object (PRAMEN) is bound — pin the D1 store…") instead of a crash.

**Read replicas + read-your-writes (D1 Sessions API).** Each request opens one D1
**session** (`db.withSession(...)`) and runs all SQL through it. The Worker picks where
the session's first read may start by handler **kind**: a **mutation** anchors
`first-primary` (its reads see current data; writes go to the primary regardless), a
**query** anchors `first-unconstrained` (the nearest replica). The response carries the
session's bookmark as `x-pramen-d1-bookmark`; **`@pramen/client` captures it and replays
it** on the next request, so a client transparently **reads its own writes** even off a
lagging replica (a supplied bookmark wins over the kind default). Bare `fetch` users can
thread the header themselves.

**Cron drain (required for D1 + deferred tasks).** The DO store self-drains via an
alarm; the D1 store has no alarm, so its task outbox is drained by a **Cron Trigger**
(`createPramen().scheduled`) — wire `triggers.crons` in `oblaka.ts` (the example does, at
`* * * * *`) — or manually via `POST /admin/tasks/drain` with `x-pramen-store: d1`.

**Limits (intentional).** Live queries are **DO-only** (they need a single writer + a
socket host) — `/live` errors on the D1 path. And **D1 has no interactive/atomic
transactions**: pramen mutations interleave reads + writes + RETURNING + trigger-into-
outbox inside one `transaction()`, which D1 can't do atomically (no interactive txns;
`batch()` can't read mid-batch). So on the D1 path each statement auto-commits on its own
— a single-statement mutation is atomic, but a **multi-statement mutation does NOT roll
back on throw** the way it does on a DO. Use the **DO store** when you need atomic
mutations or live queries.

## Layout

The runtime is the **`@pramen/server`** package; a project is just `app.ts`,
`oblaka.ts`, and a 3-line `worker.ts` (`createPramen(app)`).

```
oblaka.ts             IaC source of truth -> generates wrangler.jsonc (main -> example/worker.ts)
packages/server/      @pramen/server — the runtime (publishable)
  src/
    index.ts          authoring entry: re-exports schema/handlers/ACL/files/errors/substrate
    worker-entry.ts   deploy entry ("@pramen/server/worker"): createPramen + the DO (cloudflare:workers)
    pramen.ts         createPramen(app) -> { fetch, PramenDO }
    worker.ts         makeWorker(app) — verifies JWT, routes to the DO, /files/*, admin
    durable-object.ts PramenDOBase + pramenDO(app) — in-process SQLite, schema boot, dispatch, live
    auth.ts           pluggable JWT verification — HS256 + RS256/JWKS (claims -> Identity)
    sdk/              portable SDK (no platform dep)
      schema.ts        Entity() + defineSchema() + relations (belongsTo/hasMany); fileRef type
      infer.ts         InferRow / WhereInput / InferInsert / InferUpdate / relations
      app.ts           createApp(schema) -> typed query() / mutation()
      handlers.ts      query() / mutation(); HandlerContext (ctx.db / ctx.kv / ctx.files)
      acl.ts           role/policy/allow/deny/$identity/resolve + set/validate
      files.ts         FileRef + Files (the ctx.files type surface)
    runtime/          substrate glue
      errors.ts        typed error envelope (status + code; no internal leakage)
      storage.ts       R2/Memory StorageAdapter, signed tokens, ctx.files, /files endpoint
      ddl.ts · migrate.ts · read-engine.ts · acl.ts · db.ts · dispatch.ts · driver.ts · kv.ts
example/
  app.ts              the demo schema + handlers + ACL
  worker.ts           the 3-line entry: createPramen(app) (oblaka's `main`)
packages/client · packages/react   typed @pramen/client + @pramen/react
test/
  e2e.test.ts         boots one wrangler-dev server, runs every suite (bun test)
  suites/             acl · resolver · relation · live · files · d1 (reusable suite fns)
  lib.ts              assert + HTTP/WS helpers + JWT minting
```

## Building & publishing

The three packages build to `dist` (JS + `.d.ts`) with `tsc` — `bun run build`.
They use **conditional `exports`**: the `development`/`bun`/`workerd` conditions
resolve to `src`, so in-repo typecheck, tests, dev, and deploy run straight off
source with no build step (tsconfigs set `customConditions: ["development"]`).
Published consumers fall through to `default`→`dist` (and `types`→`dist`), so Node
tooling gets compiled output and correct types. (`src` is also shipped, so a
consumer bundling with wrangler — the `workerd` condition — gets the source, which
esbuild bundles directly; every real pramen consumer bundles for Workers anyway.)
No `publishConfig` field overrides (npm is deprecating those).

**Releasing.** The three packages are versioned in lockstep. Bump + tag in one step,
then push — the `release` workflow (`.github/workflows/release.yml`) runs typecheck +
tests and publishes on the tag (needs an `NPM_TOKEN` repo secret):

```bash
bun run bump patch        # 0.0.1 -> 0.0.2 across all three, commits + tags v0.0.2
                          # (also: minor | major | an explicit X.Y.Z; --dry-run to preview)
git push --follow-tags    # CI publishes @pramen/* to npm
```

## Production config

- Set real secrets: `wrangler secret put AUTH_SECRET` (and `FILES_SECRET` if using
  files — it must be ≥16 chars, else file storage fails closed). Auth itself fails
  closed too: an empty `AUTH_SECRET` rejects every token.
- Destructive migrations are **off by default**. A drop/rename/type-change is skipped
  (and logged) unless `PRAMEN_ALLOW_DESTRUCTIVE=true` — so a schema edit can't silently
  drop a column on deploy. Additive changes always apply.
- CORS is opt-in via `CORS_ORIGINS`; unset = same-origin only.
- **Multi-project accounts:** oblaka keeps IaC state in one KV blob keyed by
  `(state-namespace, env)`, and `state-namespace` defaults to a shared `cf-state`.
  So every project that uses the default sees the *others'* resources as "dangling"
  (and a stray `oblaka --destroy` would delete them). pramen's `deploy`/`plan` pass
  `--state-namespace pramen-iac-state` to isolate it. Pick a **unique namespace per
  project from the first deploy** — oblaka has no "adopt existing resource by name,"
  so switching namespaces after resources exist conflicts on create. Never run
  `oblaka --destroy` against a shared state namespace.

## Tests

`bun test` generates the config from `oblaka.ts`, boots a single `wrangler dev`
against fresh local state, and runs all suites (each on its own tenant) — ACL +
write rules + per-identity live queries, dynamic resolvers, relations/nested ACL,
and live-query row-level invalidation. CI runs typecheck + `bun test` on every
push/PR (`.github/workflows/ci.yml`); no Cloudflare credentials needed (miniflare).

### Typed handlers

`createApp(schema)` returns `query`/`mutation` whose `ctx.db` is fully inferred
from the schema — table names, `where` columns and value types, row results, and
insert/patch shapes are all checked at compile time.

```ts
const { query, mutation } = createApp(schema);

const listNotes = query((ctx) =>
  ctx.db.find({ from: "notes", orderBy: { column: "createdAt", dir: "desc" } }),
);                              // rows typed: { id: number; title: string | null; ... }

// ctx.db.find({ from: "nope" })            -> type error: unknown table
// ctx.db.find({ where: { title: 123 } })   -> type error: title is string
```

The handler context is `{ db, kv, files, env, identity }`. **Field builders:**
`id`, `textId`, `text`, `int`, `real`, `bool`, `json` (arbitrary JSON, typed as
`JsonValue`), `fileRef` (an R2 file), `uuid` (a TEXT column typed as `string`).
`json`/`fileRef` are stored as TEXT and codec'd to/from the parsed value
automatically; a `uuid` value is validated on write (rejected with 400 if
malformed). **Modifiers** wrap a builder and compose: `notNull()`, `unique()`,
`indexed()`, `defaultTo(v)`, `primaryKey()`, `generated()`, `hidden()` — e.g.
`code: unique(t.text())`, `status: defaultTo(t.text(), "pending")` (a defaulted
column is optional on insert). `hidden()` marks a column never-readable through the
ORM — stripped from every read projection (find/get, mutation echoes, relation loads,
SYSTEM-mode `/admin/data`) even under `allow()`/SYSTEM, while staying writable and
visible to raw `ctx.db.exec` (for secrets like a password hash). `defaultTo` also accepts a **SQL-expression default**
via `expr`: `createdAt: defaultTo(t.text(), expr.now())` emits
`DEFAULT (datetime('now'))` (current UTC timestamp as TEXT, like `CURRENT_TIMESTAMP`),
filled by the DB; `expr.raw(sql)` is the escape hatch for any other SQLite default.

**UUIDs.** `t.uuid()` is a string column; `generated()` auto-mints a v4 on insert
(via `crypto.randomUUID()`) when you omit it, and `primaryKey()` marks any column
the primary key. The canonical UUID primary key is:

```ts
events: Entity((t) => ({
  id: primaryKey(generated(t.uuid())),  // auto-minted on insert, optional in the type
  kind: t.text(),
}));

await ctx.db.insert("events", { kind: "signup" });
// -> { id: "9f1c2e3a-…", kind: "signup" }   (id minted server-side)
```

**Partitions.** An entity can opt into a separate Durable Object via a `partition`:
`Entity((t) => ({ ... }), undefined, { partition: "audit" })`. The default is one DO
per tenant (`"default"`); a partition gives a slice of the schema its own
single-writer DO and storage. Migrations, admin, and the CLI are **per-partition**, and
relations / `with` eager-loads / transactions **may not cross a partition** (a DO can't
reach into another's SQLite — rejected at boot). The default partition keeps the bare
`idFromName(tenant)` DO key, so adding partitions to an existing app doesn't move its
default data.

**Public flows.** An unauthenticated caller is evaluated as the `anonymous` role —
define it to grant public reads/writes (absent ⇒ deny). A policy `where` can use
`$input("field")` (alongside `$identity`) for a capability read — authorize a row by
a request-supplied unguessable key, with no enumeration. Signature-authed endpoints
(e.g. Stripe webhooks) go in `app.routes`, matched before auth:

```ts
export const app = {
  schema, handlers, acl,
  routes: [
    { method: "POST", path: "/stripe/webhook", handler: async (req, env, ctx) => {
        // verify the signature on the raw body, then:
        return ctx.callPrivileged({ name: "markPaid", input: { id } }); // privileged → DO
    } },
  ],
};
```

**`ctx.env`** is the Worker/DO environment (bindings + vars + secrets) — call
external services straight from a handler:

```ts
const createCheckout = mutation(async (ctx, input: { amount: number }) => {
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.env.STRIPE_SECRET_KEY as string}` },
    body: /* ... */ "",
  });
  return res.json();
});
```

For a browser client on a different origin, set `CORS_ORIGINS` (comma-separated
origins, or `*`) and the Worker adds CORS to `/rpc` + `/live` (preflight included);
unset means same-origin only.

### Errors & input validation

Responses are `{ ok: false, error, code }` with a real status: ACL denial → `403
forbidden`, bad input / unknown handler / failed `validate` → `400 bad_request`.
Anything unexpected is logged server-side and returned as a generic `500` — stack
traces and internal messages never reach the client. A handler may declare an
`input` validator that parses the raw body and throws to reject:

```ts
createNote: mutation(run, {
  input: (raw) => {
    const o = raw as any;
    if (typeof o?.title !== "string") throw new Error("title must be a string");
    return { title: o.title, body: String(o.body ?? "") };
  },
});
```

### Queries

`where` supports equality shorthand, per-column operators, and nestable
`AND`/`OR`; plus multi-column `orderBy` and `limit`/`offset` pagination. All
values are parameterized; column names are validated against injection.

```ts
ctx.db.find({
  from: "notes",
  where: {
    ownerId: "alice",                       // eq shorthand
    createdAt: { gte: cutoff },             // gt / gte / lt / lte / ne
    title: { like: "report-%" },            // like (string columns only)
    id: { in: [1, 2, 3] },                  // in / notIn
    OR: [{ pinned: true }, { archivedAt: { isNull: true } }],
  },
  orderBy: [{ column: "createdAt", dir: "desc" }, { column: "id" }],
  limit: 20,
  offset: 40,
});
```

For large or changing datasets, prefer **cursor (keyset) pagination** — stable
under concurrent inserts/deletes. `db.page()` returns `{ items, cursor, hasMore }`;
pass the previous `cursor` back as `after`. The primary key is auto-appended to
`orderBy` as a tiebreaker, so the cursor is unambiguous.

```ts
let after: string | undefined;
do {
  const { items, cursor, hasMore } = ctx.db.page({
    from: "notes",
    orderBy: { column: "createdAt", dir: "desc" },
    limit: 50,
    after,
  });
  // ... process items ...
  after = cursor ?? undefined;
  if (!hasMore) break;
} while (after);
```

### Count & aggregates

`db.count()` and `db.aggregate()` (count/sum/avg/min/max, optional `groupBy`) are
ACL-scoped — the read `where` is applied, and aggregating a column you can't read
is denied (counting rows you *can* see is always allowed).

```ts
const open = ctx.db.count({ from: "tickets", where: { status: "open" } });

const perOwner = ctx.db.aggregate({
  from: "notes",
  groupBy: "ownerId",
  aggregations: { count: { fn: "count" }, lastId: { fn: "max", column: "id" } },
});  // typed: { ownerId: string | null; count: number; lastId: number | null }[]
```

### Tenants

Each tenant is a Durable Object addressed by `X-Pramen-Tenant` (default `main`).
Durable Objects can't be enumerated, so on a tenant's first touch its name is
recorded in the `TENANTS` KV registry (once, from the DO itself). Admins can list
them:

```bash
curl -s http://localhost:8787/tenants -H "authorization: Bearer $ADMIN_TOKEN"
# { "ok": true, "result": ["main", "acme", ...] }
```

The Worker **authorizes the tenant** against the caller before reaching the DO
(`authorizeTenant` in `packages/server/src/auth.ts`): admins may access any tenant; everyone else
only tenants listed in their `tenants` claim. Customize for your tenancy model.

**Recovery.** SQLite-backed DOs have 30-day point-in-time recovery. An admin can
restore a tenant to a past moment; the response includes an `undo` bookmark so the
operation is reversible:

```bash
curl -s -X POST http://localhost:8787/admin/recover -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"tenant":"acme","timestamp":1718000000000}'
```

> PITR is platform-only — unavailable in local dev (`wrangler dev` returns 501).
> pramen arms the restore and returns the `undo` bookmark; it completes on the DO's
> next restart (we don't auto-`abort()`, so the call can return the bookmark).

### KV (ctx.kv)

Handlers get `ctx.kv` — the project's KV namespace for **global, cross-tenant**
config / feature flags / caches (per-tenant data belongs in `ctx.db`). It's keyed
under an `app:` prefix so it never collides with pramen-internal keys, and it is
**not** part of a mutation's transaction.

```ts
getFlag: query((ctx, input: { key: string }) => ctx.kv.get(`flag:${input.key}`, "json")),
setFlag: mutation((ctx, input: { key: string; value: string }) =>
  ctx.kv.put(`flag:${input.key}`, input.value),
);
```

**Multiple projects in one account:** Cloudflare resource names are account-global,
so each project sets a unique `PROJECT` in `oblaka.ts` — it names the Worker, the
DO, and the KV namespace, so projects never collide. Within a project, one KV
namespace holds both the registry (`tenant:`) and app (`app:`) keys.

### Deferred tasks (ctx.tasks)

To run a side effect after a write — a **notification email**, a webhook — enqueue a
task instead of calling out inline (which would block the single-writer transaction
and couldn't be rolled back). `ctx.tasks.enqueue` writes to a transactional outbox **in
the same transaction** as your data, and `app.tasks` runs it after commit, off the
write path:

```ts
const handlers = {
  invite: mutation(async (ctx, input: { email: string }) => {
    const row = await ctx.db.insert("invites", { email: input.email });
    await ctx.tasks.enqueue({ kind: "invite-email", payload: { to: input.email } });
    return row; // a throw rolls back BOTH the row and the task
  }),
};
const app = {
  schema, handlers,
  tasks: {
    "invite-email": async (ctx, payload, meta) => {
      const { to } = payload as { to: string };
      await ctx.mail.send({ to, subject: "You're invited", text: "…" }); // ctx.mail — see below
    },
  },
};
```

At-least-once with retry/backoff + dead-letter; handlers get `meta.id` as an
idempotency key. The DO store **self-drains via an alarm**; the D1 store drains via a
Cron Trigger (`createPramen().scheduled`) or `POST /admin/tasks/drain`.

**Email** goes through `ctx.mail.send({ to, subject, text/html })` — a facade over an
adapter seam. With the `EMAIL` binding + `MAIL_FROM` it's **Cloudflare Email Sending**
(no API keys); `MAIL_CAPTURE=true` captures to a dev inbox; otherwise it **fails closed**
(a send throws) so a misconfigured prod never silently stashes a security email.

Or declare it once on the entity — a **trigger** auto-enqueues a task on a matching
write (still in the write's transaction), no `ctx.tasks.enqueue` in the handler:

```ts
notes: Entity(fields, relations, {
  triggers: [trigger({ task: "note-changed", on: { create: true, update: ["title"] } })],
});
```

A field-filtered update fires only on an actual value change; `hidden()` columns are
stripped from the payload. See the [Deferred Tasks docs](docs/src/content/docs/tasks.md).

**Native queues (`ctx.queue`).** For decoupled, high-throughput fan-out (rather than an
in-transaction outbox) there's `ctx.queue` — a facade over **Cloudflare Queues**:

```ts
await ctx.queue.send("JOBS", { tenant, id });          // produce (by binding name)
const app = { /* … */, queues: {                        // consume (by queue name)
  "pramen-jobs": async (ctx, message) => {
    const { tenant, id } = message.body as { tenant: string; id: string };
    await ctx.callPrivileged({ name: "markDone", input: { id }, tenant }); // no ctx.db in a consumer
  },
}};
export default { fetch: pramen.fetch, scheduled: pramen.scheduled, queue: pramen.queue };
```

Declare `new Queue({ name, binding: "both", consumer })` in `oblaka.ts`. A handler resolves
→ ACK, throws → RETRY (platform retry/DLQ). Unlike `ctx.tasks`, a send is **not**
transactional with the write; sending to an undeclared queue **fails closed**.

### Client (frontend)

`@pramen/client` is a typed client — `call()` is RPC over HTTP, `subscribe()` is a
live query over a reconnecting WebSocket. It's generic over your server's handler
map, so calls are fully typed with no runtime dependency on the server (import the
type only):

```ts
import { createClient } from "@pramen/client";
import type { app } from "../server/app"; // type-only, erased at build

const pramen = createClient<typeof app.handlers>({ url, token, tenant: "acme" });

const note = await pramen.call("createNote", { title: "hi", body: "..." }); // typed
const stop = pramen.subscribe("listNotes", undefined, { onData: (notes) => render(notes) });
```

> **Fronting pramen with a meta-framework?** RPC handlers are matched at the exact path
> `POST /rpc/<handler>`. A framework that enforces trailing slashes (e.g. Astro's
> `trailingSlash: 'always'`) will **308-redirect** `/rpc/x` → `/rpc/x/` — and browsers
> **drop the POST body on the redirect**, so the call silently arrives empty. Set
> `trailingSlash: 'ignore'` (or `'never'`) for the API routes, or call the canonical
> path your adapter expects.

`@pramen/react` adds hooks that re-render on every server push:

```tsx
const { data, loading } = useLiveQuery(pramen, "listNotes");
const createNote = useMutation(pramen, "createNote");
```

### CLI

```bash
bun run pramen help
bun run pramen init my-app                 # scaffold app.ts + oblaka.ts
bun run pramen token alice author --tenant acme   # mint a dev JWT
bun run pramen schema sql                  # CREATE TABLE for the schema
bun run pramen schema snapshot             # baseline in .pramen/schema.json
bun run pramen schema diff                 # additive vs destructive changes
bun run pramen schema status --tenant acme # is a deployed tenant caught up?
```

`schema status` reports each partition of the app independently (a single-partition
app reads as one block), fetching every partition's applied schema from its DO.

`schema diff` flags each change as additive (no data loss) or **destructive**
(drop / type change — rebuilds the table, may lose data). All are auto-applied on
the next DO boot; declare a `renamedFrom` hint to migrate a renamed column's data
instead of dropping it.

### Migrations

The schema is reconciled with the store on every DO boot, inside a storage
transaction. Two passes:

- **Additive** (no data loss): new tables are created and new columns added
  (`ALTER TABLE ADD COLUMN`, nullable).
- **Destructive** (auto-applied): a column the schema no longer declares is
  dropped, a type change is applied, and a table absent from the schema is dropped
  — all via the standard SQLite table-rebuild (create new, copy, drop, rename),
  preserving rows and ids. This **can lose data** on a bad deploy, by design.

A schema hash in `_pramen_meta` skips the work when nothing changed. A **rename**
can't be inferred from a diff (a removed + added column is ambiguous), so declare
it with `renamedFrom` — the migrator then copies the old column's data:

```ts
notes: Entity((t) => ({ id: t.id(), title: t.text(), content: renamedFrom(t.text(), "body") })),
```

Without the hint, a rename is applied as drop + add (the old column's data is lost).

## Deploy

Cloudflare topology is declared in **`oblaka.ts`** (the source of truth) — the
Worker, the `PRAMEN` Durable Object, its SQLite migration, vars, and observability.
`oblaka` generates `wrangler.jsonc` from it (git-ignored; never edit by hand).

```bash
bun run config         # oblaka oblaka.ts        -> generate wrangler.jsonc (local)
bun run dev            # regenerate + wrangler dev
bun run plan           # oblaka --remote --dry-run -> preview the remote changes

# Real deploy: provision resources via oblaka, then ship the code via wrangler.
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
wrangler secret put AUTH_SECRET   # production auth secret (overrides the dev var)
bun run deploy --env production    # oblaka --remote (provision + config) && wrangler deploy
```

`oblaka --remote` provisions the Worker + Durable Object (and the SQLite DO
migration) on Cloudflare and writes the config; `wrangler deploy` bundles and
uploads the Worker entry (`worker.ts`, your `createPramen(app)` call).
