# @pramen/cms

A **block / page builder** for pramen — Drupal-Paragraphs-style typed content blocks
arranged in named regions, reusable blocks, scheduled publishing — built **entirely from
pramen primitives**. It is an ordinary app fragment (schema + handlers + ACL + tasks), not
a new runtime. Inspired by [WollyCMS](https://github.com/wollycms/wollycms) / Drupal
Paragraphs / Storyblok.

> **Status: spike → production (in progress).** Proven end-to-end against a real Durable
> Object by `test/suites/cms.ts`. Done: **media library**, **i18n**, **editorial workflow +
> audit**, **SEO + sitemap**, **typed blocks**, and a **visual editor** (`@pramen/cms-editor`,
> a standalone React SPA). Remaining: integration + QA against a real project. See *Limitations*.
>
> **Draft vs. publish validation:** editor-facing writes (addBlock/updateBlock/createPage)
> validate field *types* but treat `required` as advisory — a DRAFT block may be incomplete
> and filled in later. (Enforcing required *at publish* is a small follow-up.)

## Typed blocks (hybrid)

Block types are data-driven (JSON schemas, no deploy to add one), but developers can get
compile-time field typing two ways:

- **Hand-authored, no build step:** `defineBlockType("hero", [...] as const)` +
  `BlockFieldsOf<typeof hero>` infers the `fields` shape (media → `ResolvedMedia`, repeater →
  array, group → nested), exactly like `typeof app.handlers` types the RPC client. Type a
  component with `TypedBlockComponent<typeof hero>` (from `@pramen/cms/react`). Proven by
  `example/cms-inference-check.ts`.
- **Codegen from DB-stored types:** `generateBlockTypes(blockTypes)` emits a `.ts` module of
  per-slug field interfaces + a `BlockFieldsBySlug` registry from `cms_block_types` rows —
  for webmaster-created types. (A `pramen cms codegen` CLI that fetches the rows over HTTP and
  writes the file is the remaining thin wrapper.)

## SEO & sitemap

- Per-page SEO on `cms_pages`: `metaTitle`, `metaDescription`, `canonicalUrl`, `robots`,
  `ogTitle`, `ogDescription`, `ogImage` (a media id, resolved to a URL), `structuredData`
  (JSON-LD). Set via `updatePageSeo({ pageId, … })`; exposed as `page.seo` on the content API.
- `listPublishedPages` (public) returns published `{ slug, locale, updatedAt }` for sitemaps.
- `cmsRoutes({ origin?, pageUrl? })` returns turnkey **`GET /sitemap.xml`** + **`/robots.txt`**
  routes — spread into `app.routes`. Helpers `sitemapXml(entries, opts)` / `robotsTxt(opts)`
  are exported if you want to build them yourself. hreflang alternates ride the content API's
  `page.translations`.

## Editorial workflow & audit

- **States:** `draft → review → published`, plus `rejected` and `archived`. Handlers:
  `submitForReview` (editor), `approve`/`reject` (reviewer-gated), `publishPage` (direct
  publish), `unpublishPage`, `schedulePage`. Each transition is guarded (e.g. you can only
  approve a page that is in review).
- **RBAC:** `submitForReview` is gated to `editorRoles`; `approve`/`reject`/`publishPage`/
  `schedulePage` to `reviewerRoles` (default `["reviewer","admin"]`) — so an editor **can't
  bypass review** by publishing directly. Configure via `createCmsHandlers({ editorRoles, reviewerRoles })`.
- **Audit trail:** every transition writes a `cms_audit` row (`action`, from/to status,
  `actor` = `identity.userId`, note) synchronously in the same transaction. `listPageAudit({ pageId })`
  returns it. Revisions also record the publishing `actor`.

## i18n / multi-locale

- A page has a `locale` and a `translationGroupId` (auto-minted; shared across a page's
  translations). Slugs are unique **per locale** (`/en/about` + `/cs/about` coexist).
- `createTranslation({ pageId, locale, title?, slug? })` makes a new page in another locale
  sharing the group; `listTranslations({ pageId })` lists all locales of a page;
  `listLocales()` returns the distinct locales.
- `getPage({ slug, locale? })` is locale-aware (`locale` defaults to the configured default).
  The content API's `page.translations` carries the published sibling locales (computed live,
  so a later-published translation shows up) for **hreflang** alternates.

## Media library

- **Upload:** `signMediaUpload({ contentType, filename? })` mints a signed PUT url (keyed under
  the tenant's `media/` prefix); the client PUTs the bytes, then `createMedia({ ref, alt? })`
  confirms the blob is in R2 and persists a `cms_media` row. `listMedia`/`getMedia`/`deleteMedia`
  (deleteMedia also removes the R2 blob) round it out. Editor-gated.
- **Reference from a block:** a `"media"` field stores a `cms_media` id. At assemble/publish time
  the id is resolved (recursively, through group/repeater nesting) to a `ResolvedMedia`
  `{ id, key, url, alt, contentType, filename }` in the snapshot — so the content API returns a
  servable URL, never a bare id.
- **Serving + transforms:** published media is served by the Worker's **public** `GET
  /media/<tenant>/media/<key>` route (immutable-cached, `nosniff`; restricted to `media/`-prefixed
  keys so it can't leak signed-private objects). Put **Cloudflare Image Resizing** in front for
  on-the-fly resize/format — build URLs with `imageUrl(key, { width, format, origin })`
  (`/cdn-cgi/image/…`). Image Resizing is a **zone setting** (enable it on the Cloudflare zone),
  not a binding.

## Model

| Concept | Table | Notes |
|---|---|---|
| Block **type** (schema) | `cms_block_types` | slug + a recursive `fieldsSchema` (JSON). Data-driven — add a type with no deploy. |
| Block **instance** | `cms_blocks` | content matching a type's field schema; optionally `isReusable`. |
| **Content type** | `cms_content_types` | declares a page's `regions` (each with an `allowedTypes` allow-list) + `defaultBlocks`. |
| **Page** | `cms_pages` | slug, status (draft/published/archived), scheduling, SEO, i18n locale. |
| **Placement** | `cms_page_blocks` | puts a block into a page's region at a position; `isShared` + per-placement `overrides`. |
| **Revision** | `cms_page_revisions` | a fully-assembled JSON snapshot written at publish time (the public API serves this). |
| **Media** | `cms_media` | a `fileRef` column → R2; bytes go through `ctx.files`, blocks reference a media id. |

## Which pramen primitive does the work

Nothing here is bespoke infrastructure — it composes what pramen already ships:

- `t.json()` — block/page field payloads, field schemas, overrides, snapshots
- `t.fileRef()` + R2 + `ctx.files` — media
- relations (`belongsTo`/`hasMany`) — page ↔ placement ↔ block ↔ type traversal
- the **ACL** — editor RBAC (`cmsPolicies().editor`) and public read of published pages only (`cmsPolicies().public`)
- `ctx.tasks` (the transactional outbox) — `schedulePage` enqueues a delayed publish/unpublish
- live queries (via `@pramen/react`) — a live-updating page/preview for free (single-writer DO)

## Usage

```ts
import { defineSchema, createApp, role } from "@pramen/server";
import { cmsSchema, cmsHandlers, cmsPolicies, cmsTasks } from "@pramen/cms";

const schema = defineSchema({ ...cmsSchema /*, ...yourEntities */ });
const handlers = { ...cmsHandlers /*, ...yourHandlers */ };
const acl = [
  role("anonymous", [...cmsPolicies().public]),
  role("editor", [...cmsPolicies().editor]),
];
export const app = { schema, handlers, acl, tasks: { ...cmsTasks } };
```

Editor flow: `createBlockType` → `createContentType` → `createPage` → `addBlock` →
`publishPage`. Public: `getPage({ slug })` returns the published snapshot; editors pass
`{ slug, preview: true }` to assemble the live draft.

### Preview links

`{ preview: true }` is a **role** check, so it only serves people who have an editor
account. The person preview actually exists for — the stakeholder reviewing copy before it
ships — usually has no account at all. For them, mint a signed link:

```ts
const { url, expiresAt } = await client.call("signPagePreview", { pageId, expiresIn: 3600 });
// -> { url: "/cms/preview?token=…", expiresAt }
```

Minting is editor-gated; **redeeming needs no session** — the signature is the
authorization. Spread `cmsRoutes()` into `app.routes` to serve `GET /cms/preview`, which
verifies the token in the Worker before any read and returns the live draft with
`isPreview: true` and `Cache-Control: private, no-store`.

If you pass custom roles to `createCmsHandlers`, hand `cmsRoutes` the **same options
object** — it derives the route's identity from them, so the two cannot drift:

```ts
const cms = { editorRoles: ["editor"], reviewerRoles: ["reviewer"] };
const handlers = { ...createCmsHandlers(cms) };
const routes = [...cmsRoutes({ handlers: cms })];
```

That identity must also be granted by your ACL. Preview is **DO-only**: redemption reaches
the Durable Object, so `signPagePreview` refuses on the D1 store rather than mint a link
that could never be redeemed.

The grant is scoped to **one page** and carries its own expiry (default 1 hour, clamped to
30 days), so a leaked link is not "see all drafts" and stops working on its own. Signing
uses `PREVIEW_SECRET`, falling back to `FILES_SECRET` then `AUTH_SECRET` — the same
machinery as signed file urls. With no usable secret (≥16 chars) minting and verification
both **fail closed** rather than hand out forgeable links.

From an Astro site, `createCmsClient(...).getPreview(token)` redeems one.

### Typed block fields

A developer-authored block type gets compile-time typing with no build step —
`defineBlockType(slug, fields as const)` plus `BlockFieldsOf<typeof def>`.

Webmaster-authored types are **data** (rows in `cms_block_types`, added with no deploy), so
they can't be typed at compile time. Read them back out of a running instance instead:

```bash
bunx pramen-cms types --url https://cms.example.workers.dev --tenant acme --out src/cms.gen.ts
```

Run it with **bun** (`bunx`), like the `pramen` bin — both ship extensionless ESM imports
that plain Node won't resolve. Its own bin rather than a `pramen` subcommand, because
`@pramen/cms` is optional and the runtime CLI shouldn't carry a command named after it.

That writes an interface per block-type slug plus a `BlockFieldsBySlug` registry. With no
`--out` it prints, so it composes with a pipe. Re-run it after a webmaster adds or changes
a block type.

### Trash (soft delete)

`deletePage` and `deleteMedia` are **soft**: the row stays and `deletedAt` is stamped.
Filtering lives in the ACL, not in each handler — a read scope is AND-merged into every
`ctx.db` read, so one policy hides a trashed row from the public content API, the editor,
`listPublishedPages`/the sitemap, relation traversals and eager-loads at once.

| Handler | Role | Effect |
| --- | --- | --- |
| `deletePage` / `deleteMedia` | editor | stamp `deletedAt` — reversible |
| `listTrash` | editor / reviewer | what is currently trashed — `{ pages, media }` |
| `restorePage` / `restoreMedia` | editor | clear `deletedAt` |
| `purgePage` / `purgeMedia` | reviewer | permanent — row, placements, revisions, audit, R2 object |

Two caveats about doing it in the ACL:

- **Policies are OR-unioned.** If your app adds its own `allow()` policy on `cms_pages` or
  `cms_media` alongside `cmsPolicies().editor`, that grant unions the trash filter away and
  trashed rows become visible again. Scope your own grants with `deletedAt: { isNull: true }`.
- **The task context bypasses the ACL entirely** (it runs SYSTEM-scoped), so scheduled
  publish/unpublish are not protected by the read scope. `deletePage` clears `scheduledAt`
  and `unpublishAt` for exactly this reason — without that, a page trashed before its
  scheduled time came back publicly live.

Two things worth knowing:

- **A trashed page keeps its slug.** `(slug, locale)` is a DB unique index, so the
  alternative was mangling the stored slug on delete. Creating a page over a trashed slug
  fails with a message saying so; purging frees it.
- **Trashing media keeps the R2 object.** Dropping the bytes would make `restoreMedia` a
  lie, and a block still referencing the id would render a dead url. `purgeMedia` removes
  both.

### Concurrent edits

`cms_pages` and `cms_blocks` carry a `version` that bumps on every edit. Pass the version
you read back as `expectedVersion` and a stale write is refused with **409 conflict**
instead of silently overwriting whoever saved first:

```ts
const { page: current } = await client.call("getPage", { slug, preview: true });
const { page: saved } = await client.call("updatePage", {
  pageId: current.id,
  title,
  expectedVersion: current.version,
});
// 409: "this page was changed by someone else (you have version 3, current is 4)"
```

The DO is a single writer, so writes already serialize — but *editors* don't. Without this,
two people on the same page meant last-save-wins with no signal to the loser.

`expectedVersion` is **optional**: omit it and you get the previous last-write-wins
behaviour. `updatePage` and `updatePageSeo` share the page's version line, so a body edit
and an SEO edit conflict with each other; blocks version independently.

Structural operations (`addBlock`, `removeBlock`, `reorderRegion`) are not guarded — they
are additive and already ordered by the single writer.

`version` is returned on `AssembledPage.page` and on every `RenderedBlock`, so the value to
echo back comes from the same read that loaded the content — including the public
(snapshot) path, where it is backfilled from the live row rather than the baked snapshot.

On the **D1 store** (`x-pramen-store: d1`) there is no interactive transaction, so two
requests in the same millisecond can both read the same version and both write. The guard
still catches the editor race it exists for; it is not a hard mutex there.

### Rendering (headless)

The backend never dictates markup. `@pramen/cms/react` maps a block's `block_type` slug to
a component you provide:

```tsx
import { RegionRenderer } from "@pramen/cms/react";
import { useLiveQuery } from "@pramen/react";

const components = { hero: Hero, rich_text: RichTextBlock };
function Page({ slug }: { slug: string }) {
  const { data } = useLiveQuery(client, "getPage", { slug });
  if (!data) return null;
  return <RegionRenderer regions={data.regions} name="content" components={components} />;
}
```

A `richtext` field is a **document tree**, not an HTML string — render it with
`RichTextRenderer`, which walks the tree into real elements (no `dangerouslySetInnerHTML`,
nothing to sanitize at render time):

```tsx
import { RichTextRenderer } from "@pramen/cms/react";

const RichTextBlock = ({ fields }) => <RichTextRenderer value={fields.body} />;
```

Pass `components` to override any node type (`paragraph`, `heading`, `link`, …) with your
own element. `richTextToPlainText(doc)` flattens a document for excerpts and meta
descriptions.

Writes are checked against a structural allow-list (`normalizeRichText`): an unknown node
or mark type is dropped, only declared attributes survive, and a `link` href must pass a
scheme check — so a hand-crafted payload can't smuggle markup past the editor. Widen or
narrow the vocabulary with `createCmsHandlers({ richTextSchema })` (also accepted by
`createCollectionHandlers`) when your editor adds TipTap extensions.

Opening a page in the editor **migrates** any legacy HTML rich text on it: each field
converts to a document on mount and the ordinary autosave persists it. That conversion is
lossy for anything the editor's extension set doesn't model (an `h4` clamps to `h3`;
`sub`/`sup`/`ins` flatten), so convert deliberately if that matters.

Heading levels are 1–3 by default, matching the shipped editor's StarterKit config — raise
`richTextSchema.maxHeadingLevel` if your editor is configured for more. Out-of-range levels
are **clamped**, not dropped: a level-less heading would render as `h1` in the editor and
`h2` on the site — TipTap silently
demotes an unknown level on parse, so permitting more meant an imported `h4` opened as `h1`
and the next autosave persisted that.

Both renderers re-check a link's href rather than trusting the stored document: the write
path normalizes, but a row written by your own mutation, a bootstrap seed or an import
script never passed through it, and the renderer is what puts it on a page.

### Collection workflow (`supports`)

A **collection** points the editor at one of your own pramen entities. By default it is
plain CRUD — no notion of published. `supports` opts it into the page-style workflow:

```ts
const talks = collection("talks", {
  entity: "talks",
  label: "Talk",
  supports: ["drafts", "scheduling", "revisions", "preview"],
  fields: [
    { name: "title", type: "text", required: true },
    { name: "speaker", type: "text" },
  ],
});
```

Each feature is backed by **managed columns on your entity** — you declare the columns, the
CMS owns their values:

| Feature | Columns you add | Handlers you get |
| --- | --- | --- |
| `drafts` | `status` | `collectionPublish` / `collectionUnpublish` |
| `scheduling` | `publishedAt`, `scheduledAt`, `unpublishAt` | `collectionSchedule` (needs `drafts`) |
| `revisions` | — (uses `cms_collection_revisions`) | `collectionListRevisions` / `collectionRestoreRevision` |
| `preview` | — | `signCollectionPreview` (needs `drafts`) |

```ts
talks: Entity((t) => ({
  id: primaryKey(generated(t.uuid())),
  title: t.text(),
  status: defaultTo(t.text(), "draft"),   // managed
  publishedAt: t.text(),                  // managed
  scheduledAt: t.text(),                  // managed
  unpublishAt: t.text(),                  // managed
  createdAt: defaultTo(t.text(), expr.now()),
})),
```

Wire all three pieces — the handlers need your `schema`, and **scheduling silently never
fires without the tasks**:

```ts
const handlers = { ...cmsHandlers, ...createCollectionHandlers(collections, { schema }) };
const tasks    = { ...cmsTasks,    ...createCollectionTasks(collections) };
const acl = [
  role("anonymous", [...cmsPolicies().public, ...collectionPublicPolicies(collections)]),
  role("editor",    [...cmsPolicies().editor, ...collectionPolicies(collections)]),
  // a reviewer previews collection rows, so it needs the collection grants too —
  // `getCollectionPreview` is gated with editorRoles ∪ reviewerRoles:
  role("reviewer",  [...cmsPolicies({ prefix: "cms-rev" }).editor,
                     ...collectionPolicies(collections, { prefix: "cms-rev" })]),
  // …and EVERY other role that should see published content:
  role("user",      [...cmsPolicies({ prefix: "cms-user" }).public,
                     ...collectionPublicPolicies(collections, { prefix: "cms-user" })]),
];
```

> **`anonymous` is not "everyone".** pramen assigns that role only to callers with **no
> verified token**, so granting public reads there alone means a **logged-in** user is
> denied content a logged-**out** visitor can read — a public list handler returns rows to a
> guest and 403s for a member. There is no implicit everyone-role: spread the public grants
> into each role that should have them (distinct `prefix` per role keeps the policy names
> unique).

**A managed column is never in the write whitelist.** `fields` is the whitelist, so a
`status` entry there would let any editor send `values: { status: "published" }` through
`collectionUpdate` and skip the publish gate entirely. Declaring one is a **boot error**.

`createCollectionHandlers` **requires your `schema`** and validates the whole registry
against it at startup, naming the collection and the column, rather than failing on the
first call months later. It refuses:

- a managed column that is missing, `notNull()`, `hidden()`, not `t.text()`, or also
  declared as an editable field — a name check alone left "the CMS owns these values"
  resting on a convention, and every wrong declaration failed *silently* (a `t.json()`
  `status` stores `"\"published\""`, so the row is invisible forever while Publish reports
  success);
- a declared field that is not a column on the entity, or whose type cannot live in that
  column (`richtext`/`group`/`repeater` need `t.json()`) — otherwise the first write fails
  with a raw driver message and no HTTP status;
- an `idField` that is not the entity's primary key, an `orderBy` over a missing column
  (SQLite resolves the quoted name to a *constant* and sorts every row equal — no error),
  an entity outside the default partition (every handler dispatches there), an unknown
  feature, and `scheduling`/`preview` without `drafts`;
- **two collections over the same entity.** The ACL keys policies by `(role, entity,
  action)` and OR-merges them, so a second collection does not add a second view — it
  *widens* the first one's read scope.

All of this now applies to a collection with no `supports` too: it is column-mapped just
the same.

`collectionPublicPolicies` is the **actual access boundary**, not a UI filter — it is
AND-merged into every `ctx.db` read of the entity, so an unpublished row is invisible to
your public queries, relation traversals and eager-loads alike. With `scheduling` it scopes
to:

```
status = 'published'
  AND (publishedAt IS NULL OR publishedAt <= $now())
  AND (unpublishAt IS NULL OR unpublishAt > $now())
```

Both time clauses matter. `{ publishedAt: { isNull: false } }` matches a *future* timestamp,
so a row scheduled for next week would be public the moment it was saved. And the
`unpublishAt` clause means a scheduled **takedown** is enforced by the read itself, not only
by the task — if `createCollectionTasks` was never wired or the outbox drain is stuck, the
row still stops being readable at its instant. That is the direction where failing open is
worst.

`publishedAt IS NULL` counts as published: a row seeded by `cmsBootstrap`, imported, or
published while the collection was still `supports: ["drafts"]` has no stamp, and
`NULL <= '2026-…'` is NULL — so requiring the comparison alone emptied a whole public site
the moment `scheduling` was added to an existing collection. NULL cannot mean "scheduled for
later": `publishedAt` is managed (never client-writable) and only ever takes *now* or null,
while a row awaiting a scheduled publish is `status: 'draft'` with the instant in
`scheduledAt`.

The grant is restricted to **the declared fields, the id, `status`, and (with `scheduling`)
`publishedAt`**. An entity column that is not in `fields` — an `internalNote`, a
`reviewerEmail` — stays private even on a published row, so adding one later doesn't quietly
publish it. `publishedAt` is in because a caller may not `orderBy` a column it cannot read,
and "newest published first" is the public query: excluding it 403'd anonymous while working
for an editor. The forward-looking `scheduledAt` / `unpublishAt` stay out — "this comes down
on Friday" is not public.

Your public read then stays an ordinary list — see `publicLectures` in `example/app.ts`.

Managed timestamps are minted as ISO-8601 UTC (`2026-08-20T12:00:00.000Z`) in exactly one
place, because the scope compares against `$now()` **lexicographically**. This is what
closes the trap the old `publish` field type carried, where `publish` and `datetime` wrote
different formats into the same TEXT column and sorted against each other as if hours apart.

Revisions snapshot the row's state **before** each content write — an edit, and a restore
itself — so a restore is a plain reversal that replays through the same whitelist rather
than resurrecting a column the collection no longer owns.

The snapshot is taken through the raw path, so **history does not depend on who made the
edit**: an editor whose read policy withholds a column would otherwise have silently dropped
it from the snapshot, and every later "restore to before that edit" would restore an
incomplete row. Reading history is projected the other way — `collectionListRevisions`
narrows each snapshot to the fields *that* caller may read on the entity, and
`collectionRestoreRevision` writes back exactly that set. Field-level read policies hold
through history; what you can see is what you can put back.
Publish and unpublish write **no** revision: they change no content, so the entry would be
identical to the edit before it and restoring it would do nothing visible.

Ordering is by a monotonic per-row `revision` counter, never a timestamp — a revision is
written on every edit, and two writes land in the same millisecond often enough that
"restore the previous version" would otherwise be a coin flip.

`collectionDelete` **purges** the row's revisions. A collection PK can be a caller-chosen
`textId`, so an id can come back; inherited history would let an editor restore a deleted
row's content over the new one.

Ordering is backed by a composite `unique` on `(collection, rowId, revision)`. The
read-then-increment is serialized by the DO's single writer, but **on the D1 store it is
not** — `D1Driver.transaction` is a no-op, since D1 has no interactive transactions — so the
index is what turns a concurrent duplicate into a visible failure instead of a silently
ambiguous history. For the same reason the delete-and-purge pair is atomic on the DO but not
on D1.

## Limitations

- **Block `fields` are opaque JSON**, so pramen's row/cell-level ACL and relational queries
  don't reach inside a block — access is gated at the page/block level. Fine for content;
  note it.
- **No typed inference for block field data** yet (types are runtime `FieldDefinition[]`). A
  hybrid typed-block layer (inference + codegen) is a planned phase.
- **Media orphan sweeping is manual** — `deleteMedia` removes a blob explicitly, but media no
  longer referenced by any block isn't auto-collected (refs live inside opaque block JSON).
  Deleting media still used on a published page breaks that page's image until re-publish.
- **Per-locale slug uniqueness is enforced in handler code**, not the schema — pramen's
  `unique()` is single-column only, so `(slug, locale)` can't be a schema constraint. A
  concurrent double-insert of the same `(slug, locale)` could in theory slip past the
  SELECT-then-insert guard (the DO's single-writer makes this effectively safe per tenant).
- **No draft autosave / optimistic-locking / presence** — the DO's single-writer + live
  queries make these straightforward to add, but they aren't here yet.
- **Field validation is structural**, not exhaustive (no cross-field rules, no referential
  checks on `media` ids, unknown keys pass through, `default` values aren't applied).
- **Scheduled publish uses fire-time intent tokens, not cancellable jobs.** Outbox tasks
  can't be recalled, so `schedulePage` stores the scheduled times on the page and each task
  carries the token it was enqueued for; at fire time it acts only if its token still
  matches (so a reschedule, a manual publish/unpublish, or a duplicate delivery makes a
  stale task a no-op). The `cms:publish` task is not transactional (the interactive
  `publishPage` is), so a crash mid-task self-heals on the next at-least-once redelivery.
- **Collections have no trash.** `supports` covers drafts/scheduling/revisions/preview;
  `collectionDelete` is a hard delete and also purges the row's revisions. Soft delete is
  `cms_pages`-only.
- **Listing revisions is gated by the row's read scope**, so a *deleted* row's history is
  unreachable through `collectionListRevisions` (it is purged on delete anyway).
- **`collectionSchedule` patches the takedown, it doesn't reset it.** Omitting `unpublishAt`
  leaves an existing one standing (so moving a publish date doesn't silently revoke a
  scheduled removal); pass `unpublishAt: null` to cancel one deliberately. The new publish
  instant is checked against the takedown *already stored*, not just one sent in the same
  call — a reschedule cannot slide the publish past a pending takedown (which would fire
  first, cancel itself, and leave the row public forever).
- **A schedule converges, in any drain order.** The tasks are at-least-once and can drain
  arbitrarily late. The publish task therefore resolves to the state the schedule implies at
  drain time: if the takedown instant has also passed by then, the row lands **down**, with
  both tokens spent — it does not publish and discard the takedown. The takedown task
  likewise clears the pending publish token, so a retried or late publish cannot resurrect
  the row.
- **An interactive publish is different from the scheduled one**: `collectionPublish` clears
  a takedown instant that has already passed and puts the row live, because a person with
  publish rights is saying "live, now" about a takedown that has already been served. A
  *future* takedown always stands.
- **Scheduling a future publish does not take a live row down.** `collectionSchedule` sets
  `scheduledAt` and leaves `status`/`publishedAt` alone (parity with `schedulePage`), so
  scheduling a *published* row means it stays public until the task re-stamps it. Unpublish
  first if you meant "not live until then". Doing this implicitly would be a takedown the
  editor never asked for, which is why it isn't automatic — but the editor UI should make
  the current state obvious.
- **A collection's `supports` features are per-row, not per-locale** — there is no
  translation-group equivalent for collections.
- **Duplicate slugs surface as 500, not 409** (a framework-wide limitation, not CMS-specific).
