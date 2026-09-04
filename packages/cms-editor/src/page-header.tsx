// The screen header: a cover panel carrying the title and the primary action, which STAYS as
// the page scrolls.
//
// A LEAF module, and it has to be one. `components.tsx` already imports from `furniture.tsx`
// (for `flattenTerms`), so the two near-identical headers that used to live one in each — a
// 56px `Hero` and a 40px `Head` — could not be deduplicated by either importing the other
// without a cycle. Below both, they are one component with a size.
//
// STICKY, and condensing. The header is the only thing on screen that says which of a dozen
// interchangeable list screens you are on, and scrolling a media library past the first row
// used to take it away — leaving a wall of thumbnails with no title and no primary action.
// Sticky alone would be worse than that: a 190px banner pinned to the top eats a third of the
// viewport on every scroll. So it condenses — same panel, same artwork, same button, a third
// of the height — which is the only version of "keep it" that a long list can afford.

import { useEffect, useState, type ReactNode } from "react";
import { BELOW_APP_BAR } from "./chrome";
import { CoverArt } from "./cover";

/** The two type scales the app's screens use. `lg` is a library (Pages, Media, a collection);
 * `md` is the settings-shaped site-furniture screens, which have always been quieter. */
export type PageHeaderSize = "lg" | "md";

/** TWO thresholds, not one — this is hysteresis, and without it the header flickers.
 *
 * Condensing REMOVES about 90px of header, which shortens the document by the same amount. If
 * the reader is anywhere the browser then has to clamp the scroll offset, `scrollY` moves on
 * its own — back under a single threshold, which expands the header, which lengthens the
 * document, which moves `scrollY` again. The state is an input to its own condition, so one
 * threshold is a feedback loop by construction and no amount of debouncing fixes it: the
 * oscillation is in the layout, not in the event rate.
 *
 * The gap has to exceed the height the switch removes, or the loop simply reappears further
 * down. `EXPAND_BELOW` is deliberately small so that returning to the top always restores the
 * full header.
 */
const CONDENSE_ABOVE_PX = 120;
const EXPAND_BELOW_PX = 16;

/**
 * Has the page scrolled far enough to condense the header?
 *
 * On `window`, because the editor's shell deliberately keeps the DOCUMENT as its scroller (the
 * rail is a sticky grid column, not an inner scroll pane) — so this is the one scroll position
 * there is. `passive` since nothing here can cancel the scroll, and React bails out of a
 * re-render when the value is unchanged, so a scroll inside the dead band costs a comparison.
 */
function useCondensed(): boolean {
  const [condensed, setCondensed] = useState(false);
  useEffect(() => {
    // Reads the CURRENT value rather than closing over it, so the listener is registered once
    // and the dead band is evaluated against what is actually on screen.
    const onScroll = (): void =>
      setCondensed((was) => (was ? window.scrollY > EXPAND_BELOW_PX : window.scrollY > CONDENSE_ABOVE_PX));
    onScroll(); // a deep link can land already scrolled (browser scroll restoration)
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return condensed;
}

/**
 * The header.
 *
 * Seeded on `lead`, NOT on `em`. `lead` is the screen's name ("Media", a collection's plural
 * label) and `em` is its state ("None yet", "3 files") — seeding on what is displayed would
 * redraw the artwork every time someone uploaded a file, which is the one thing a picture
 * meant to make a screen RECOGNISABLE must never do.
 *
 * The mask over the art is a hard requirement, not polish: the title is large and set left, and
 * `from-surface-card` fading to transparent is what guarantees it never lands on pattern
 * whatever the seed produced. The `via` stop is the whole tuning knob — at `/85` the middle of
 * the panel is still 85% panel colour and the artwork only ever appears in the last third,
 * which is a cover you cannot see; `/70` clears the type (which ends around 26% of the width)
 * and lets the field read across the rest.
 */
export function PageHeader({
  lead,
  em,
  size = "lg",
  children,
}: {
  lead: string;
  em: string;
  size?: PageHeaderSize;
  children?: ReactNode;
}) {
  const condensed = useCondensed();
  return (
    // The GUTTER is what sticks, not the panel: pinning the panel alone would let rows scroll
    // through the 28px of page margin either side of it and out the rounded corners. `bg-surface`
    // on this wrapper is therefore load-bearing, not decoration.
    //
    // `z-20` sits above the list and below the rail's mobile disclosure (which is in flow above
    // it) and every modal overlay (z-50).
    <div className={`sticky ${BELOW_APP_BAR} z-20 mx-auto max-w-[1200px] bg-surface px-7 pb-4 transition-[padding] duration-150 ease-out ${condensed ? "pt-3" : "pt-6"}`}>
      <div className="relative isolate overflow-hidden rounded-panel border border-border bg-surface-card">
        <CoverArt seed={lead} />
        <div className="absolute inset-0 bg-gradient-to-r from-surface-card via-surface-card/70 to-transparent" />
        <div
          className={`relative grid grid-cols-[1fr_auto] items-center gap-6 px-8 transition-[padding] duration-150 ease-out max-[820px]:grid-cols-1 ${
            condensed ? "py-3.5" : size === "lg" ? "py-9" : "py-7"
          }`}
        >
          {/* Condensed, the two halves run on ONE line. Stacked they would keep the full
              header's height and defeat the point; and the title has to stay a single `<h1>`
              across the switch, or a screen reader is handed a new heading every time the
              reader scrolls. */}
          <h1
            // NO transition on the type. `transition-all` here animated `font-size` 56px -> 22px,
            // which relayouts the panel on every frame of the tween — on a STICKY element whose
            // height feeds back into the scroll position, which is the other half of the flicker.
            // And `display` (two stacked lines -> one baseline row) cannot be tweened at all, so
            // the line count snapped mid-animation regardless. The type switches at once; the
            // padding below carries the motion.
            className={`m-0 font-normal tracking-[-0.01em] ${
              condensed
                ? "flex items-baseline gap-2 text-[22px] leading-tight"
                : size === "lg"
                  ? "text-[56px] leading-[1.05] max-[820px]:text-[40px]"
                  : "text-[40px] leading-[1.1]"
            }`}
          >
            <span className={condensed ? "text-fg-subtle" : "block text-fg-subtle"}>{lead}</span>
            <span className={condensed ? "text-fg" : "block text-fg"}>{em}</span>
          </h1>
          {children}
        </div>
      </div>
    </div>
  );
}
