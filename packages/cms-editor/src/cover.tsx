// The page header's generated cover art.
//
// A Notion page opens with a cover, and a CMS screen has the same problem a Notion page has:
// six list screens whose only difference is a word at the top read as one screen you keep
// landing on. The cover is what makes "Media" and "Menus" recognisable before the type is.
//
// So it is DERIVED, not chosen: a hash of the screen's name seeds a PRNG, and the PRNG lays
// out a Truchet field — a grid of quarter-circle arcs whose per-tile orientation is the only
// random thing about it. Same name, same picture, forever; a new collection gets its own
// without anyone drawing one. That is the whole appeal over a stock image: nothing to author,
// nothing to upload, and no screen that looks like another.
//
// Two rules govern every choice below, and both come from what this art sits UNDER:
//
//   LEGIBILITY. The header carries 56px type and the primary action. Line work is
//   `currentColor` at low alpha — a tint of the foreground, so it is dark on the light theme
//   and light on the dark one BY CONSTRUCTION. That matters here specifically: podoba does
//   not redefine its accent tokens per theme, so a fixed accent stroke would be near-white
//   mint on a white ground in light, or near-black blue on a dark ground in dark. Colour
//   therefore arrives as a WASH at ~0.14 alpha, which survives either ground, and the left
//   third fades to the panel colour so the title never sits on pattern.
//
//   NO DEPENDENCY, NO CANVAS, NO NETWORK. It is one inline SVG built during render: ~50
//   paths, no measuring, no effects, no images to load, and it prints and scales.

import type { ReactElement } from "react";

/** Tiles across and down. The banner is wide and short and the SVG is `slice`-fitted, so
 * these are a RATIO more than a count: the field fits by WIDTH and is cropped vertically,
 * which is what makes it bleed to the panel edges at any header height.
 *
 * Tuned by looking at it. A 14×3 field puts ~80px tiles in a 1140px panel, and at that size a
 * Truchet arc stops being a woven line and becomes a big soft loop — organic, which is the
 * wrong register next to Swiss type. Finer tiles read as the precise, drawn-by-a-machine
 * pattern this is meant to be. */
const COLS = 20;
const ROWS = 5;

/**
 * FNV-1a, 32-bit.
 *
 * Not for security — for a stable, well-mixed number from a short string. Stability is the
 * requirement that rules out `Math.random` and anything else stateful: the same screen has to
 * draw the same picture on every render, in every browser, after every deploy.
 *
 * `>>> 0` after the multiply keeps it in unsigned 32-bit; JS bitwise ops work on int32, so
 * without it the accumulator goes negative and the mixing degrades.
 */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — a tiny, well-distributed PRNG. Seeded once per cover, so the sequence (and
 * therefore the picture) is a pure function of the name. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The accents a wash may use.
 *
 * A CLOSED list of podoba tokens, not a hue rotation: the point is a page that looks like it
 * belongs to this product, and a free hue would put colours in the chrome that exist nowhere
 * else in it. Every entry is mid-toned, which is what lets one alpha work on both the white
 * and the near-black ground — the very light tokens (`accent-mint`) vanish on white and the
 * very dark one (`accent-blue`) vanishes on the dark theme, so neither is in here.
 */
export const COVER_ACCENTS: readonly string[] = [
  "var(--color-accent-strong)",
  "var(--color-brand-green)",
  "var(--color-accent-green-lighter)",
  "var(--color-accent-yellow)",
  "var(--color-accent-pink)",
];

/** Which accent a given name gets. Exported because it is the one part of the picture worth
 * asserting on directly: it must be stable, and it must be one of the five. */
export function accentFor(seed: string): string {
  return COVER_ACCENTS[hashSeed(`${seed}:accent`) % COVER_ACCENTS.length] as string;
}

/** One Truchet tile: two quarter arcs joining opposite edge midpoints, in one of two
 * orientations. Both are drawn at unit scale and translated into place, so the whole field is
 * resolution-independent and the stroke scales with the banner. */
function tilePath(col: number, row: number, flipped: boolean): string {
  const x = col;
  const y = row;
  return flipped
    ? `M${x + 0.5} ${y} A0.5 0.5 0 0 0 ${x + 1} ${y + 0.5} M${x} ${y + 0.5} A0.5 0.5 0 0 0 ${x + 0.5} ${y + 1}`
    : `M${x} ${y + 0.5} A0.5 0.5 0 0 0 ${x + 0.5} ${y} M${x + 1} ${y + 0.5} A0.5 0.5 0 0 0 ${x + 0.5} ${y + 1}`;
}

/**
 * The cover for one screen, seeded by its name.
 *
 * Absolutely positioned to fill its (relative, `overflow-hidden`) parent — it is a
 * background, and giving it its own box would make the header's height depend on the art
 * rather than on the type in it.
 *
 * `aria-hidden`: it carries no information a reader could act on. The screen's name is in the
 * `<h1>` right next to it, so announcing "image" here would add a stop on the way to the
 * thing that is actually being labelled.
 */
export function CoverArt({ seed }: { seed: string }): ReactElement {
  const rand = seededRandom(hashSeed(seed));
  const accent = accentFor(seed);
  // The wash's origin, kept to the RIGHT half: the title is set left, and colour pooling
  // under it is exactly the contrast the header cannot afford.
  const washX = 55 + rand() * 40;
  const washY = 20 + rand() * 60;

  const tiles: string[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) tiles.push(tilePath(col, row, rand() > 0.5));
  }
  // A few filled nodes where arcs meet — the one place the accent appears at full strength,
  // and what stops a page's identity from being carried by geometry alone (two names can land
  // on similar-looking fields; they will not also land on the same colour).
  const dots = Array.from({ length: 5 }, () => ({
    cx: 1 + rand() * (COLS - 2),
    cy: 0.5 + rand() * (ROWS - 1),
    r: 0.09 + rand() * 0.11,
  }));

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full text-fg"
      viewBox={`0 0 ${COLS} ${ROWS}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <radialGradient id={`wash-${hashSeed(seed)}`} cx={`${washX}%`} cy={`${washY}%`} r="70%">
          <stop offset="0%" stopColor={accent} stopOpacity="0.34" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={COLS} height={ROWS} fill={`url(#wash-${hashSeed(seed)})`} />
      <g fill="none" stroke="currentColor" strokeWidth="0.035" strokeLinecap="round" opacity="0.28">
        {tiles.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <g fill={accent} opacity="0.5">
        {dots.map((c) => (
          <circle key={`${c.cx}-${c.cy}`} cx={c.cx} cy={c.cy} r={c.r} />
        ))}
      </g>
    </svg>
  );
}
