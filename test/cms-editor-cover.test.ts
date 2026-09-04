// @pramen/cms-editor — the page header's generated cover art.
//
// The whole value of the feature is one property: the SAME NAME DRAWS THE SAME PICTURE. A
// cover exists to make "Media" recognisable before you have read the word, and art that
// shifted between renders — or between two browsers, or after a deploy — would be worse than
// no art, because the reader would learn a picture that then lied to them. Everything below
// is that property, from three angles: the hash, the accent, and the rendered markup.

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { accentFor, COVER_ACCENTS, CoverArt, hashSeed, seededRandom } from "../packages/cms-editor/src/cover";

/** The real screen names, so the assertions below are about the set that actually ships. */
const NAMES = ["Pages", "Media", "Users", "Settings", "Navigation", "Lectures", "How this site", "Old URLs, kept alive", "Parts of the layout"];

const draw = (seed: string) => renderToStaticMarkup(createElement(CoverArt, { seed }));

describe("hashSeed", () => {
  test("is pinned, because a change to it redraws every cover in every deployment", () => {
    // FNV-1a/32. Written out rather than compared to a second call: this is the one value in
    // the module that must survive refactoring, and a self-consistency check would pass
    // happily while every existing screen changed its picture.
    expect(hashSeed("")).toBe(0x811c9dc5);
    expect(hashSeed("Pages")).toBe(hashSeed("Pages"));
    expect(hashSeed("Media")).not.toBe(hashSeed("Pages"));
  });

  test("stays a uint32 — the mixing degrades to nothing if it goes negative", () => {
    for (const name of [...NAMES, "část", "🎓", "x".repeat(500)]) {
      const h = hashSeed(name);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  test("separates names that differ only by order, which section labels do", () => {
    // A hash that ignored position would give "Pages" and "Space" the same cover.
    expect(hashSeed("Pages")).not.toBe(hashSeed("segaP"));
  });
});

describe("seededRandom", () => {
  test("the same seed replays the same sequence", () => {
    const take = () => Array.from({ length: 16 }, seededRandom(12345));
    expect(take()).toEqual(take());
    expect(Array.from({ length: 8 }, seededRandom(1))).not.toEqual(Array.from({ length: 8 }, seededRandom(2)));
  });

  test("stays in [0, 1)", () => {
    const rand = seededRandom(hashSeed("Media"));
    for (let i = 0; i < 500; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("the accent", () => {
  test("is always one of the closed set, never an arbitrary colour", () => {
    // A free hue would put colours in the chrome that exist nowhere else in the product.
    for (const name of NAMES) expect(COVER_ACCENTS).toContain(accentFor(name));
  });

  test("is stable per name and spreads across the real screen names", () => {
    for (const name of NAMES) expect(accentFor(name)).toBe(accentFor(name));
    // Not "all different" — five accents cannot colour nine screens uniquely, and asserting
    // that would be asserting a coincidence. What matters is that they do not collapse onto
    // one, which is what a broken hash looks like.
    expect(new Set(NAMES.map(accentFor)).size).toBeGreaterThan(2);
  });
});

describe("the rendered cover", () => {
  test("is identical for the same name and different for another", () => {
    expect(draw("Media")).toBe(draw("Media"));
    expect(draw("Media")).not.toBe(draw("Pages"));
  });

  test("is a background, not content: hidden from assistive tech and un-clickable", () => {
    // The screen's name is in the <h1> beside it, so announcing "image" here would add a stop
    // on the way to the thing being labelled — and a full-bleed absolute layer that swallowed
    // clicks would sit over the header's own action button.
    const html = draw("Pages");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("pointer-events-none");
  });

  test("draws its line work in currentColor, which is what makes it theme-correct", () => {
    // podoba does NOT redefine its accent tokens per theme, so a fixed accent stroke would be
    // near-white mint on white in light, or near-black blue on near-black in dark. A tint of
    // the foreground is right on both grounds by construction.
    expect(draw("Pages")).toContain('stroke="currentColor"');
  });

  test("keeps the colour wash off the title, which is set left", () => {
    // The gradient's origin is constrained to the right half. Parsed back out of the markup
    // rather than trusted, because it is one `rand()` away from drifting under the type.
    for (const name of NAMES) {
      const cx = /cx="([\d.]+)%"/.exec(draw(name))?.[1];
      expect(Number(cx), `${name} pools colour under the title`).toBeGreaterThanOrEqual(55);
    }
  });
});
