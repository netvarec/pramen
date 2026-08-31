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

A **React visual editor** — page list, a region canvas with allowed-type block palettes,
schema-driven field forms (incl. a media picker, date/datetime pickers, repeaters, groups),
and inspector panels for SEO / workflow / i18n / audit. It mutates through the semantic
handlers (so all validation and gates apply).

**Your Astro site serves it**, at `/_pramen/admin` — one line in the integration:

```js
pramenCms({ backend: { url: "https://cms.example.workers.dev" }, admin: true })
```

That injects a catch-all Astro route, so every view is a real server route on your own
origin. There is no `dist/` to deploy, no second hostname for the editor, no SPA-fallback
rewrite to configure, and nothing to point it at — the shell tells it which Worker and
tenant to call, so the first screen asks for an editor/reviewer JWT and nothing else. The
editor's two assets (`editor.js`, `editor.css`) go through your site's bundler like any
other import, which is what makes the prefix mount work at all.

This moves where the editor is SERVED, not where the API lives: it still calls
`backend.url`, so a CMS on its own Worker remains cross-origin and still needs
`CORS_ORIGINS` set to your site. Co-deploy the CMS into the site's Worker and that goes
away too.

`admin` also carries the editor's own configuration, replacing the old `/config.js`:

```js
admin: {
  brand: { name: "Acme", suffix: "cms" },      // the wordmark — set it when you deploy for a client
  signInUrl: "/signin/",                        // must be a page that EXISTS (see below)
  hidePages: true,                              // collections-only deployments
  extraNav: [{ label: "Curation", href: "/curate", target: "_self" }],
}
```

`extraNav` links open in a **new tab** by default, because the editor's catch-all route
matches every same-origin path — a same-tab click would land on the editor's own 404 instead
of your tool. Add `target: "_self"` to ask for a same-tab navigation; it is honoured only
where the router provably will not claim the url:

| Link | Editor mounted under a prefix | Editor at the origin root |
| --- | --- | --- |
| Another origin (`https://tools.acme.com/x`) | same tab | same tab |
| Same origin, outside the mount (`/curate`) | same tab | new tab |
| Same origin, inside the mount | new tab | new tab |

Anything else — a relative href that resolves back inside the mount, a `javascript:` url, an
unparseable one — degrades to a new tab rather than stranding the editor on its 404. A
same-tab link runs the unsaved-changes guard first, so it cannot silently discard an edit in
progress.

Views are real, deep-linkable URLs — file-based routing via [`@buzola/router`](https://www.npmjs.com/package/@buzola/router)
(`/`, `/media`, `/users`, `/settings`, `/pages/:pageId?tab=seo`, each under the mount
prefix), so Back/Forward and refresh behave. Navigation is scoped to the mount: a click on
one of your own site's pages leaves the editor instead of being swallowed by its catch-all
route.

> `signInUrl` must be a page that exists. An unauthenticated load calls it *after* clearing
> the stored session, so a path that lands back inside the editor is a loop with nothing to
> recover from. `?setup=1` always forces the built-in screen, for pasting a first-admin JWT.

A working site is in `example/site` — content collections and the admin route in one
`pramenCms()` call, against the example backend in `example/app.ts`.

For local work on the editor itself, `bun run --cwd packages/cms-editor dev` serves it at
the origin root on <http://localhost:5175> against whatever Worker you point it at.

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
