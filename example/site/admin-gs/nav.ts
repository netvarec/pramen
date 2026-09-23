// The example's nav under the GS theme: the theme's rules plus one of the project's own, which
// is how a project extends the theme without copying it.
//
// The project step: the Lecture desk panel is the way this deployment works with lectures, so
// it takes the plain collection's place in the bar, and the collection's screens light the desk.
// The collection stays reachable (from the dashboard and by URL); only the bar changes.

import type { NavHooks } from "@pramen/cms-editor/slots";
import { composeNav, gsNavHooks, gsTransformNav, type NavStep } from "@pramen/cms-theme-gs/nav";

const lectureDesk: NavStep = ({ sections, active }) => {
  const desk = sections.some((section) => section.entries.some((entry) => entry.key === "app:lecture-desk"));
  if (!desk) return { sections, active };
  return {
    sections: sections.map((section) => ({ ...section, entries: section.entries.filter((entry) => entry.key !== "col:lectures") })),
    active: active === "col:lectures" ? "app:lecture-desk" : active,
  };
};

export const navHooks: NavHooks = { ...gsNavHooks, transformNav: composeNav(lectureDesk, gsTransformNav) };
