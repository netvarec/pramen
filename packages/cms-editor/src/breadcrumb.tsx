// Where you are, for the app bar.
//
// The trail has two parts and they come from different places, which is the whole design
// here. The SECTION is derivable — the layout already knows which nav entry is lit, and that
// entry carries both a label and the route back to its list. The DETAIL is not: `/pages/:id`
// carries an opaque id, and the page's title only exists inside the editor that fetched it.
// So the section is computed in the layout and the detail is PUBLISHED by whatever is on
// screen, through the hook below.
//
// It matters most exactly where the screen header is absent. A list screen already says
// "Media" in 56px immediately under the bar, so the crumb there is a mild echo; a page editor
// has no header at all — three columns of panels and a "← all pages" button — and the trail is
// the only thing naming what is open.
//
// A LEAF module: `components.tsx` and `furniture.tsx` both publish into it, and
// `components.tsx` already imports from `furniture.tsx`, so anything they share has to sit
// below both.

import { createContext, useContext, useEffect, type ReactNode } from "react";

/** Only the SETTER travels down. The value lives in the layout, which is also what renders
 * the bar — handing the value back down as well would be a second copy of state that exists
 * to be read by the component that owns it. */
const PublishCrumb = createContext<(label: string | null) => void>(() => {});

export function BreadcrumbProvider({ publish, children }: { publish: (label: string | null) => void; children: ReactNode }) {
  return <PublishCrumb.Provider value={publish}>{children}</PublishCrumb.Provider>;
}

/**
 * Publish the trailing crumb for the screen that is mounted.
 *
 * Pass `undefined` while the record is still loading and the bar simply shows the section —
 * better than a crumb that says "Loading…" and then changes, which draws the eye to the one
 * place on screen that should be still.
 *
 * The cleanup is not optional: without it a crumb outlives its screen, so leaving a page
 * editor for a list would leave the page's title sitting in the bar next to a different
 * section. Effect-based rather than render-time, because publishing during render is a state
 * update in another component's render pass.
 */
export function useCrumb(label: string | null | undefined): void {
  const publish = useContext(PublishCrumb);
  useEffect(() => {
    publish(label ?? null);
    return () => publish(null);
  }, [label, publish]);
}
