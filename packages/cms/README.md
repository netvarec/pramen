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

### Rendering (headless)

The backend never dictates markup. `@pramen/cms/react` maps a block's `block_type` slug to
a component you provide:

```tsx
import { RegionRenderer } from "@pramen/cms/react";
import { useLiveQuery } from "@pramen/react";

const components = { hero: Hero, rich_text: RichText };
function Page({ slug }: { slug: string }) {
  const { data } = useLiveQuery(client, "getPage", { slug });
  if (!data) return null;
  return <RegionRenderer regions={data.regions} name="content" components={components} />;
}
```

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
- **Duplicate slugs surface as 500, not 409** (a framework-wide limitation, not CMS-specific).
