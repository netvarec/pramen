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
bun --cwd packages/cms-editor run build    # → dist/ (index.html + hashed JS)
bun --cwd packages/cms-editor run dev      # watch + preview on http://localhost:5175
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
