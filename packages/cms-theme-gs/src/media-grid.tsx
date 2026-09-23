// `slots.mediaGrid`: the media library as GS's asset library.
//
// podoba's `AssetMasonryGrid` of `AssetLibraryPreview` cards (the square card with the lift on
// hover and the blue ring when selected), the filename and size under each, and
// `AssetSelectionEmpty` for a library with nothing in it.
//
// Every tile is SQUARE (`aspectRatio: 1`). The masonry lays out by each file's aspect ratio, and
// the media rows this CMS stores carry no dimensions, so there is nothing truthful to pass; the
// image is `object-contain` inside the square instead of cropped, so nothing is cut off. If the
// CMS ever records width and height, this is the one line that turns the grid into a real
// masonry.
//
// A non-image, or an image that fails to load, shows its extension in the mono face: the `<img>`
// sits over the placeholder and hides itself on error, so a broken file degrades to the same
// tile a PDF gets rather than to the browser's broken-image glyph.

import { AssetLibraryPreview, AssetMasonryGrid, AssetSelectionEmpty } from "@podoba/react";
import type { MediaGridProps, MediaLibraryEmptyProps } from "@pramen/cms-editor/slots";
import { copy } from "./copy";

export function MediaGrid({ label, tiles }: MediaGridProps) {
  return (
    <AssetMasonryGrid
      label={label}
      items={tiles.map((tile) => ({
        id: tile.id,
        aspectRatio: 1,
        content: (
          <div>
            <AssetLibraryPreview label={tile.filename} selected={tile.selected} aspectRatio={1} tags={[]} onPress={tile.onOpen}>
              {tile.src !== null ? (
                <>
                  <span className="absolute inset-0 flex items-center justify-center font-mono text-heading2 text-fg-muted" aria-hidden="true">{tile.ext}</span>
                  <img
                    loading="lazy"
                    decoding="async"
                    onError={(event) => { event.currentTarget.hidden = true; }}
                    className="relative h-full w-full bg-surface-card object-contain"
                    src={tile.src}
                    alt={tile.alt}
                  />
                </>
              ) : (
                <span className="flex h-full items-center justify-center bg-surface-card font-mono text-heading2 text-fg-muted">{tile.ext}</span>
              )}
            </AssetLibraryPreview>
            <div className="flex min-w-0 items-start justify-between gap-2 py-3 text-small">
              <span className="min-w-0 truncate text-fg" title={tile.filename}>{tile.filename}</span>
              <span className="shrink-0 text-fg-muted">{tile.sizeLabel}</span>
            </div>
          </div>
        ),
      }))}
    />
  );
}

/** GS's own wording for an empty library, which points at the header's upload pill; the
 * editor's generic line ("Upload images to use them in blocks and SEO") does not know where
 * the theme put that action. */
export function MediaLibraryEmpty(_props: MediaLibraryEmptyProps) {
  return <AssetSelectionEmpty variant="library" title={copy.t("media.emptyTitle")} description={copy.t("media.emptyDescription")} />;
}
