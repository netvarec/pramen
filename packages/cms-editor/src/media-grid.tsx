// The media library's grid, and what it says when the library is empty.
//
// A SLOT (`slots.mediaGrid`, contracts `MediaGridProps` and `MediaLibraryEmptyProps` in
// `slots.ts`): one module exporting TWO components, `MediaGrid` and `MediaLibraryEmpty`,
// because they are one decision. A design system with its own asset grid (podoba ships
// `AssetMasonryGrid`, `AssetLibraryPreview` and `AssetSelectionEmpty` for exactly this) has
// an empty state that belongs with it, and a slot per component would let a theme swap one
// and ship a grid that falls back to our empty state beside it.
//
// Why a slot and not podoba's asset components here, by default: they arrived in podoba
// 0.0.35 and fit a DIFFERENT library. A masonry grid lays out by each file's aspect ratio, and
// the media rows this CMS stores carry no dimensions, so every tile would be square and the
// masonry an absolutely-positioned re-implementation of the CSS grid below. The rest of what
// they bring is the Graphic Standard's own look (square corners, a lift on hover, a blue
// selection ring), which is a theme's choice rather than this editor's default. And adopting
// them meant moving the podoba this package pins across eight releases of visual changes to
// every other component. A theme built with `designSystem` already links its OWN podoba, so it
// can use them today through this slot without either of those costs.
//
// What stays with the editor, deliberately: the "No files match this filter" state. That is
// not an empty library, and its way out is the editor's own filter state, so a grid slot has
// nothing to decide about it.

import { TILE_BUTTON } from "./chrome";
import type { MediaGridProps, MediaLibraryEmptyProps } from "./slots";

export function MediaGrid({ label, tiles }: MediaGridProps) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
      {tiles.map((t) => (
        // A button, not a `<div onClick>`: the grid is the only way into a file's detail
        // (alt text, tags, delete), and a div left all of that out of reach of the keyboard.
        // The thumbnail is the ORIGINAL file, so it loads lazily: a page of sixty was sixty
        // full-size downloads up front, most of them below the fold.
        <button type="button" key={t.id} className={`${TILE_BUTTON} overflow-hidden rounded-lg border bg-surface-card ${t.selected ? "border-fg" : "border-border"}`} onClick={t.onOpen}>
          {t.src !== null ? <img loading="lazy" decoding="async" className="block h-[130px] w-full object-cover" src={t.src} alt={t.alt} /> : <div className="flex h-[130px] items-center justify-center bg-surface-muted font-mono text-xs text-fg-subtle">{t.ext}</div>}
          <div className="truncate px-2 py-1.5 text-[11px] text-fg-muted">{t.filename}</div>
        </button>
      ))}
    </div>
  );
}

export function MediaLibraryEmpty({ title, description }: MediaLibraryEmptyProps) {
  return <p className="text-fg-subtle">{title} {description}</p>;
}
