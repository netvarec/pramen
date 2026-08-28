// The package root: the integration (Node-only, loaded from astro.config.*) plus the whole
// runtime surface, so `import pramenCms from "@pramen/cms-astro"` works and the kit of parts
// stays importable from the same specifier.
//
// The generated virtual module and the .astro components deliberately import
// `@pramen/cms-astro/runtime` instead — that path carries no node builtins, so nothing here
// can end up in the site's Worker bundle.
export * from "./index.js";
export { pramenCms, default } from "./integration.js";
export type { CmsBackend, CollectionMap, PramenCmsOptions } from "./integration.js";
