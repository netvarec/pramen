# @pramen/cms-editor

A **visual block/page editor** for [`@pramen/cms`](../cms) — a standalone React SPA that
talks to the CMS handlers over HTTP. It mutates through the *semantic* handlers
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
- **Media library**, plus **Users** (admin-only: invite via magic link, roles, activate/delete)
  and **Settings** (self-service email/password) tabs.
- **Real URL routing** ([`@buzola/router`](https://www.npmjs.com/package/@buzola/router), file-based
  under `src/routes/`): every view is a deep-linkable URL (`/`, `/media`, `/users`, `/settings`,
  `/pages/:pageId?tab=seo`), the browser Back/Forward buttons work, and a refresh restores the
  current view. Routing state lives in the URL; block selection stays local (a transient overlay).

## Run it

```bash
bun run --cwd packages/cms-editor build    # → dist/ (index.html + hashed JS)
bun run --cwd packages/cms-editor dev      # watch + preview on http://localhost:5175
```

It's a **standalone static SPA** (no server-package dependency — local types + `fetch`).
Deploy `dist/` anywhere; it talks cross-origin to your Worker, so set `CORS_ORIGINS` to allow
the editor's origin. On first load, paste your Worker base URL, tenant, and an
**editor/reviewer JWT**. (Co-hosting on the Worker via an `assets` binding is a possible
follow-up.)

**SPA fallback (required).** Because views are real URLs, the host must serve `index.html`
for any unmatched, extensionless path (deep link or refresh) and serve hashed assets from
the root. The dev preview server already does this; on a static host configure a catch-all
rewrite to `/index.html` (Cloudflare Pages/`assets` handle this by default). The bundle is
referenced by an **absolute** path (`/main.<hash>.js`), so it loads correctly from any route
depth — don't rewrite it to a relative path.

## Configure it (`/config.js`)

`dist/config.js` is loaded before the app boots and sets `window.PRAMEN_CMS_EDITOR`. Override
that one file on your host — no rebuild, no fork. Every field is optional, and the shipped
file has them all commented out; **add them one at a time**:

```js
window.PRAMEN_CMS_EDITOR = {
  brand: { name: "Acme", suffix: "cms" },            // the wordmark — see below
  // signInUrl: "/signin/",                          // ONLY once that page exists — see the warning
  // hidePages: true,                                // collections-only deployments
  // extraNav: [{ label: "Curation", href: "/curate" }],
};
```

> **`signInUrl` must be a page that exists, and same-origin needs care.** An unauthenticated
> load calls it after clearing the stored session, so if the path 404s into this SPA's own
> catch-all (which a same-origin extensionless path does — see the SPA-fallback note above),
> the editor bounces between the redirect and itself with no session to recover from. Point
> it at a page you have already deployed, and prefer a separate origin.

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

The `<title>` in `index.html` is baked at build time, before any config exists, so the app
re-applies the configured brand on boot; the static tag is the pre-hydration fallback, which
means the default shows for the moment before the bundle runs.

A clean build regenerates `config.js` when it is missing, but never overwrites one that is
already there — including on every `dev` rebuild — so an edit you are previewing survives.

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
