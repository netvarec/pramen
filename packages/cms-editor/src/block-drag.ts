// Drag-to-reorder of block cards on the page canvas (components.tsx), the parts that are
// plain arithmetic. A drag targets a SLOT, the gap between two cards: slot 0 is above the
// first card, slot n below the last. A card hands the pointer to the slot above or below it
// by which half the pointer is in; a gap is its own slot.

import { useEffect } from "react";

/**
 * `list` with the item at `from` moved into `slot`. Returns `list` ITSELF (same reference)
 * when the move changes nothing: the slots right above and right below the dragged item are
 * where it already is, and an out-of-range index is not a move.
 */
export function moveToSlot<T>(list: T[], from: number, slot: number): T[] {
  if (from < 0 || from >= list.length || slot < 0 || slot > list.length) return list;
  if (slot === from || slot === from + 1) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  // Removing the item shifts every later slot up by one.
  next.splice(slot > from ? slot - 1 : slot, 0, moved);
  return next;
}

/** Whether the drop marker belongs in `slot` of `region`: the hovered slot, unless dropping
 * there would leave the block where it is (then a marker would promise a move that never
 * happens). */
export function dropMarked(drag: { region: string; from: number; slot: number } | null, region: string, slot: number): boolean {
  return !!drag && drag.region === region && drag.slot === slot && slot !== drag.from && slot !== drag.from + 1;
}

/** Pointer at `y` is in the lower half of a box starting at `top` and `height` tall. */
export function dropInLowerHalf(y: number, top: number, height: number): boolean {
  return y >= top + height / 2;
}

/** Edge band (px) where a drag scrolls the window, and the most it scrolls per frame. */
const EDGE = 96;
const MAX_STEP = 24;

/**
 * Scroll speed for a drag at `y` in a viewport `height` tall, with `topInset` px of sticky
 * chrome over the top. Negative scrolls up. Proportional to how deep into the band the
 * pointer is, so it can be steered.
 */
export function autoScrollStep(y: number, height: number, topInset: number): number {
  const top = topInset + EDGE;
  if (y < top) return -Math.ceil(MAX_STEP * Math.min(1, (top - y) / EDGE));
  const bottom = height - EDGE;
  if (y > bottom) return Math.ceil(MAX_STEP * Math.min(1, (y - bottom) / EDGE));
  return 0;
}

/** Height of the sticky chrome over the page editor: the app bar (`--pramen-chrome-h`, in px
 * or rem) plus the page toolbar (`PAGE_TOOLBAR_H` in chrome.ts, h-14 = 3.5rem). */
function stickyTopInset(): number {
  const root = document.documentElement;
  const rem = parseFloat(getComputedStyle(root).fontSize) || 16;
  const raw = getComputedStyle(root).getPropertyValue("--pramen-chrome-h").trim();
  const bar = raw.endsWith("rem") ? parseFloat(raw) * rem : parseFloat(raw);
  return (Number.isFinite(bar) ? bar : 0) + 3.5 * rem;
}

/**
 * Scroll the window while a block is dragged near its top or bottom edge.
 *
 * The browser's own drag autoscroll starts only a few pixels from the window's edge, and at
 * the top that strip is under the sticky app bar and page toolbar. With expanded cards often
 * taller than the screen, a block could not be carried more than a card or two up the page.
 */
export function useDragAutoScroll(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const topInset = stickyTopInset();
    let y: number | null = null;
    let frame = 0;
    const onOver = (e: DragEvent) => { y = e.clientY; };
    const tick = () => {
      if (y !== null) {
        const step = autoScrollStep(y, window.innerHeight, topInset);
        if (step) window.scrollBy(0, step);
      }
      frame = requestAnimationFrame(tick);
    };
    document.addEventListener("dragover", onOver);
    frame = requestAnimationFrame(tick);
    return () => {
      document.removeEventListener("dragover", onOver);
      cancelAnimationFrame(frame);
    };
  }, [active]);
}
