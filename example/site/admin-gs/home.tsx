// The example's dashboard: the theme's, with the site's name in the greeting and the Lecture
// desk counted like the collection it works on (the same rule `nav.ts` applies to the bar).
// A bare slug is enough: the loader looks the collection up, so the tile reads like the
// theme's own `lectures` tile.

import { loadCollectionStat } from "@pramen/cms-theme-gs/dashboard-data";
import { createHomeScreen } from "@pramen/cms-theme-gs/home";

export const HomeScreen = createHomeScreen({
  title: "Example",
  sections: (sections) =>
    sections.map((section) =>
      section.key === "app:lecture-desk" ? { ...section, stat: (api) => loadCollectionStat(api, "lectures") } : section,
    ),
});
