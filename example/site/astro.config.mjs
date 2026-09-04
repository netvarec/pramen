// The example Astro site: it reads the example CMS backend (`example/app.ts`, deployed by
// `example/worker.ts`) and — because of `admin` below — also SERVES that backend's editor,
// at /__admin, from this same origin.
//
// Run the backend with `bun run dev` at the repo root, then `bun run --cwd example/site dev`.

import node from "@astrojs/node";
import pramenCms from "@pramen/cms-astro";
import { defineConfig } from "astro/config";

// `test/astro-site.test.ts` builds this site against a stub CMS, so the backend is an env
// var with the local dev worker as its default.
const backend = {
  url: process.env.PRAMEN_CMS_URL ?? "http://localhost:8787",
  tenant: process.env.PRAMEN_CMS_TENANT ?? "main",
};

export default defineConfig({
  // The admin route is on-demand (`prerender = false`), so a build needs an adapter even
  // though every page of the site itself is static. Node here because it is the adapter
  // this repo's test can boot; a real deployment would use @astrojs/cloudflare, and nothing
  // about the admin mount is adapter-specific.
  adapter: node({ mode: "standalone" }),
  integrations: [
    pramenCms({
      backend,

      // An explicit map, not the `"auto"` default. Auto-discovery names collections after
      // the content-type slugs it finds in the STORE, which is exactly what an example
      // cannot hard-code — `getCollection("articles")` below has to compile against a name
      // that is known here. A real site usually wants `"auto"`: adding a content type in
      // the editor then takes effect on the next build with no code change.
      collections: { articles: "article" },

      // Serve the editor from this site. `true` would do, with the same backend and no
      // other configuration; the object form also carries the editor's own settings, which
      // is what used to live in a hand-edited /config.js.
      admin: {
        brand: { name: "Example", suffix: "cms" },
        extraNav: [{ label: "Site", href: "/" }],

        // Where the editor's "Preview link" button sends people. Without it the link points
        // at the CMS Worker's own redeem endpoint, which answers with JSON — right for a
        // machine, useless for the stakeholder a preview link is FOR. `src/pages/preview.astro`
        // redeems the same token and renders it with the site's own layout.
        previewUrl: "/preview",
        // Where an unauthenticated (or expired) session is sent. The editor verifies bearer
        // tokens and knows nothing about how one is obtained, so the SITE owns the sign-in
        // screen — `src/pages/admin/sign-in.astro` calls `login`, writes the token where the
        // editor reads it, and hands over. `/__admin?setup=1` still forces the editor's own
        // token screen, which is the way in when there is no account to sign in as.
        signInUrl: "/admin/sign-in",
      },
    }),
  ],
});
