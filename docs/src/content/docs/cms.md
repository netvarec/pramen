---
title: CMS
order: 13
summary: A block/page builder (@pramen/cms) + a visual editor (@pramen/cms-editor) — typed content blocks in named regions, media, i18n, editorial workflow, and SEO.
---

## @pramen/cms

An optional **block/page builder** — Drupal-Paragraphs-style typed content blocks arranged
in named regions — built entirely from pramen primitives (`t.json()`, `t.fileRef()`+R2,
relations, ACL, `ctx.tasks`). It's an ordinary app fragment: spread its schema, handlers,
policies, tasks, and routes into your app.

```ts
import { defineSchema, createApp, role } from "@pramen/server";
import { cmsSchema, cmsHandlers, cmsPolicies, cmsTasks, cmsRoutes } from "@pramen/cms";

const schema = defineSchema({ ...cmsSchema /*, ...yourEntities */ });
const acl = [
  role("anonymous", [...cmsPolicies().public]),
  role("editor",    [...cmsPolicies({ prefix: "cms-ed" }).editor]),
  role("reviewer",  [...cmsPolicies({ prefix: "cms-rev" }).editor]),
];
export const app = {
  schema,
  handlers: { ...cmsHandlers /*, ...yourHandlers */ },
  acl,
  tasks: { ...cmsTasks },
  routes: [...cmsRoutes() /* GET /sitemap.xml + /robots.txt */],
};
```

### Model

| Concept | Table | Notes |
|---|---|---|
| Block **type** | `cms_block_types` | slug + a recursive `fieldsSchema` (JSON). Data-driven — add one with no deploy. |
| Block **instance** | `cms_blocks` | content matching a type's schema; optionally reusable. |
| **Content type** | `cms_content_types` | a page's `regions` (each with an `allowedTypes` allow-list) + `defaultBlocks`. |
| **Page** | `cms_pages` | slug (per-locale), status, scheduling, SEO, locale + `translationGroupId`. |
| **Placement** | `cms_page_blocks` | a block in a region at a position; `isShared` + per-placement `overrides`. |
| **Revision** | `cms_page_revisions` | the assembled snapshot written on publish (served publicly). |
| **Audit** | `cms_audit` | append-only workflow transitions (who/when). |
| **Media** | `cms_media` | a `fileRef` → R2. |

### Content API

`getPage({ slug, locale?, preview? })` returns an `AssembledPage` — `page` (meta + `seo` +
`translations` for hreflang) and `regions` (each a list of `RenderedBlock`s with resolved
media). Anonymous callers get the published snapshot; editors pass `preview: true` for the
live draft.

### Features

- **Media** — `signMediaUpload` → PUT → `createMedia`; `"media"` block fields resolve to
  servable URLs; public `GET /media/<key>` route + Cloudflare Image Resizing (`imageUrl()`).
- **i18n** — per-locale slugs, `translationGroupId`, `createTranslation`/`listTranslations`,
  locale-aware `getPage`, hreflang alternates.
- **Editorial workflow** — `draft → review → published` (+ rejected/archived), reviewer-gated
  `approve`/`publishPage`, and a `cms_audit` trail recording the actor.
- **Scheduling** — `schedulePage` uses intent-token outbox tasks (cancel-on-reschedule).
- **SEO** — per-page meta/canonical/robots/OpenGraph/JSON-LD + `GET /sitemap.xml` and
  `/robots.txt` (`cmsRoutes()`).

### Typed blocks (hybrid)

Block types are data-driven, but developers can get compile-time field typing:
`defineBlockType("hero", [...] as const)` + `BlockFieldsOf<typeof hero>` (no build step), or
`generateBlockTypes(rows)` to emit `.ts` interfaces from DB-stored schemas.

## @pramen/cms-editor

A standalone **React visual editor** — page list, a region canvas with allowed-type block
palettes, schema-driven field forms (incl. a media picker, date/datetime pickers, repeaters,
groups), and inspector
panels for SEO / workflow / i18n / audit. It mutates through the semantic handlers (so all
validation and gates apply). Build with `bun --cwd packages/cms-editor run build`, deploy the
static `dist/`, and point it at your Worker (set `CORS_ORIGINS`) with an editor/reviewer JWT.

### Users & settings

Two extra tabs surface the `@pramen/auth` management handlers, so they appear only when
those handlers are wired into your app (`createUserHandlers`/`authPolicies` + `inviteUser`):

- **Users** (admin-only — gated on `me.roles` including `admin`) — invite a teammate by
  email (`inviteUser` sends a one-time magic link and creates the account, defaulting to the
  `editor` role), edit roles inline (`setUserRoles`), activate/deactivate (`setUserActive`),
  and delete (`deleteUser`). You can't deactivate or delete your own account.
- **Settings** — account self-service for any signed-in user: change your contact email
  (`changeEmail`) or password (`changePassword`), plus an about card and sign-out.

Both go through the same ACL-gated handlers, so a non-admin who forges the tab still hits a
403 on the server.
