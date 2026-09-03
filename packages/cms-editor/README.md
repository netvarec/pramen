# @pramen/cms-editor

A **visual block/page editor** for [`@pramen/cms`](../cms) — a React SPA that talks to the
CMS handlers over HTTP, served by your own site (see [Deploy it](#deploy-it)). It mutates through the *semantic* handlers
(`addBlock`/`updateBlock`/`reorderRegion`/`publishPage`/…), so field validation, region
allow-lists, and the review/publish gates are all enforced server-side.

## What it does

- **Page list** + create (pick a content type).
- **Region canvas:** each region (from the content type) lists its blocks; a palette adds
  blocks, filtered by the region's `allowedTypes`. Reorder (↑/↓) and remove.
- **Schema-driven field forms:** one input per `FieldDefinition` type —
  text/textarea/richtext/url/number/boolean/**select**/**media** (with an upload+pick media
  picker)/**repeater**/**group** (recursively composed). Draft blocks may be incomplete;
  required fields are enforced at publish, not while editing.
- **Inspector tabs:** Settings, **SEO** (meta/canonical/robots/OG), **Workflow**
  (submit → review → approve/reject/publish, role-gated), **i18n** (translations), **Audit** trail.
- **Types** (`/schema`): authors the block types and content types everything above is built
  from — the inverse of the field form, editing a `FieldDefinition[]` and a content type's
  regions/page fields/default blocks. A type declared in code (`defineBlockType` /
  `defineContentType`, reconciled by `cmsBootstrap`) is marked `code` and shown **read-only**:
  the server owns that row and would revert an edit at the next boot.
- **Collections** (your own pramen entities, edited with the same field DSL), **site
  furniture** (menus, redirects, taxonomies, widget areas) and **custom admin pages** (Block
  Kit) — each discovered at runtime, so there is one generic editor and no per-project code.
- **Media library**, plus **Users** (admin-only: invite via magic link, roles, activate/delete)
  and **Settings** (self-service email/password) tabs.
- **Real URL routing** ([`@buzola/router`](https://www.npmjs.com/package/@buzola/router), file-based
  under `src/routes/`): every view is a deep-linkable URL (`/`, `/media`, `/users`, `/settings`,
  `/pages/:pageId?tab=seo`), the browser Back/Forward buttons work, and a refresh restores the
  current view. Routing state lives in the URL; block selection stays local (a transient overlay).

## Run it

```bash
bun run --cwd packages/cms-editor build    # -> dist/editor.js + dist/editor.css
bun run --cwd packages/cms-editor dev      # watch + preview on http://localhost:5175
```

The build produces exactly **two files** and no `index.html`. That is deliberate: a baked
shell can only hard-code root-absolute asset paths, which works at the origin root and
nowhere else, and its companion `config.js` was a hand-edited untyped global that failed
silently the moment it 404'd.

## Deploy it

A **host serves it**, from a shell it renders. For an Astro site that is one line — see
[`@pramen/cms-astro`](../cms-astro):

```js
// astro.config.mjs
pramenCms({ backend: { url: "https://cms.example.workers.dev" }, admin: true })
```

That injects a catch-all route at `/_pramen/admin`, so every view is a real server route on
the site's own origin: no `dist/` to copy, no SPA-fallback rewrite, and no second hostname
for the editor. The site's bundler emits and fingerprints `editor.js` / `editor.css` like
any other asset, which is what makes serving it under a prefix work.

It does not move the API, though. The editor still calls the CMS at the `backend.url` the
shell declares, so a CMS on its own Worker is still cross-origin and still needs
`CORS_ORIGINS` to allow the site. CORS goes away only when the CMS shares the site's
origin.

Everything the bundle needs at boot comes from that shell, and nothing else:

| What | How the shell provides it | Read by |
| --- | --- | --- |
| Where it is mounted | `data-base-path` on the mount node | `src/mount.ts` |
| Which Worker + tenant to call | `window.PRAMEN_CMS_EDITOR.backend` | `src/mount.ts` |
| Wordmark, sign-in URL, nav | the rest of `window.PRAMEN_CMS_EDITOR` | `src/brand.ts`, `src/app-context.tsx` |

The mount prefix is the constant the route was injected at, stamped onto the node by the
same code that injected it — so the router cannot be mounted somewhere the server does not
serve. Navigation is scoped to it, so a co-hosted editor intercepts only its own URLs
(`_404.tsx`'s catch-all matches every same-origin path, which un-scoped would mean a click
on the host's own `/blog` rendering the editor's "Nothing lives here").

**To write your own shell** (a Worker route, another framework), render: the stylesheet, a
`<div id="app" data-base-path="…">`, an inline script setting `window.PRAMEN_CMS_EDITOR`,
and `<script type="module" src="…editor.js">` — in that order. The dev preview in
`scripts/build.ts` is the smallest complete example.

## Configure it

The editor's own options travel in `window.PRAMEN_CMS_EDITOR`, which the integration writes
from typed options (`admin: { … }`) — there is no file to edit:

```js
admin: {
  brand: { name: "Acme", suffix: "cms" },            // the wordmark — see below
  // signInUrl: "/signin/",                          // ONLY once that page exists — see the warning
  // hidePages: true,                                // collections-only deployments
  // extraNav: [{ label: "Curation", href: "/curate", target: "_self" }],
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

> **`signInUrl` must be a page that exists.** An unauthenticated load calls it after
> clearing the stored session, so a path that 404s into this SPA's own catch-all leaves the
> editor bouncing between the redirect and itself with no session to recover from. Point it
> at a page you have already deployed. `?setup=1` always forces the built-in screen, for
> pasting a first-admin JWT.

**Set `brand` when you deploy this for a client.** The editor ships as a package an agency
installs on someone else's behalf, so the default wordmark — `pramen · cms editor`, in the
topbar, on the Setup screen and in the browser tab — puts the framework's name where the
client's belongs. `name` replaces it; `suffix: null` drops the `· cms` half entirely. A
configured brand replaces the whole string, including the word "editor", so nothing English
is appended to a client's name. Configure nothing and every surface renders exactly as it
did before this option existed.

A malformed `brand` can never take the editor down: a non-string value is ignored rather
than thrown on, and a `brand` that yields no usable name logs a console warning instead of
silently shipping "pramen" to your client.

The shell's `<title>` is written before the bundle runs, so the app re-applies the
configured brand on boot; the server-rendered tag is the pre-hydration fallback.

Settings → About still reports `pramen · cms-editor`. That row names the *software* you are
running, not the deployment, which is what an About panel is for.

Routes are file-based: `src/routes/*` is scanned by the Bun plugin at build time, which
(re)generates the checked-in `src/buzola.gen.ts`. After adding or renaming a route, run
`bun run codegen` (the build does it automatically) so tsc sees the new route.

## Status

Verified end-to-end against a live example server (connect → create/open a page → add blocks
in regions → edit fields → save → publish; confirmed the round-trip through the content API).
Not yet browser-QA'd against a real production project — that's the integration phase. Rough
edges: no HTML5 drag-and-drop yet (reorder is ↑/↓ buttons), no rendered live-preview pane (the
canvas is structural; a rendered preview needs the project's block components), and title/slug
editing needs a future `updatePage` handler.
