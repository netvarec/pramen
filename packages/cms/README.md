# @pramen/cms

A **block / page builder** for pramen — Drupal-Paragraphs-style typed content blocks
arranged in named regions, reusable blocks, scheduled publishing — built **entirely from
pramen primitives**. It is an ordinary app fragment (schema + handlers + ACL + tasks), not
a new runtime. Inspired by [WollyCMS](https://github.com/wollycms/wollycms) / Drupal
Paragraphs / Storyblok.

> **Status: spike.** Proven end-to-end against a real Durable Object by `test/suites/cms.ts`.
> Not yet hardened for production — see *Limitations* below.

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

## Limitations (spike)

- **Block `fields` are opaque JSON**, so pramen's row/cell-level ACL and relational queries
  don't reach inside a block — access is gated at the page/block level. Fine for content;
  note it.
- **No typed inference for block field data** (types are runtime `FieldDefinition[]`). A
  code-first, typed block DSL is a possible future direction.
- **Single-column unique slug** — per-locale slug uniqueness / full i18n is stubbed
  (`locale` column exists; routing by it is not built).
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
