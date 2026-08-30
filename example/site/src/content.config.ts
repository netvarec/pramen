// The one line the integration cannot write for you. Astro has no API for an integration to
// define content collections, so `pramenCms()` generates them into the `pramen:cms` virtual
// module and the site re-exports them here — once, and never again as content types change.
export { collections } from "pramen:cms";
