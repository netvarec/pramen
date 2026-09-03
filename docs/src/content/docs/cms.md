---
title: CMS
order: 13
summary: A block/page builder (@pramen/cms) + a visual editor (@pramen/cms-editor) — typed content blocks in named regions, media, i18n, editorial workflow, SEO, site furniture, and custom admin pages.
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
| **Menu** | `cms_menus` | a named nav tree, read whole; items store a page/term reference rather than an href. |
| **Redirect** | `cms_redirects` | a canonicalized `fromPath` → `toPath`, with an off-switch that keeps the row. |
| **Taxonomy** / **Term** | `cms_taxonomies`, `cms_terms` | vocabularies you declare; terms nest only where the vocabulary says so. |
| **Term assignment** | `cms_page_terms` | the explicit `manyToMany` junction, so `where: { terms: … }` traverses it. |
| **Widget area** | `cms_widget_areas` | a named layout slot; a `menu` widget resolves inline on read. |

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

### Authoring types from the editor

Block types and content types are data, so the editor authors them: **Types** (`/schema`)
lists both and opens a builder for either. The block-type builder edits a
`FieldDefinition[]` — the inverse of the form `FieldForm` renders from one — and the
content-type builder edits regions (name, label, an `allowedTypes` allow-list) plus optional
page-level fields and default blocks.

A slug is fixed once created. A block type's is the key your front end maps to a component
(`{ rich_text: RichText }`), and a content type's addresses that type's own page list — so
renaming one orphans every block of that type, or breaks every link to the list.

The schema you author is validated server-side (`normalizeFieldSchema`), not just in the
form: a field name has to be usable as an object key, siblings cannot share one, a `select`
needs options or an `optionsFrom` handler, a `group`/`repeater` needs at least one nested
field, and a `slug`'s `from` must name a text field standing beside it. These are refusals
rather than warnings because none of them fails visibly — an unknown field type renders
nothing and `validateFields` skips it, so the field's content is quietly lost on every save.

The whole area is gated on `listCmsCapabilities().canEdit`, i.e. the deployment's own
`editorRoles`. A reviewer can read everything and author nothing.

### Site furniture

The site-level things every project used to rebuild by hand. All four are read by your
layout, not by a page, and each gets its own editor section.

| | Read with | Notes |
|---|---|---|
| **Menus** | `getMenu("primary")` | A nested `MenuItem[]`, stored as one document. |
| **Redirects** | `resolveRedirect({ path })` | Exact lookup on a canonicalized, unique path. |
| **Taxonomies** | `listTaxonomies` / `getTermTree` / `listPagesByTerm` | `category`/`tag` are not built in — you declare what the site sorts by. |
| **Widget areas** | `getWidgetArea("sidebar")` | A named layout slot an editor fills without a deploy. |

All of those reads are **public**; every write is editor-gated. Spread
`cmsPolicies().public` and `.editor` as before — the furniture tables are already in both.

**A menu item stores a reference, not an href.** `kind: "page"` holds a page id and the URL
is worked out when the menu is read, so a link follows its page instead of breaking the day
someone changes a slug. Resolution goes through `ctx.db`, which means the anonymous page
scope decides it: an item pointing at an unpublished or trashed page is left out of the
public menu rather than rendered as a dead link. Override the routing with `menuHref`:

```ts
createCmsHandlers({
  menuHref: (t) => (t.kind === "page" ? `/clanky/${t.slug}` : `/${t.taxonomy}/${t.slug}`),
})
```

**Redirects** are what a slug change needs. `fromPath` is canonicalized on write (trailing
slash, query and fragment removed) because matching is an exact lookup on a unique column —
`/old` and `/old/` would otherwise be two rows and only one of them could ever match.
Disabling a redirect keeps the record of what the old URL was; deleting it does not. There
is deliberately **no hit counter**: counting would turn the one handler anonymous 404 traffic
calls into a write.

Serving one is the site's job. `@pramen/cms-astro` exposes `client.resolveRedirect(path)`
and a `redirectResponse(client, url)` helper for the 404 path — that is where it belongs,
since a lookup in front of every render would buy a round trip to answer "no" almost every
time:

```astro
---
// src/pages/404.astro
import { redirectResponse } from "@pramen/cms-astro";
const redirect = await redirectResponse(client, Astro.url);
if (redirect) return redirect;
---
```

**Taxonomies** are an explicit junction (`cms_page_terms`), so "pages in this category" is an
ordinary query — `where: { terms: { slug: "news" } }` compiles to a subquery. Terms nest only
in a vocabulary declared `hierarchical`, and a parent that would close a cycle is refused on
write, which is the only place a cycle is preventable. Assign terms from the **Terms** panel
in the page editor.

**Widget areas** are their own entity rather than a page-less block region: making
`cms_page_blocks.pageId` nullable would push a null branch through every placement read and
every page-scoped policy, to model something that shares no field with a page. A `menu`
widget is resolved inline by `getWidgetArea`, so a whole sidebar is one call.

### Nav placement

The editor's primary nav is ordered by a number, not by the sequence it is written in. Every
built-in has a position in `NAV_ORDER` (spaced 100 apart), and a collection or a host link
can declare its own:

```ts
import { NAV_ORDER, collection } from "@pramen/cms";

collection("lectures", { /* … */ navOrder: NAV_ORDER.pages + 10 })   // right after Pages
```

```js
admin: { extraNav: [{ label: "Curation", href: "/curate", order: NAV_ORDER.media - 1 }] }
```

Anything without one keeps the position it always had, so an existing deployment does not
move. This matters more than it sounds: before it, the only extension seam rendered *after*
Settings and opened a new tab, so a project-specific section was structurally the last item
and structurally a second application.

### The `reference` field

`optionsFrom` on a `select` fetches `{ value, label }[]` once and renders a dropdown. That is
the right answer for twenty campaigns and no answer at all for a thousand records: no search,
no paging, and no way to render the label of a stored value that is not in the one page it
fetched, so an existing row shows a uuid.

A `reference` field points at a handler that answers **two** shapes:

```ts
{ name: "campaign", type: "reference", referenceFrom: "lookupCampaigns" }
```

```ts
lookupCampaigns: query(async (ctx, i: { search?: string; limit?: number; offset?: number; ids?: string[] }) => {
  if (i.ids) {                                   // resolve labels for values already stored
    const rows = await ctx.db.find({ from: "campaigns", where: { id: { in: i.ids } }, limit: i.ids.length });
    return { items: rows.map((r) => ({ value: String(r.id), label: String(r.name) })) };
  }
  const rows = await ctx.db.find({            // browse / search
    from: "campaigns",
    where: i.search ? { name: { contains: i.search } } : undefined,
    limit: i.limit ?? 20,
    offset: i.offset ?? 0,
  });
  return { items: rows.map((r) => ({ value: String(r.id), label: String(r.name), hint: String(r.status) })), hasMore: rows.length === (i.limit ?? 20) };
}),
```

The value is stored as an **opaque id**, so the same field links a pramen row or a record in
a system you do not own. `multiple: true` stores a list, which needs a `t.json()` column on a
collection rather than `t.text()`.

### Custom admin pages (Block Kit)

Client sites are mostly conventional, and nearly every one grows **one section that is not**:
a screen over an external API, a filtered browse UI over data you do not own, a bespoke
picker. `adminPage()` is where that goes — a real screen inside the admin's own chrome, at a
nav position you choose.

```ts
import { adminPage, createAdminPageHandlers, NAV_ORDER } from "@pramen/cms";

const desk = adminPage<typeof schema>("lecture-desk", {
  label: "Lecture desk",
  icon: "🗂",
  navOrder: NAV_ORDER.pages + 10,
  roles: ["editor", "admin"],          // defaults to the deployment's editorRoles
  async render(ctx, i) {
    if (i.type === "block_action" && i.action_id === "clear" && typeof i.value === "string") {
      await ctx.db.update("lectures", i.value, { speaker: null });
    }
    const q = typeof i.values?.q === "string" ? i.values.q : "";
    const rows = await ctx.db.find({ from: "lectures", where: q ? { title: { contains: q } } : undefined, limit: 25 });
    return {
      blocks: [
        { type: "header", text: "Lecture desk" },
        { type: "actions", block_id: "filter", elements: [
          { type: "text_input", action_id: "q", label: "Search", initial_value: q },
          { type: "button", action_id: "search", label: "Search", style: "primary" },
        ] },
        { type: "table", columns: [{ key: "title", label: "Title" }], rows: rows.map((r) => ({ title: String(r.title) })) },
      ],
      toast: { text: "Done", tone: "success" },
    };
  },
});

handlers = { ...createAdminPageHandlers([desk]) };
```

The server describes the UI as JSON and the editor renders it, so **no project JavaScript
runs in the admin**. Blocks: `header`, `section`, `context`, `divider`, `fields`, `table`,
`stats`, `image`, `columns`, `accordion`, `empty`, `actions`, `form`. Inputs: `text_input`,
`number_input`, `select`, `toggle`, `secret_input`.

`render` is an ordinary handler body with the caller's own context, so `ctx.db` is scoped by
the same policies as everywhere else — Block Kit removes the browser code, not the boundary.
There is no ACL fragment to spread. `listAdminPages` is role-**filtered**, so a page you may
not open is simply absent, and asking for it answers exactly as an unknown slug does.

The whole page comes back on every interaction; there is no patch protocol, because a server
returning only what changed has to agree with the host about what is currently on screen.

### An external data source

The first thing to reach for is **not** a custom page. Mirror the source into a pramen entity
with a sync task (`ctx.tasks` + a Cron drain) and declare a normal `collection()` over it:

```ts
const products = collection("products", {
  entity: "products", label: "Product", list: ["name", "sku", "syncedAt"],
  fields: [{ name: "name", type: "text" }, { name: "sku", type: "text" }],
});
```

Filtering (`contains` / `startsWith`), ordering, pagination, row and cell ACL, revisions, and
linking to CMS content through `manyToMany` all come for free, because it is a real table.
The external API becomes a *sync source* rather than a live one. Reach for `adminPage()` when
the screen itself is the unusual part — a workflow, a reconciliation view, an action that is
not "edit a row".

> **Non-goal: virtual collections.** It is tempting to let a collection's list/get dispatch to
> a handler instead of a table. `collection()` promises ACL through `ctx.db`, row scope,
> cell-level projection and `where` traversal — *all of which follow from it being a real
> table*. A handler-backed collection would void every one of those while keeping the name,
> leaving one word for two things with different security properties. `adminPage()` promises
> none of them and says so by having a different name.

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
