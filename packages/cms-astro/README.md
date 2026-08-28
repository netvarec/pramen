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

## One Worker instead of two (`embed`)

By default the CMS is its own Cloudflare Worker and the site is another. It does not have to
be:

```ts
pramenCms({
  backend: { url: "https://my-site.example.com/_pramen" },
  embed: { app: "./src/cms/app.ts" },   // your pramen app
})
```

`astro build` then writes `dist/_pramen-entry.mjs` — a Worker entrypoint that imports the
adapter's own worker, re-exports the Durable Object beside it, and routes `/_pramen/*` to the
CMS and everything else to Astro. Point wrangler's `main` at it and deploy **one** Worker:
one URL, no CORS, no second deployment. The site's pages read the CMS on their own origin.

This needs nothing from the Cloudflare adapter: it writes `dist/_worker.js/index.js` as an
ordinary ES module with a default export, so the generated entrypoint just imports it.

Everything pramen serves moves under the prefix — `/rpc`, `/live`, `/files`, `/media`,
`/admin`, and your `app.routes` — so `/sitemap.xml`, `/robots.txt` and every page path stay
the site's. Change it with `embed.basePath`.

If there is no wrangler config, one is written with the bindings the topology needs (DO +
migration, KV, R2) and placeholders to fill in. **An existing config is never edited** — the
bindings it needs are logged instead, because rewriting a checked-in deploy config is not
something a build step should do.

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
