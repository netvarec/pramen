# @pramen/cms-astro

Consume a [`@pramen/cms`](../cms) backend from an **Astro** site. Self-contained (no
`@pramen/server` dependency — it speaks the CMS's public HTTP content API).

## The front door: `pramenCms()`

One integration, and the collections come from the store:

```ts
// astro.config.mjs
import { defineConfig } from "astro/config";
import pramenCms from "@pramen/cms-astro";

export default defineConfig({
  integrations: [pramenCms({ backend: { url: "https://cms.example.workers.dev" } })],
});
```

```ts
// src/content.config.ts — once, and never again
export { collections } from "pramen:cms";
```

That is the whole wiring. `collections: "auto"` (the default) asks the CMS which content
types exist and generates one collection per type, named after its slug — so adding a
content type in the editor takes effect on the next build with no code change. Pass a map
when you want your own names or a subset: `collections: { clanky: "article" }`.

The `pramen:cms` virtual module also exports the **configured client** and a bound
**`resolve()`**, so a component that needs a media URL imports it instead of
re-instantiating the client with a duplicated base URL:

```astro
---
import { client, resolve } from "pramen:cms";
const page = await client.getPage("o-nas");
---
<img src={resolve(page.page.fields.hero.url)} alt="" />
```

Types for that module are injected automatically (`pramen-cms.d.ts`), so there is no
hand-written `d.ts` to keep in step.

**Why the one-line re-export?** Astro has no API for an integration to define content
collections — `astro:config:setup` offers routes, scripts, middleware, renderers and Vite
config, and nothing for the content layer. Collections must be exported from
`src/content.config.ts`. So the integration generates them and you re-export once, instead
of hand-writing a `defineCollection` per type that has to track rows in the store.

**`"auto"` fails the build if it cannot reach the CMS**, rather than generating nothing.
Zero collections would otherwise build green and deploy an empty site. Discovery reads
`listPublicContentTypes`, which is un-gated — no build-time token needed, and nothing new is
exposed (a content type's slug already reaches the public through `listPublishedPages`). If
your deployment does need auth for reads, pass `backend: { token }`.

`createCmsClient` / `cmsLoader` stay exported and are documented below — the integration is
the front door, not a replacement. A site that wants to define its own collections by hand
still can.

## Serving the editor: `admin`

Add `admin: true` and this site also serves the [visual editor](../cms-editor), at
`/__admin`:

```ts
integrations: [pramenCms({ backend: { url: "https://cms.example.workers.dev" }, admin: true })],
```

That injects **one catch-all Astro route**, so the editor is part of this site rather than
something deployed beside it. What that buys, in order of how much time each used to cost:

- **No `dist/` to deploy and no asset paths to get right.** The editor's `editor.js` /
  `editor.css` are imported by the injected route and go through this site's bundler, which
  emits and fingerprints them. A copied-in `index.html` could only ever reference them
  root-absolute, so it worked at the origin root and nowhere else.
- **No SPA-fallback rewrite.** `/__admin/pages/:id` is a real server route: a deep
  link or a refresh is served like any other page.
- **No second hostname for the editor** — it is a route on this site, not a separate
  deploy pointed at a separate domain.
- **CORS only if the CMS is elsewhere.** Serving the editor here does not move the API: it
  still calls `backend.url`, so a CMS on its own Worker is still cross-origin and still
  needs `CORS_ORIGINS` to allow this site. Co-deploy the CMS into this site's Worker (the
  D1 store needs no `export`, so it can live in an Astro Worker) and `backend.url` becomes
  same-origin — then there is genuinely no CORS.
- **Nothing to point it at.** The shell tells the editor which Worker and tenant to call, so
  the first screen asks for an editor/reviewer JWT and nothing else.

The mount path is a constant, not an option: the same value is the injected route pattern
*and* the prefix handed to the editor's router, so the two cannot drift into a router
mounted where the server does not serve. `__admin` is a reserved namespace — every ordinary
path stays yours.

It deliberately does **not** name the framework. This is a URL an editor bookmarks and reads
out loud, so `pramen` has no more business in it than it has in the wordmark (which is what
`brand` is for). `__` is the settled "the framework serves this" marker — `/_next`,
`/_nuxt`, `/_astro`, `/__scheduled` — and it is not a dot-segment, which dotfile protection
in common static hosts, CDNs and proxies would 404 outright.

Pass an object instead of `true` to configure the editor itself (this replaces its old
`/config.js`, and is typed):

```ts
pramenCms({
  backend: { url: "https://cms.example.workers.dev", tenant: "acme" },
  admin: {
    brand: { name: "Acme", suffix: "cms" },   // the wordmark; `suffix: null` drops the second half
    signInUrl: "/signin/",                     // must be a page that EXISTS
    hidePages: true,                           // collections-only deployments
    extraNav: [{ label: "Curation", href: "/curate", target: "_self" }],
    previewUrl: "/preview",                    // YOUR page that renders a draft
  },
})
```

### `previewUrl` — where a preview link opens

The editor's **Preview link** button mints a signed, self-expiring token for the page. The
CMS Worker will happily redeem it — and answer with **JSON**, because a headless CMS has the
draft and no idea what it should look like. That is right for a machine and useless for the
person a preview link is for: a stakeholder with no account, who opens a wall of braces.

Point `previewUrl` at a route of your own and the editor appends `?token=…` to it instead.
The route redeems the token with `client.getPreview(token)` and renders the draft **through
the same components the published page uses** — a preview drawn by a second copy of the
layout is a preview of the copy. `example/site/src/pages/preview.astro` is a complete one,
banner and `noindex` included.

This is the same seam as `menuHref` and the sitemap's `pageUrl`: the CMS cannot know how a
deployment routes, so the deployment says. Leave it unset and nothing changes — the link
still points at the CMS's own endpoint. **Pages only**: a collection row has no canonical
URL, so `signCollectionPreview` keeps returning the backend's JSON.

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

`@pramen/cms-editor` is an **optional** peer dependency: install it only if you use `admin`.
Omit the option and no route is injected and nothing is added to the site.

A working site is in [`example/site`](../../example/site) — content collections and the admin
route, wired in one `pramenCms()` call. It doubles as this package's end-to-end test
(`test/astro-site.test.ts`).

> `signInUrl` must be a page that already exists. An unauthenticated load calls it *after*
> clearing the stored session, so a path that lands back inside the editor is a loop with
> nothing to recover from. `?setup=1` always forces the built-in screen.

## The kit of parts

- **`createCmsClient({ baseUrl })`** — `getPage(slug, locale?)`, `listPublishedPages()`, and
  `getPreview(token)` to redeem a signed preview link (no session needed — the signature is
  the authorization; the result carries `isPreview: true`).
- **`cmsLoader({ client })`** — an Astro **content-collection loader**. Wire it into a
  collection and the CMS's published pages become available via `getCollection()` /
  `getEntry()`, rendered to static HTML at build time (re-run the build — a publish webhook —
  to refresh). Works with `output: 'static'`; no SSR required.
- **`BlockRenderer.astro`** — render a page's blocks with your own `.astro` components.
- **`RichText.astro`** — render a `richtext` field. The value is a document tree, not an
  HTML string, so it walks into real elements — nothing on this path uses `set:html`.

```ts
// src/content.config.ts
import { defineCollection } from "astro:content";
import { createCmsClient, cmsLoader } from "@pramen/cms-astro";

const client = createCmsClient({ baseUrl: import.meta.env.CMS_URL });
export const collections = {
  clanky: defineCollection({ loader: cmsLoader({ client, locale: "cs" }) }),
};
```

```astro
---
// src/pages/clanky/[slug].astro
import { getCollection, getEntry } from "astro:content";
import BlockRenderer from "@pramen/cms-astro/BlockRenderer.astro";
import RichText from "../../components/blocks/RichText.astro";
import ImageBlock from "../../components/blocks/ImageBlock.astro";

export async function getStaticPaths() {
  const pages = await getCollection("clanky");
  return pages.map((p) => ({ params: { slug: p.id }, props: { page: p.data } }));
}
const { page } = Astro.props;
const components = { rich_text: RichText, image: ImageBlock };
---
<h1>{page.title}</h1>
<BlockRenderer blocks={page.blocks} {components} />
```

A block component renders its own fields; a `richtext` one hands the tree to `RichText`:

```astro
---
// src/components/blocks/RichText.astro
import RichText from "@pramen/cms-astro/RichText.astro";
const { fields } = Astro.props;
---
<RichText value={fields.body} />
```

The `cmsLoader`'s default entry `data` flattens the page's own `fields` to the top level and
adds `title / slug / locale / seo / regions / blocks` (blocks in document order). Pass
`transform` to shape it differently, or a Zod `schema` on the collection to validate it.

Media `"media"` fields arrive already resolved to `{ url, alt, ... }`; use `client.resolve()`
(or Cloudflare Image Resizing) to turn a relative `/media/...` url into an absolute one.
