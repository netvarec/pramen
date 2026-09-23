// The build-time half of the theme: which of the editor's modules it replaces.
//
// `buildEditor` from `@pramen/cms-editor/build` does the building; this returns the options
// the theme contributes, so a host wires GS in one spread and keeps every other decision
// (where the output goes, which project supplies podoba and React, its own stylesheet) in its
// own build script:
//
//   await buildEditor({
//     outdir: resolve(root, "public/admin"),
//     designSystem: root,
//     ...gsEditor({ styles: resolve(root, "src/admin/editor.css"), slots: { nav: resolve(root, "src/admin/nav.ts") } }),
//   });
//
// `styles` stays the HOST's file, and the theme cannot supply one: Tailwind resolves an
// `@import` and an `@source` from the directory of the file that wrote it, so only a stylesheet
// in the host's tree reaches the host's podoba and tokens (see `buildEditor`'s `styles`). The
// theme's CSS is imported FROM that file. What this function can do is notice when it is not,
// because that failure is silent: the slots render, and render unstyled.

import type { EditorSlot } from "@pramen/cms-editor/build";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The theme's module for each slot it fills. Every slot the editor has, so a release that adds
 * one is a type error here (`satisfies`), not a slot the theme silently leaves at the default. */
export const GS_SLOTS = {
  pageHeader: "./page-header.tsx",
  home: "./home.tsx",
  detailHeader: "./detail-header.tsx",
  mediaDetail: "./media-detail.tsx",
  mediaGrid: "./media-grid.tsx",
  nav: "./nav.ts",
} as const satisfies Record<EditorSlot, string>;

/** The specifier a host stylesheet imports the theme's CSS by. */
export const GS_STYLESHEET = "@pramen/cms-theme-gs/theme.css";

export interface GsEditorOptions {
  /**
   * Your Tailwind entry, passed through to `buildEditor`'s `styles` after a check that it
   * imports {@link GS_STYLESHEET}. Optional only so the slots can be taken on their own.
   */
  styles?: string;
  /**
   * Your own module for a slot, in place of the theme's: an absolute path, or relative to the
   * working directory like every path `buildEditor` takes. The usual one is `nav`, a module
   * that wraps `gsTransformNav` (see `@pramen/cms-theme-gs/nav`), or `home` built with
   * `createHomeScreen` (`@pramen/cms-theme-gs/home`). `false` leaves that slot to the editor's
   * own default.
   */
  slots?: Partial<Record<EditorSlot, string | false>>;
}

export interface GsEditorBuild {
  slots: Partial<Record<EditorSlot, string>>;
  styles?: string;
}

/** The theme's contribution to `buildEditor`'s options. Spread it in. */
export function gsEditor(options: GsEditorOptions = {}): GsEditorBuild {
  const slots: Partial<Record<EditorSlot, string>> = {};
  for (const [name, file] of Object.entries(GS_SLOTS) as [EditorSlot, string][]) {
    const own = options.slots?.[name];
    if (own === false) continue;
    slots[name] = own ?? fileURLToPath(new URL(file, import.meta.url));
  }
  if (options.styles === undefined) return { slots };
  // A substring, not a CSS parse: a comment mentioning the name would pass, and that is a fine
  // trade for a check whose job is to catch the file that forgot the line entirely.
  if (!readFileSync(options.styles, "utf8").includes(GS_STYLESHEET)) {
    throw new Error(`@pramen/cms-theme-gs: ${options.styles} does not import "${GS_STYLESHEET}". The theme's slots would build and render without their styles; add \`@import "${GS_STYLESHEET}";\` after the editor's and podoba's imports.`);
  }
  return { slots, styles: options.styles };
}
