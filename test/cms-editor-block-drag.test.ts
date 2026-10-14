// @pramen/cms-editor: drag-to-reorder of block cards on the page canvas.
//
// Editors reported drag and drop "sometimes working, sometimes not". Three causes, pinned here:
// a drop in the GAP between two cards did nothing (only a card was a target), the highlighted
// card could not say whether the block would land above or below it (that depended on the
// drag's direction), and the browser's own autoscroll could not carry a block up past the
// sticky chrome.

import { describe, expect, test } from "bun:test";
import { autoScrollStep, dropInLowerHalf, dropMarked, moveToSlot } from "../packages/cms-editor/src/block-drag";

const list = ["a", "b", "c", "d"];

describe("moveToSlot", () => {
  test("slot is the gap the block lands in, the same in either direction", () => {
    // Above the first card / below the last.
    expect(moveToSlot(list, 2, 0)).toEqual(["c", "a", "b", "d"]);
    expect(moveToSlot(list, 1, 4)).toEqual(["a", "c", "d", "b"]);
    // Between b and c, from above and from below: the block ends up between them both times.
    expect(moveToSlot(list, 0, 2)).toEqual(["b", "a", "c", "d"]);
    expect(moveToSlot(list, 3, 2)).toEqual(["a", "b", "d", "c"]);
  });

  test("the gaps on either side of the dragged block are not a move", () => {
    expect(moveToSlot(list, 1, 1)).toBe(list);
    expect(moveToSlot(list, 1, 2)).toBe(list);
  });

  test("out-of-range indices change nothing", () => {
    expect(moveToSlot(list, -1, 0)).toBe(list);
    expect(moveToSlot(list, 4, 0)).toBe(list);
    expect(moveToSlot(list, 0, 5)).toBe(list);
  });
});

describe("dropMarked", () => {
  const drag = { region: "content", from: 1, slot: 3 };

  test("marks the hovered slot of the dragged region only", () => {
    expect(dropMarked(drag, "content", 3)).toBe(true);
    expect(dropMarked(drag, "content", 2)).toBe(false);
    expect(dropMarked(drag, "sidebar", 3)).toBe(false);
    expect(dropMarked(null, "content", 3)).toBe(false);
  });

  test("never promises a move that leaves the block where it is", () => {
    expect(dropMarked({ ...drag, slot: 1 }, "content", 1)).toBe(false);
    expect(dropMarked({ ...drag, slot: 2 }, "content", 2)).toBe(false);
  });
});

test("a card's lower half drops below it, the upper half above", () => {
  expect(dropInLowerHalf(149, 100, 100)).toBe(false);
  expect(dropInLowerHalf(150, 100, 100)).toBe(true);
});

describe("autoScrollStep", () => {
  const h = 900;
  const inset = 133;

  test("still in the middle of the window", () => {
    expect(autoScrollStep(500, h, inset)).toBe(0);
  });

  test("scrolls up just below the sticky chrome, not only at the window's very edge", () => {
    expect(autoScrollStep(inset + 10, h, inset)).toBeLessThan(0);
    expect(autoScrollStep(inset + 200, h, inset)).toBe(0);
  });

  test("scrolls down near the bottom, faster the deeper in", () => {
    const shallow = autoScrollStep(h - 80, h, inset);
    const deep = autoScrollStep(h - 5, h, inset);
    expect(shallow).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(shallow);
  });
});
