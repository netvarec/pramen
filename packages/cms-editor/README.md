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

That injects a catch-all route at `/__admin`, so every view is a real server route on
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
and `<script type="module" src="…editor.js">` — in that order. If the deployment has panels,
add a `<script type="importmap">` ahead of every module script mapping `react`, `react-dom`,
`react/jsx-runtime` and `react/jsx-dev-runtime` at `dist/panel-*.js`. The dev preview in
`scripts/build.ts` is the smallest complete example.

## Configure it

The editor's own options travel in `window.PRAMEN_CMS_EDITOR`, which the integration writes
from typed options (`admin: { … }`) — there is no file to edit:

```js
admin: {
  brand: { name: "Acme", suffix: "cms" },            // the wordmark — see below
  // signInUrl: "/signin/",                          // ONLY once that page exists — see the warning
  // hidePages: true,                                // collections-only deployments
  // layout: "topbar",                               // horizontal nav instead of the sidebar — see below
  // pageHeader: { variant: "flat", accent: "#73e2b2" },  // dress the screen header — see below
  // extraNav: [{ label: "Curation", href: "/curate", target: "_self" }],
  // panels: ["/admin/curation.js"],                 // your own React screens — see below
}
```

### `layout` — which chrome the nav wears

Two shapes for the same nav, and the same screens under either.

- **`"sidebar"`** (default) — a left rail: an icon and a label per row, collapsible group
  headings, a toggle that narrows it to icons. What a dozen-plus destinations needs.
- **`"topbar"`** — the **Graphic Standard** bar (podoba's `Topbar`): brand left, tabs right,
  the account avatar at the end, a hairline under it. For an editor embedded in a product
  that already wears that bar, or a nav that fits a row.

The bar does not revive the horizontal scroller the rail replaced: the **first** nav group
renders as flat tabs and each later group folds into a dropdown
(`Pages · Lectures · Media · Site ⌄ · Apps ⌄ · System ⌄` + the avatar). Below `md` the whole
nav moves into a dialog behind a hamburger. The breadcrumb keeps only its detail half, beside
the wordmark — the lit tab already names the section.

`chrome.ts` owns the choice (`CHROME_LAYOUT`) and the two numbers that follow from it — the
chrome's height and the air under it — as CSS custom properties, because every sticky header
in the editor (`page-header.tsx`, the page editor's toolbar and inspector) is positioned
against them. `chrome-sidebar.tsx` and `chrome-topbar.tsx` are the two components;
`routes/_layout.tsx` derives the nav and hands either one the same `ChromeProps`.

### `pageHeader` — dressing the screen header

The sticky panel with the `<h1>` and the primary action, on the editor's own screens. Three
tokens, no DOM:

```js
pageHeader: {
  variant: "flat",          // "cover" (default) | "flat" | "bare"
  accent: "#73e2b2",        // the colour the primary action wears
  titleFont: "Inter, system-ui, sans-serif",   // the <h1>, and only the <h1>
}
```

- **`variant`** — `"cover"` is the seeded Truchet artwork every screen gets by default;
  `"flat"` keeps the panel and drops the art; `"bare"` drops the panel too, so the title and
  action sit on the page the way a Graphic Standard section header does. The header still
  sticks and still condenses on scroll in all three.
- **`accent`** — re-points `--color-brand-primary` **inside the header only**, so the primary
  action wears it and nothing else in the app moves. It must be an **opaque hex or `rgb()`
  literal** — not `var()`, `oklch()` or a colour with alpha — because the editor parses it to
  derive two things the host therefore cannot get wrong: the label colour on it (the better of
  podoba's ink and paper by WCAG contrast) and the hover shade (a dark accent lightens, a
  light one darkens). An accent no label reads on is still applied, with a console warning
  naming the ratio.
- **`titleFont`** — a `font-family` list for the `<h1>`. The counts, labels and controls around
  it are the editor's chrome and stay in the design system's type. The editor loads no fonts of
  its own beyond podoba's, so the family has to be one the browser already has — your shell
  loads it.

Anything unusable is warned about and falls back to the shipped default; nothing here throws.
`page-header-style.ts` owns the resolution and the colour maths, `page-header.tsx` renders it.

**This replaces reaching into the editor's DOM from a stylesheet.** A selector like
`div.sticky[class*="max-w-[1200px]"] > div.relative.isolate … > div.relative.grid > :not(h1)`
pins itself to private structure that a release can change with no error anywhere — and it
cannot tell Media from a content type, or the panel from the button inside it, which is how a
rule meant for "the header's action" turns `+ Upload` into "New + Upload" and puts white text
on a mint fill at 1.58:1. If these tokens do not cover your case, open an issue rather than a
selector.

## Panels — your own React screen inside the chrome

A **panel** is a component you build and this editor renders, at `/apps/<slug>`, inside the
same sidebar, header and theme as everything else. It is for the screen Block Kit
(`adminPage()`) cannot describe — one that needs local interaction: a control that responds
as you type, a row that expands, a dialog, a redirect.

The entry is declared **server-side** with `adminPanel()` in `app.ts` (label, icon,
`navOrder`, `roles`), so the nav position and the role filter are the same server facts they
are for a Block Kit page — a panel you may not open is absent from the listing. This bundle
supplies only the component:

```tsx
import { useState } from "react";

function Curation({ api, basePath, theme, setError }) { /* ordinary React */ }

globalThis.PRAMEN_CMS_EDITOR_RUNTIME.registerPanel({
  slug: "curation",
  contract: 1,          // the panel runtime contract this bundle was BUILT against
  render: Curation,
});
```

`contract` is required and is a literal you write. Your bundle is compiled against your React
and linked against the editor's, and nothing in the loading path notices if those disagree —
so the editor asks which contract you built against and **refuses a mismatch**, naming the
slug and the fix on the panel's own route. It is not readable off the runtime on purpose:
that would be this editor checking its own number. `PANEL_RUNTIME_CONTRACT` in `src/panels.ts`
is the current value and the list of what bumps it.

Build it with **react, react-dom and both JSX runtimes external** — that is the whole
contract:

```
bun build src/admin/curation.tsx --outfile public/admin/curation.js --minify --target=browser \
  --external react --external react-dom --external react/jsx-runtime --external react/jsx-dev-runtime
```

The editor publishes its React on `globalThis.PRAMEN_CMS_EDITOR_RUNTIME` and the shell's
import map points those specifiers at `dist/panel-*.js`, which read it back out. Two copies of
React in one page share no hook dispatcher, so a bundled one throws on the panel's first hook.

A panel is handed `api` (`call`/`resolve`, as the signed-in user), `basePath` (the mount
prefix, so your links stay inside it), `theme`, and `setError` (the chrome's error banner) —
and nothing else. The full guide, including how the URLs are declared, is in
`docs/cms.md`.

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

**Each screen's header is a cover panel with generated artwork** (`src/cover.tsx`), derived
from the screen's name: a hash seeds a PRNG that lays out a Truchet arc field under a colour
wash drawn from a closed list of podoba accents. It exists because six list screens whose only
difference is a word at the top read as one screen you keep landing on — and being derived
means a new collection gets its own cover with nothing to author or upload. Seeded on the
title's stable half, so adding a file does not redraw the picture.

**Icons are [Phosphor](https://phosphoricons.com), regular weight**, in one place
(`src/icons.tsx`) and aliased to names that say what they mean in this app rather than what
they depict — so the family is a decision recorded in one file, and no call site names a
vendor. A collection or a Block Kit page can still supply its own (`icon: "🎓"`), which goes
into the rail's icon column verbatim; resolving such a string against Phosphor *by name* is
deliberately not offered, because a by-name lookup needs the whole 3000-icon registry in the
bundle to let a deployment name one glyph it can already pass directly.

**Set `brand` when you deploy this for a client.** The editor ships as a package an agency
installs on someone else's behalf, so the default wordmark — `pramen · cms editor`, at the head of the
sidebar, on the Setup screen and in the browser tab — puts the framework's name where the
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

## Build it against your own design system

The published `dist/editor.js` and `dist/editor.css` are self-contained: podoba's components
are compiled into the bundle and its tokens and web font into the stylesheet, at the versions
this package pins. That is what makes the drop-in mount work with no build config — and it
means a site whose own design system is podoba gets **our** generation of it, not its own.
No runtime option reaches inside a compiled bundle to change that.

So the same build is also an API:

```ts
// build-admin.ts — run with bun
import { buildEditor } from "@pramen/cms-editor/build";

await buildEditor({
  outdir: "public/admin",
  // Link podoba and React out of THIS project, so the editor moves when your design system does.
  designSystem: import.meta.dir,
  // The other half: CSS is compiled, not linked, so your tokens can only arrive through a
  // stylesheet in your own tree. Tailwind resolves a bare `@import` from the file that wrote
  // it, which is why compiling ours from here would still pick up our podoba.
  styles: "src/admin/editor.css",
  // And, if you need your design system's own components rather than a recolour of ours
  // (see "Slots" below for the full list):
  slots: { pageHeader: "src/admin/page-header.tsx" },
});
```

```css
/* src/admin/editor.css */
@import "@pramen/cms-editor/app.css";  /* the editor's base rules */
@import "./tokens.css";                /* yours, after ours, so yours win */
```

Then point the mount at what you built, with the directory those six files are served from:

```js
// astro.config.mjs
pramenCms({ admin: { editorAssets: "/admin" } })
```

All six move together — `editor.js`, `editor.css` and the four `panel-*.js` shims — because a
shim re-exports the names of the React *that* bundle linked. Since this build never sees those
paths it cannot fingerprint them either, so cache-busting is yours: emit under a content-hashed
directory, or serve them with a short max-age.

**`designSystem` and `styles` are one decision, not two.** Setting only the first links your
podoba into the bundle while the stylesheet stays compiled against ours — the editor comes up
and the colours are subtly not yours. The build warns when it sees that combination.

### Slots: your components in place of ours

A slot replaces one of the editor's own modules with one of yours, at build time. Each has a
contract, published as a type from `@pramen/cms-editor/slots`, and the editor's own default is
declared against the same type, so a contract that changes is a compile error on both sides.

| Slot | What it is | Your module exports | Contract |
|---|---|---|---|
| `pageHeader` | the sticky header of a list screen | `PageHeader` | `PageHeaderProps` |
| `home` | the screen at `/` | `HomeScreen` | `HomeScreenProps` |
| `detailHeader` | the way back and the title on every detail screen (page editor, collection item, block and content type, menu, vocabulary, widget area) | `DetailHeader` | `DetailHeaderProps` |
| `mediaDetail` | the dialog frame around one media file | `MediaDetailFrame` | `MediaDetailFrameProps` |
| `mediaGrid` | the media library's grid and its empty state | `MediaGrid`, `MediaLibraryEmpty` | `MediaGridProps`, `MediaLibraryEmptyProps` |
| `nav` | hooks over the nav and the account menu, for both chromes | `navHooks` | `NavHooks` |

```ts
await buildEditor({
  outdir: "public/admin",
  designSystem: import.meta.dir,
  styles: "src/admin/editor.css",
  slots: {
    home: "src/admin/dashboard.tsx",
    detailHeader: "src/admin/detail-header.tsx",
    nav: "src/admin/nav.ts",
  },
});
```

```tsx
// src/admin/detail-header.tsx
import type { DetailHeaderProps } from "@pramen/cms-editor/slots";
import { BrandPageHeader } from "@podoba/react";

export function DetailHeader({ title, parent, href, onBack, children }: DetailHeaderProps) {
  return (
    <BrandPageHeader
      greeting={title}
      parentLink={<a href={href} onClick={(e) => { e.preventDefault(); onBack(); }}>{parent}</a>}
      cta={children}
    />
  );
}
```

```ts
// src/admin/nav.ts
import type { NavHooks } from "@pramen/cms-editor/slots";

export const navHooks: NavHooks = {
  // Rename, hide, reorder or regroup; move the highlight to match.
  transformNav: ({ sections, active }) => ({
    sections: sections.map((s) => ({ ...s, entries: s.entries.filter((e) => e.key !== "types") })),
    active,
  }),
  // Offer the schema editor from the account menu instead, to the same people.
  accountMenu: [{ label: "Content structure", page: "schema", icon: "types", requiresNav: "types" }],
};
```

**Your modules import only public things**: `@pramen/cms-editor/slots` for the types,
`@podoba/react` and React for the rest. Everything a slot needs from the running editor
(the API client, the mount prefix, the session's content types, a way to navigate, an
already-guarded way back) arrives as props. Do not import the editor's internals by relative
path: a second copy of the app context is a second React context, which throws on first render.

A few things the contracts decide for you, so a theme does not have to rediscover them:

- **`home` gets the landing decision, not a blank slate.** The route stays ours and hands your
  screen `landing` (where `/` would go: the first collection on a collections-only deployment,
  the first content type when split by type, or the pooled page list) with `goToLanding()` to
  act on it and `pageList` to render. On a deployment with one content type the nav's "Pages"
  entry points at `/`, so a dashboard that drops `pageList` makes the page list unreachable.
- **`detailHeader` owns the title everywhere, including the page editor.** The page editor's
  toolbar keeps only the page's status, the save state and the actions; the way back and the
  title are the detail header's. While the header is scrolled away, the chrome's breadcrumb
  names the page.
- **`mediaDetail` arranges, it does not implement.** It gets `preview`, `details` and `actions`
  as three elements, so preview-beside-details is a layout, not a copy of the save and delete
  logic.
- **`mediaGrid` is handed tiles, not media rows.** Each has `src` only when it is an image,
  a formatted `sizeLabel` and an `onOpen`. "No files match this filter" stays the editor's,
  since clearing the filter is the way out of it. podoba's `AssetMasonryGrid`,
  `AssetLibraryPreview` and `AssetSelectionEmpty` (podoba 0.0.35+) fit this slot; they are not
  the default because the stored media carry no dimensions for a masonry layout to use and the
  look is the Graphic Standard's rather than this editor's.
- **`nav` runs upstream of both chromes.** The sidebar, the topbar, the breadcrumb and the
  account menu all read the one transformed nav. `requiresNav` is checked against the nav as
  BUILT, so hiding an entry does not hide the account-menu row that replaces it. A
  `transformNav` that throws is logged and ignored rather than taking the admin down.

**Before reaching for a slot, check whether something cheaper already does the job:**

| You want | Use |
|---|---|
| the header recoloured, unpanelled, or in your own face | `admin: { pageHeader }`, runtime config, no build |
| the wordmark, the tab title, the nav shape | `admin: { brand }`, `admin: { layout }` |
| search or filters off | `admin: { hideControls }` |
| an extra row in the account menu | `admin: { accountMenu }` |
| a whole screen of your own | `adminPage()` or `adminPanel()`, no build either |
| your design system's own **component** in one of the places above | `slots` |

A slot that stops resolving is a **build error**, not a silent fallback: if a release moves the
module a slot names, `buildEditor` throws rather than quietly handing you ours back. So does a
slot name this release does not have, and a slot path that does not exist. That is the
difference between this and the alternative it replaces: a stylesheet or a bundler alias
written against our internals, which the next release voids with no error anywhere.

## Status

Verified end-to-end against a live example server (connect → create/open a page → add blocks
in regions → edit fields → save → publish; confirmed the round-trip through the content API).
Not yet browser-QA'd against a real production project — that's the integration phase. Rough
edges: no HTML5 drag-and-drop yet (reorder is ↑/↓ buttons), no rendered live-preview pane (the
canvas is structural; a rendered preview needs the project's block components), and title/slug
editing needs a future `updatePage` handler.
