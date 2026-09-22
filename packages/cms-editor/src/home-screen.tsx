// What `/` renders.
//
// A SLOT (`slots.home`, contract `HomeScreenProps` in `slots.ts`). This one was tried once and
// turned down, and the reasons were good ones, so it is worth saying what changed. The landing
// route is a buzola `createPage()` carrying the redirect rules for a collections-only
// deployment and for one split by content type; slotting the ROUTE would have put
// `@buzola/router` into every host's build and handed each host those rules to reimplement.
// The one deployment that did it (by replacing `routes/home.tsx` at build time) dropped them,
// so on a collections-only site `/` stopped landing anywhere.
//
// So the route stays ours and only the SCREEN is slotted. The route decides where `/` would
// land (`homeLanding` in `components.tsx`) and hands the answer down as `landing`, with
// `goToLanding` to act on it and `pageList` for the case where the pooled list is itself the
// home screen. A dashboard can ignore all three, follow them, or follow them for some
// deployments and not others, and none of it needs the router: `href` and `navigate` are
// plain functions.
//
// The default is exactly the old behaviour: follow the redirect, or show the list.

import { useEffect } from "react";
import type { HomeScreenProps } from "./slots";

export function HomeScreen({ landing, goToLanding, pageList }: HomeScreenProps) {
  // Keyed on the destination rather than on the object, which the route rebuilds every render.
  const target = landing.kind === "collection" || landing.kind === "type" ? `${landing.kind}:${landing.slug}` : "";
  useEffect(() => {
    if (target) goToLanding();
    // `goToLanding` is rebuilt with the route; the destination is what decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return landing.kind === "pages" ? <>{pageList}</> : null;
}
