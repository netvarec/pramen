// @pramen/cms-theme-gs, built for real: `buildEditor` with the theme's slots and stylesheet,
// against a design-system root that has the podoba the theme needs (0.0.42), while the editor
// package itself still pins 0.0.34.
//
// The same method as `cms-editor-host-build.test.ts`: a build exiting zero proves little,
// because every way this goes wrong still produces a working editor. The theme's slot quietly
// not taking (the editor's own header ships), the editor's podoba linked instead of the host's
// (the theme's components are simply not in it, or are in it twice), the stylesheet compiled
// without the theme's classes (everything renders, unstyled). So each is checked in the OUTPUT:
// which modules the bundle is made of, and which rules the stylesheet has.
//
// The design-system root is the theme package itself: its devDependencies are the podoba
// generation it is written against, which is what a host installs next to it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildEditor } from "../packages/cms-editor/src/build-editor";
import { gsEditor, GS_STYLESHEET } from "../packages/cms-theme-gs/src/build";

const THEME = resolve(import.meta.dir, "../packages/cms-theme-gs");

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A host's Tailwind entry, the one the README tells a host to write. Under the theme's own
 * `node_modules` so its bare imports resolve the way they do from a host project that has the
 * theme and podoba 0.0.42 installed. */
async function hostStyles(dir: string): Promise<string> {
  const file = join(dir, "editor.css");
  await writeFile(
    file,
    [
      `@import "@pramen/cms-editor/app.css";`,
      `@import "@podoba/tokens/variables.css";`,
      `@import "@podoba/tailwind";`,
      `@import "${GS_STYLESHEET}";`,
      `@source "../@podoba/react/src";`,
      "",
    ].join("\n"),
  );
  return file;
}

describe("the GS theme in a host build", () => {
  let js = "";
  let css = "";

  test("buildEditor succeeds with every theme slot and the theme's stylesheet", async () => {
    const dir = await mkdtemp(join(THEME, "node_modules", ".test-gs-"));
    dirs.push(dir);
    const outdir = join(dir, "out");
    await buildEditor({ outdir, minify: false, designSystem: THEME, ...gsEditor({ styles: await hostStyles(dir) }) });
    js = await readFile(join(outdir, "editor.js"), "utf8");
    css = await readFile(join(outdir, "editor.css"), "utf8");
  }, 120_000);

  test("every slot is the theme's module, and none of the editor's defaults is linked", () => {
    // An unminified bundle opens each module with a `// <path>` comment.
    for (const file of ["page-header.tsx", "home.tsx", "detail-header.tsx", "media-detail.tsx", "media-grid.tsx", "nav.ts", "copy.ts", "dashboard-data.ts"]) {
      expect(js, file).toContain(`cms-theme-gs/src/${file}\n`);
    }
    for (const file of ["page-header.tsx", "home-screen.tsx", "detail-header.tsx", "media-detail.tsx", "media-grid.tsx", "nav-hooks.ts"]) {
      expect(js, file).not.toContain(`cms-editor/src/${file}\n`);
    }
  });

  test("one podoba, the host's 0.0.42, with the GS components the slots use", () => {
    expect(js).toContain("@podoba+react@0.0.42");
    expect(js).not.toContain("@podoba+react@0.0.34");
    for (const name of ["BrandPageHeader", "CtaPill", "DashboardGrid", "DashboardTile", "AssetMasonryGrid", "AssetLibraryPreview", "AssetSelectionEmpty"]) {
      expect(js, name).toContain(`function ${name}(`);
    }
  });

  test("the theme speaks through the editor's one i18n instance", () => {
    expect(js.split("cms-editor/src/i18n/index.ts\n").length - 1).toBe(1);
    expect(js).toContain("Vaše knihovna médií je zatím prázdná");
    expect(js).toContain("Vítejte zpět");
  });

  test("the stylesheet has the theme's rules and the utilities only the theme's source uses", () => {
    expect(css).toContain(".gs-create-title");
    expect(css).toContain(".gs-create-button");
    // Arbitrary values written only in the theme's source (`media-detail.tsx`, `home.tsx`):
    // generated only if Tailwind scanned it through the theme's own `@source`.
    expect(css).toContain("width: min(90vw, 75rem)");
    expect(css).toContain(".min-h-\\[240px\\]");
    // And no font file: GT America is the host's to serve.
    expect(css).not.toContain("data:font/woff2;base64,");
    expect(css).not.toMatch(/@font-face\s*{[^}]*GT America/);
  });
});
