# example-site

The Astro half of the example. It reads the example CMS backend (`example/app.ts`, served by
`example/worker.ts`) **and serves that backend's editor**, at `/_pramen/admin`, from this
same origin.

```bash
bun run dev                          # the pramen worker, on :8787
bun run --cwd example/site dev       # this site, on :4321
```

Then <http://localhost:4321> for the site and <http://localhost:4321/_pramen/admin> for the
editor. Sign in with an editor/reviewer JWT; the site tells the editor which Worker and
tenant to call, so it does not ask.

## What it demonstrates

`astro.config.mjs` is the whole wiring — one integration:

```js
pramenCms({
  backend: { url: "http://localhost:8787" },
  collections: { articles: "article" },
  admin: { brand: { name: "Example", suffix: "cms" }, extraNav: [{ label: "Site", href: "/" }] },
})
```

- **Content.** `src/content.config.ts` re-exports the generated collections in one line, and
  `src/pages/*.astro` read them with `getCollection` like any other Astro content. Pages are
  pulled at build time, so the site is static; `src/components/blocks/RichText.astro` shows
  the one component a block type needs.
- **The editor.** `admin` injects a catch-all route, so the editor is *part of this site*:
  no `dist/` deployed beside it, no SPA-fallback rewrite, no second hostname for it. Its
  `editor.js` / `editor.css` go through this site's bundler like any other import, which is
  what lets it be served under a prefix at all. The API is still cross-origin here — the
  worker is on :8787, this site on :4321 — which is why `oblaka.ts` sets `CORS_ORIGINS`.

Two deliberate departures from what a real site would do:

- **`collections` is an explicit map**, not the `"auto"` default. Auto-discovery names
  collections after the content-type slugs it finds in the store — exactly what an example
  cannot hard-code, since `getCollection("articles")` has to compile against a known name.
- **The adapter is `@astrojs/node`**, because that is what this repo's test can boot. A real
  pramen site uses `@astrojs/cloudflare`; nothing about the admin mount is adapter-specific.
  An adapter is needed at all only because the admin route is on-demand (`prerender = false`)
  — every page of the site itself is static.

## Type checking

```bash
bun run --cwd example/site check     # astro check — needs the backend reachable
```

`astro check` is the only thing in this repo that type-checks `.astro` files, and the root
`bun run typecheck` deliberately does **not** run it: `astro check` syncs before it checks,
which runs the content loaders, so it needs a reachable CMS. `test/astro-site.test.ts` runs
it there instead, where the stub is already up.

`[slug].astro` declares a `Props` interface rather than reading `entry.data` directly. A
generated collection carries no Zod schema, so `data` is `any` — without that interface every
read in the template would type-check vacuously, and the check would be theatre.

## It is also the test

`test/astro-site.test.ts` builds this site against a stub CMS, boots the output and asks the
server the questions no unit test can: does a real `astro build` emit the editor's assets at
URLs the shell can reach, and does the injected route actually serve a deep link. That is the
half that broke the previous attempt at this feature, so it is the half worth building for
real.
