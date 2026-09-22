// A deployment's hooks over the nav: the module `slots.nav` replaces.
//
// Empty, because the editor's own nav needs no adjusting; the contract (`NavHooks` in
// `slots.ts`) documents both hooks and `nav.ts` applies them, for BOTH chromes, upstream of
// either. A theme's version of this file exports the same `navHooks` name:
//
//   import type { NavHooks } from "@pramen/cms-editor/slots";
//   export const navHooks: NavHooks = {
//     transformNav: ({ sections, active }) => ({ sections: sections.map(renameThings), active }),
//     accountMenu: [{ label: "Content structure", page: "schema", icon: "types", requiresNav: "types" }],
//   };
//
// An OBJECT export rather than two function exports, so that leaving one hook out is simply an
// absent key. With two named exports a theme that only wanted `transformNav` would have to
// export a do-nothing `accountMenu` too, or the build would fail to link.

import type { NavHooks } from "./slots";

export const navHooks: NavHooks = {};
