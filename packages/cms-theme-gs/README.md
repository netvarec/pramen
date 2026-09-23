# @pramen/cms-theme-gs

The Graphic Standard (GS) look for the `@pramen/cms-editor` admin. It is a theme built on the
editor's public seams only:

- **Slot components** for `buildEditor({ slots })`, typed against `@pramen/cms-editor/slots`
  and built from `@podoba/react`'s GS product patterns:
  | slot | what it renders |
  |---|---|
  | `pageHeader` | `BrandPageHeader` with the screen's name over its state, and the editor's own action inside a mint `CtaPill` ("Pojďme vytvořit něco nového"). On Media the pill opens an upload hub. |
  | `home` | The GS dashboard: a greeting whose CTA opens a create hub of every section the session can open, and a `DashboardGrid` of `Tile`s with live counts. |
  | `detailHeader` | GS's "title to go back": the parent list as a soft link above the record's title. |
  | `mediaDetail` | GS's asset preview modal: the file on a muted stage, facts and actions in a 300px column. |
  | `mediaGrid` | `AssetMasonryGrid` of `AssetLibraryPreview` cards, and `AssetSelectionEmpty` for an empty library. |
  | `nav` | Schema editor and account settings out of the bar ("Content structure" goes to the account menu), Users promoted into the first group, empty groups dropped. |
- **A stylesheet** (`@pramen/cms-theme-gs/theme.css`) your own Tailwind entry imports.
- **A build helper** (`gsEditor()`) that returns the theme's `buildEditor` options, and the
  **recommended shell settings** (`gsAdmin`) for `pramenCms({ admin })`.

All of its copy goes through the editor's i18n (`@pramen/cms-editor/i18n`): English and Czech
ship, and it follows the deployment's `locale`. Words the editor already has (a screen's name,
counts, "Close") come from the editor's catalog, so a `messages` override reaches them too.

Published in lockstep with the other `@pramen/*` packages; use the same version as
`@pramen/cms-editor`.

## Install

```bash
bun add @pramen/cms-theme-gs @podoba/react@0.0.42 @podoba/tailwind@0.0.42 @podoba/tokens@0.0.42 react react-dom
```

Peer dependencies: `@pramen/cms-editor` (the same version), `@podoba/react` 0.0.42 or newer
(`BrandPageHeader`, `CtaPill`, `DashboardGrid`, `DashboardTile`, `Tile`, `AssetMasonryGrid`,
`AssetLibraryPreview`, `AssetSelectionEmpty`, `ModalOverlay`), and React 19. Your project is the
editor's `designSystem`: the editor and the theme link your podoba and your React, one copy of
each, whatever `@pramen/cms-editor` pins for its prebuilt bundle.

## Wire it

Three files in your project. Nothing in them is GS-specific beyond the imports.

**1. The build script**, run before your site's build (for example as `build:admin`):

```ts
// scripts/build-editor.ts
import { buildEditor } from "@pramen/cms-editor/build";
import { gsEditor } from "@pramen/cms-theme-gs/build";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

await buildEditor({
  outdir: resolve(root, "public/admin"),
  designSystem: root, // your podoba and React
  ...gsEditor({
    styles: resolve(root, "src/admin/editor.css"),
    // Optional: your own module for any slot, usually one that wraps the theme's (see below).
    // `false` gives a slot back to the editor's default.
    slots: { nav: resolve(root, "src/admin/nav.ts") },
  }),
});
```

`gsEditor({ styles, slots })` returns `{ styles, slots }` with every slot filled by the theme's
module unless you named your own. It throws if `styles` does not import the theme's CSS, since
the slots would otherwise build and render unstyled.

**2. The stylesheet**, in YOUR tree. Tailwind resolves `@import` and `@source` from the
directory of the file that wrote them, so this is the only place your podoba can reach the
editor's CSS (see `buildEditor`'s `styles` option):

```css
/* src/admin/editor.css */
@import "@pramen/cms-editor/app.css";      /* the editor's base rules and layout variables */
@import "@podoba/tokens/variables.css";    /* your podoba's tokens, over the editor's */
@import "@podoba/tailwind";                 /* your podoba's utilities */
@import "@pramen/cms-theme-gs/theme.css";   /* the theme; it scans its own source */
@source "../../node_modules/@podoba/react/src";  /* your podoba's class strings */

/* GT America: see "Fonts" below. */
```

**3. The shell config**, next to the rest of your `pramenCms()` options:

```js
// astro.config.mjs
import pramenCms from "@pramen/cms-astro";
import { gsAdmin } from "@pramen/cms-theme-gs/config";

pramenCms({
  backend,
  admin: {
    ...gsAdmin,               // layout: "topbar", hideControls: [mediaSearch, mediaFilters, relationSearch]
    editorAssets: "/admin",   // where the build script wrote the editor
    locale: "cs",
    brand: { name: "Graphic Standard" },
  },
});
```

`gsAdmin` is the topbar (GS's AppShell) and no search or filter controls over the media grid or
the relation picker, which is what GS's asset library looks like. Hiding a control never narrows
a list. Put your own `hideControls` after the spread to keep any of them. The "Content
structure" account-menu row is not in `gsAdmin`: it comes with the `nav` slot, because it
replaces the nav entry that slot hides.

The layout needs no configuration: the editor's `--pramen-*` variables already default to the GS
AppShell's proportions (full-width content, 24px gutters, 48px under the 77px bar), and the
theme's headers read the same variables.

### Content-type labels

The page header says what the editor passes it, in the editor's language. For "+ Nový článek"
and "3 články" rather than the neutral "+ Nový obsah" and "3 záznamy", declare the words with
the content type (`@pramen/cms`):

```ts
defineContentType("article", {
  name: "Články",
  labels: { newItem: "Nový článek", count: { one: "článek", few: "články", many: "článku", other: "článků" } },
  // ...
});
```

The dashboard's tiles use the same `count` nouns.

## Fonts

GS sets everything in **GT America** (400 and 500) and **GT America Mono** (400). GT America is
a commercial typeface and this package is public, so it ships **no font files and no
`@font-face`**. The theme's CSS only names the face (through podoba's `--font-sans`, which lists
GT America first, with a system sans fallback). A deployment licensed to use it declares it in
its own `editor.css`, from files it serves itself:

```css
@font-face {
  font-family: "GT America";
  src: url("/fonts/gs/GT-America-Regular.woff2") format("woff2");
  font-weight: 400;
  font-display: swap;
}
@font-face {
  font-family: "GT America";
  src: url("/fonts/gs/GTAmerica-Medium.woff2") format("woff2");
  font-weight: 500;
  font-display: swap;
}
@font-face {
  font-family: "GT America Mono";
  src: url("/fonts/gs/GTAmericaMono-Regular.ttf") format("truetype");
  font-weight: 400;
  font-display: swap;
}
```

Without it the admin renders in the system sans, which is the right failure: legible, and
obviously not the brand face.

## Extend it without forking it

A slot takes one module, so a project with rules of its own writes that module and builds on
the theme's pieces, then names it in `gsEditor({ slots })`.

### Nav: `@pramen/cms-theme-gs/nav`

- `gsTransformNav(context)`: the GS rules, as a `transformNav` step.
- `composeNav(...steps)`: run steps in order, each seeing the previous one's sections and lit key.
- `gsAccountMenu()`: the "Content structure" row. `gsNavHooks`: both, as the theme ships them.
- `GS_HIDDEN_NAV_KEYS`: `["types", "settings"]`.

A project step runs before or after the GS one. For example, a custom events panel that
replaces the events content type in the bar and stays lit on the type's screens:

```ts
// src/admin/nav.ts
import type { NavHooks } from "@pramen/cms-editor/slots";
import { composeNav, gsNavHooks, gsTransformNav, type NavStep } from "@pramen/cms-theme-gs/nav";

const events: NavStep = ({ sections, active }) => {
  if (!sections.some((s) => s.entries.some((e) => e.key === "app:events"))) return { sections, active };
  return {
    sections: sections.map((s) => ({
      ...s,
      entries: s.entries
        .filter((e) => e.key !== "type:events")
        .map((e) => (e.kind === "route" && e.key === "app:events" ? { ...e, label: "Events" } : e)),
    })),
    active: active === "type:events" ? "app:events" : active,
  };
};

export const navHooks: NavHooks = { ...gsNavHooks, transformNav: composeNav(events, gsTransformNav) };
```

Keep steps pure and return new objects: the editor checks `requiresNav` against the nav it
built, before any step, and runs the transform on every render.

### Dashboard: `@pramen/cms-theme-gs/home` and `/dashboard-data`

`createHomeScreen({ title, sections })` builds the `HomeScreen` export a `home` slot module
needs. `title` is the greeting's second line (the theme's "Správa obsahu" / "Content
administration" by default). `sections(defaults, props)` gets the default sections (content
types, collections, media, custom panels, each keyed like its nav entry: `type:<slug>`,
`col:<slug>`, `media`, `app:<slug>`) and returns the ones to show. A section with a `stat`
loader shows a live count; one without shows its description.

```tsx
// src/admin/home.tsx
import { createHomeScreen } from "@pramen/cms-theme-gs/home";
import { loadContentTypeStat, type DashboardStat } from "@pramen/cms-theme-gs/dashboard-data";

export const HomeScreen = createHomeScreen({
  title: "Praha sportovní",
  sections: (sections, { adminPages }) => {
    const panel = adminPages.some((p) => p.slug === "events");
    return sections
      .filter((s) => !(panel && s.key === "type:events"))
      .map((s) => (s.key === "app:events" ? { ...s, label: "Events", stat: (api) => loadContentTypeStat(api, "events") } : s));
  },
});
```

`@pramen/cms-theme-gs/dashboard-data` exports the loaders the defaults use
(`loadContentTypeStat`, `loadCollectionStat`, `loadMediaStat`), `allPages` (read a paged RPC
list to the end) and `statusStat` (a row count with its published/draft split, worded in the
editor's language), so a project's own stat reads like the built-in ones. A loader returns a
`DashboardStat`: `{ value, label, detail }`, where `label` is the words after the number.

### Your own panels

A custom panel that uses podoba's `BrandPageHeader` can add the class `gs-panel-hero` to it to
get the theme's phone and tablet CTA behaviour (and the bottom room for the docked CTA).

## Pending on podoba#37

[graphic-standard/podoba#37](https://github.com/graphic-standard/podoba/pull/37) (not released
yet) makes `@podoba/tokens` match GS's token values and moves two of the theme's workarounds into
podoba. The theme does not depend on it; this is what changes once it ships:

- **Tokens.** Until then `@podoba/tokens` 0.0.42 is podoba's own palette, not GS's (for example
  `--color-danger` and the tracking scale differ, and in dark mode a `Tile` sits on the same
  colour as the page). A host that needs exact GS values now may add its own overrides after
  `@podoba/tokens/variables.css` in `editor.css`. The theme deliberately ships no token
  snapshot: a copy here would be a second source that drifts.
- **Tracking.** `theme.css` sets `letter-spacing: normal` on `body` because 0.0.42's tracking is
  tuned for NC Fontina. After #37 the scale follows the face; drop the line.
- **CTA dock breakpoint.** 0.0.42 docks a header's CTA to the bottom of the screen below 768px;
  `theme.css` keeps it inline from 640px up. After #37 `BrandPageHeader` does that itself; delete
  the `@media (min-width: 640px) and (max-width: 767px)` block.
- **Room for the dock.** `theme.css` pads the page by a measured 100px on phones. After #37,
  replace it with `body:has([data-mobile-cta-dock]) { @apply mobile-cta-dock-inset; }`.

Each of these is marked `TODO(podoba#37)` in `src/theme.css`. When the theme moves to the podoba
release with #37, raise the `@podoba/react` peer range with it.

## Development

The package is TypeScript source, bundled into the host's editor by `buildEditor`; there is no
build step of its own. In this repo:

- `bun run typecheck` checks it (`tsconfig.json` for the slots, `tsconfig.build.json` for
  `gsEditor`), against podoba 0.0.42 from its own devDependencies. The editor itself stays on the
  podoba it pins.
- `test/cms-theme-gs.test.tsx` covers the copy, the nav rules and their composition, the
  dashboard statistics and the components' markup. `test/cms-theme-gs-host-build.test.ts` runs a
  real `buildEditor` with every theme slot against podoba 0.0.42 and checks the bundle and the
  stylesheet.
- `example/site` builds a themed editor with `bun run --cwd example/site build:admin-gs` and
  serves it with `PRAMEN_ADMIN_THEME=gs bun run --cwd example/site dev` (its `admin-gs/` folder
  is a complete host wiring, including a composed `nav` and `home`).
