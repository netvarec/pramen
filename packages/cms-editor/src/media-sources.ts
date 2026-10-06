// Where files can come from besides an upload: the module `slots.mediaSources` replaces.
//
// Empty, because the editor knows of no external store; the contract (`MediaSource` and
// `MediaSourceProps` in `slots.ts`) says what a source is handed, and `media-source-ui.tsx`
// renders the frames around it. A deployment's version of this file exports the same name:
//
//   import type { MediaSource } from "@pramen/cms-editor/slots";
//   import { DamBrowser } from "./dam-browser";
//   export const mediaSources: readonly MediaSource[] = [{ id: "dam", label: "DAM", Browser: DamBrowser }];
//
// A LIST rather than one source, so a second store is a second entry and not a second slot.

import type { MediaSource } from "./slots";

export const mediaSources: readonly MediaSource[] = [];
