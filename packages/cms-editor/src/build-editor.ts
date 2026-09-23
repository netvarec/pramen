// Building the editor, as an API a HOST can call — not just as this package's own script.
//
// `dist/editor.js` and `dist/editor.css` are self-contained on purpose: the drop-in story is
// that a host adds the integration and gets a working CMS with no build config at all. The
// cost of self-contained, though, is that the design system is SEALED IN. `editor.css` is
// Tailwind already compiled against the podoba tokens this package pins, with the web font
// inlined as a data: URI; `editor.js` has podoba's components compiled into it. So a site
// whose own design system is podoba gets the editor's generation of it, not its own, and
// there is no configuration that reaches inside a compiled bundle to change that.
//
// What a deployment did instead is the evidence this API exists: it rebuilt the editor out of
// the `src/` this package ships, resolving podoba to its own copy, and got the rest of the way
// with ~70 string replacements against our source — `contents.replace()` per upstream line,
// several of them by `indexOf` + `slice`. Every one of those is a silent break waiting for the
// next release, and none of them is something the project WANTED to write; they are what is
// left when the supported path stops at a sealed bundle.
//
// So: the same build, parameterized. `buildEditor()` with no options is what `scripts/build.ts`
// runs and produces the published `dist/`. A host passes `designSystem` to bundle against its
// own podoba and React, `styles` to compile the stylesheet from its own Tailwind entry (which
// is the half a runtime import map can never fix — CSS is compiled, not linked), and `slots`
// to put its own component in place of one of ours.
//
// Source-side rather than inside `scripts/build.ts`, for the reason `panel-globals.ts` gives
// for living here: a build helper that a host depends on is API, so it should be typechecked
// and exercised by tests rather than sit in a script nobody imports.

import type { BunPlugin } from "bun";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportableNames, panelShimSource, PANEL_GLOBAL_SHIMS } from "./panel-globals";
import { PANEL_RUNTIME_GLOBAL } from "./panel-runtime";

/** This package's root, with no trailing separator. */
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The editor's own modules a host may replace, and the specifier each is reached by.
 *
 * A slot is a standing promise that a module's props are stable across releases, so every one
 * has its contract written down as a TYPE in `slots.ts` (published as
 * `@pramen/cms-editor/slots`), and the default here is declared against that same type. A theme
 * types its replacement with an import, not a copy, and a change to a contract is a compile
 * error on both sides.
 *
 * Each slot replaced something a deployment was already doing by string replacement against
 * our source, which is the bar for adding one: evidence that the seam is wanted, and a
 * contract narrow enough to keep.
 *
 * - `pageHeader`: the sticky header of a list screen (`PageHeaderProps`).
 * - `home`: the SCREEN at `/` (`HomeScreenProps`). Not the route: the route stays ours and
 *   hands the screen its landing decision, so a dashboard neither imports the router nor
 *   re-derives the collections-only and split-by-type redirects. (Slotting the route itself
 *   was tried and rejected for exactly those two reasons; see `home-screen.tsx`.)
 * - `detailHeader`: the way back plus the title, on every detail screen (`DetailHeaderProps`).
 * - `mediaDetail`: the dialog frame around one file (`MediaDetailFrameProps`).
 * - `mediaGrid`: the library grid AND its empty state, one module exporting both
 *   (`MediaGridProps`, `MediaLibraryEmptyProps`).
 * - `nav`: not a component but an object of hooks over the nav (`NavHooks`): transform the
 *   sections and the lit key, add account-menu rows. Applied upstream of both chromes.
 *
 * What is deliberately NOT here:
 *
 * - **The chrome.** `brand` and `layout` already dress it from the shell config, at runtime,
 *   with no build at all, and `nav` covers what goes IN it.
 * - **Dressing rather than replacing.** `pageHeader` in the shell config sets the header's
 *   variant, accent and title face; `hideControls` turns off search and filters. Reach for a
 *   slot only when you need your design system's own COMPONENT, not a recolour or a toggle.
 *
 * Keyed by the specifier as the IMPORTER writes it, because that is what `onResolve` sees. A
 * relative specifier is only meaningful next to the file that wrote it, so each entry also
 * carries the directory it must be imported from; otherwise a slot for `./page-header` would
 * also capture some future unrelated `./page-header` elsewhere in the tree. Two of them are
 * imported from `src/routes`, which is why the specifier climbs out of it.
 */
export const EDITOR_SLOTS = {
  /** The sticky panel with the screen's `<h1>` and its primary action. Export `PageHeader`. */
  pageHeader: { specifier: "./page-header", from: "src" },
  /** What `/` renders. Export `HomeScreen`. */
  home: { specifier: "../home-screen", from: "src/routes" },
  /** The way back and the title on a detail screen. Export `DetailHeader`. */
  detailHeader: { specifier: "./detail-header", from: "src" },
  /** The dialog frame around one media file. Export `MediaDetailFrame`. */
  mediaDetail: { specifier: "./media-detail", from: "src" },
  /** The media library grid and its empty state. Export `MediaGrid` and `MediaLibraryEmpty`. */
  mediaGrid: { specifier: "./media-grid", from: "src" },
  /** Hooks over the nav and the account menu. Export `navHooks`. */
  nav: { specifier: "../nav-hooks", from: "src/routes" },
} as const;

export type EditorSlot = keyof typeof EDITOR_SLOTS;

export interface BuildEditorOptions {
  /** Where `editor.js`, `editor.css` and the panel shims are written. */
  outdir: string;
  /**
   * The project whose `node_modules` supply `@podoba/*`, `react` and `react-dom`.
   *
   * Unset, nothing is redirected and the bundle is built against this package's own pinned
   * copies — byte-for-byte the published `dist/`. Set to your project root to make the editor
   * a real consumer of YOUR design system: one podoba generation in the page, one set of
   * tokens, and an editor that moves when your design system does.
   *
   * React is redirected together with podoba and not separately, because they are one
   * decision: podoba's components call hooks, so podoba and the React it links against have
   * to come from the same place or the first render throws "invalid hook call".
   */
  designSystem?: string;
  /**
   * The stylesheet to compile, as a path to your own Tailwind entry.
   *
   * Unset, this package's `src/app.css` is compiled: Tailwind, podoba's token vars, podoba's
   * `@theme`, plus the editor's own base rules.
   *
   * This is the OTHER HALF of `designSystem`, and it is a separate option because CSS is
   * compiled rather than linked, so no runtime mechanism can stand in for it — and because
   * Tailwind resolves a bare `@import` from the directory of the FILE that wrote it, not from
   * the process's cwd. Our `app.css` therefore always resolves podoba out of our
   * `node_modules`, wherever it is compiled from. A host's tokens can only reach the editor
   * through a stylesheet that lives in the host's own tree:
   *
   * ```css
   * @import "@pramen/cms-editor/app.css";  // the editor's base rules
   * @import "./tokens.css";                // yours, after ours, so yours win
   * ```
   */
  styles?: string;
  /**
   * Replace one of the editor's own modules with one of your own.
   *
   * Paths (absolute, or relative to the working directory) to modules exporting the same
   * names ours do: see `EDITOR_SLOTS` for the list, and type each module against its contract
   * from `@pramen/cms-editor/slots`. Your modules are bundled into the editor, so they import
   * `@podoba/react` and React like any other source (from your `designSystem` root when it is
   * set) and must not import the editor's own internals. This is the sanctioned form of the
   * thing a deployment was doing with `onResolve` against our internals: same mechanism, but
   * named, typechecked, and verified to still resolve, so a release that moves the module is a
   * build error here instead of a silent no-op in production.
   */
  slots?: Partial<Record<EditorSlot, string>>;
  /** Minify. Default true; the watch loop passes false and takes a linked sourcemap. */
  minify?: boolean;
  /** Emit a linked sourcemap beside the bundle. Default false. */
  sourcemap?: boolean;
  /**
   * Inline podoba's web font into the stylesheet as a data: URI.
   *
   * Default true only when neither `styles` nor `designSystem` is set — that is, for the
   * published `dist/`, which is re-hosted by strangers' bundlers and so must reference nothing
   * else. Any host build defaults to false: a host that named its own stylesheet has said what
   * face it wants, and appending ours AFTER it would win on `--font-sans` and silently undo
   * the choice.
   */
  inlineFonts?: boolean;
  /**
   * Extra Bun plugins, registered BEFORE this function's own.
   *
   * Bun takes the first `onResolve` that matches, so a caller's plugin wins — which is how the
   * in-repo build hands over `buzolaPlugin` to regenerate the route table from `src/routes`.
   * A host needs no plugin for that: the generated table ships in `src/buzola.gen.ts` and the
   * fallback below resolves the virtual module to it.
   */
  plugins?: BunPlugin[];
}

/**
 * Redirect the design system (and the React it needs) at a host's copies.
 *
 * `Bun.resolveSync` from the host root rather than an alias map, so subpaths come along
 * (`react/jsx-runtime`, `@podoba/react/anything`) and so a missing install fails HERE, naming
 * the specifier and the root, rather than resolving quietly to ours and shipping two podobas.
 */
function designSystemPlugin(root: string): BunPlugin {
  return {
    name: "pramen-editor-design-system",
    setup(build) {
      build.onResolve({ filter: /^(?:@podoba\/[^/]+|react|react-dom)(?:\/.*)?$/ }, ({ path }) => ({ path: resolveFrom(path, root) }));
    },
  };
}

/**
 * Resolve one specifier from the design system root, and say so plainly when it is not there.
 *
 * One helper for all three places a host root is read — the bundle's imports, the panel shims'
 * export lists, the inlined font — so a missing install reads the same wherever it is noticed
 * first. Bun's own message ("Cannot find package 'react' imported from /tmp/x") names the
 * directory but not what it was FOR, and `designSystem` is the only reason this package ever
 * resolves out of a stranger's tree.
 */
function resolveFrom(specifier: string, root: string): string {
  try {
    return Bun.resolveSync(specifier, root);
  } catch (cause) {
    throw new Error(`@pramen/cms-editor: the designSystem root ${root} cannot resolve "${specifier}" — the editor is built against your copies of podoba and React, so install it there`, { cause });
  }
}

/**
 * Put a host's module in place of one of ours.
 *
 * Scoped by importer, because the specifiers are relative: `./page-header` means our header
 * only when our own file wrote it. And the slot is CHECKED — if the importer we expect no
 * longer imports that specifier, nothing here matches and the host silently gets our
 * component back, which is precisely the failure mode this API exists to end. So the plugin
 * records what it matched and `buildEditor` throws on a slot that never fired.
 */
function slotsPlugin(slots: Partial<Record<EditorSlot, string>>, matched: Set<EditorSlot>): BunPlugin {
  return {
    name: "pramen-editor-slots",
    setup(build) {
      for (const [name, target] of Object.entries(slots) as [EditorSlot, string][]) {
        const slot = EDITOR_SLOTS[name];
        const from = resolve(PKG, slot.from);
        build.onResolve({ filter: new RegExp(`^${slot.specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }, ({ importer }) => {
          if (dirname(importer) !== from) return undefined;
          matched.add(name);
          // Absolute, because `onResolve` must hand back one; a relative target (the README's
          // own example is one) is taken from the working directory, like the other paths here.
          return { path: resolve(target) };
        });
      }
    },
  };
}

/**
 * The package's own public RUNTIME entries, pinned to the source this build is made of.
 *
 * A theme's slot imports `@pramen/cms-editor/i18n` by its package name, and the editor's own
 * files import the same module by a relative path. For the theme to speak the editor's
 * language those two have to be ONE module in the bundle: the locale is a page-load singleton
 * held in that module, so a second copy is a second, unconfigured editor language that still
 * type-checks, still builds, and renders English beside a Czech editor. Left to ordinary
 * resolution, the package name is resolved from the THEME's directory, and a theme package
 * that carries its own nested install (a version range that did not dedupe, a linked checkout)
 * reaches that copy instead. Pinning the specifier to this file makes "same instance" a
 * property of the build rather than of the host's lockfile. Type-only entries (`./slots`) need
 * no pin: they are erased.
 */
const SELF_ENTRIES: Readonly<Record<string, string>> = {
  "@pramen/cms-editor/i18n": "src/i18n/index.ts",
};

function selfEntriesPlugin(): BunPlugin {
  return {
    name: "pramen-editor-self-entries",
    setup(build) {
      build.onResolve({ filter: /^@pramen\/cms-editor\/[\w-]+$/ }, ({ path }) => {
        const file = SELF_ENTRIES[path];
        return file ? { path: resolve(PKG, file) } : undefined;
      });
    },
  };
}

/**
 * Resolve buzola's virtual route table to the one this package SHIPS.
 *
 * `main.tsx` imports `virtual:buzola/routes`, which in this repo is generated from `src/routes`
 * by `@buzola/bun-plugin` — a devDependency, and one a host has no reason to install. The
 * generated table is checked in and published in `src/`, so for anyone building from the
 * package it is already correct: the routes cannot have changed since the release they came
 * with. Registered last, so the in-repo build's real plugin takes precedence.
 */
function shippedRoutesPlugin(): BunPlugin {
  return {
    name: "pramen-editor-shipped-routes",
    setup(build) {
      build.onResolve({ filter: /^virtual:buzola\/routes$/ }, () => ({ path: resolve(PKG, "src/buzola.gen.ts") }));
    },
  };
}

/**
 * podoba's web font, as CSS with the binary inlined.
 *
 * @podoba/tokens ships `fonts.css` next to `./fonts/*.woff2` and leaves the relative `url()`
 * to the consumer's bundler. The published `editor.css` has no consumer bundler — it is
 * emitted as an opaque asset and re-hosted (fingerprinted, moved into `_astro/`) by whoever
 * serves it, which breaks any relative reference. Inlining costs ~68KB of base64 and makes
 * the stylesheet a single file that works wherever it lands.
 *
 * Read from the design system in force, so a host building against its own podoba inlines its
 * own face rather than ours.
 */
async function fontCss(root: string): Promise<string> {
  // RESOLVED, not joined onto `node_modules`. A package manager is free to hoist, dedupe or
  // link through a store — bun puts the real file under `node_modules/.bun/…` and leaves a
  // symlink — so a guessed path works only for the layout it was guessed against. `dirname`
  // of the resolved `fonts.css` is then the directory its own relative `url()`s are written
  // against, whatever that turns out to be.
  const file = resolveFrom("@podoba/tokens/fonts.css", root);
  const dir = dirname(file);
  const css = await readFile(file, "utf8");
  let out = css;
  for (const [match, rel] of css.matchAll(/url\(['"]?\.\/(fonts\/[^'")]+)['"]?\)/g)) {
    out = out.replace(match, `url('data:font/woff2;base64,${(await readFile(resolve(dir, rel))).toString("base64")}')`);
  }
  return out;
}

/**
 * Compile the stylesheet.
 *
 * The font block goes AFTER the compiled CSS, not before. Both declare `--font-sans` on
 * `:root`, so the later one wins — and `fonts.css`'s whole job is to point that token at the
 * real typeface. Linking them the other way round is how the bundled face got loaded and then
 * never used.
 */
async function styles(opts: BuildEditorOptions, dsRoot: string): Promise<void> {
  const out = resolve(opts.outdir, "editor.css");
  // Absolute before anything else: Tailwind runs with the entry's own directory as its cwd (so
  // its bare imports resolve from the host's tree), and a relative entry, which every other
  // path here accepts from the working directory, would be looked for again from inside it.
  const entry = opts.styles ? resolve(opts.styles) : resolve(PKG, "src/app.css");
  const args = ["@tailwindcss/cli", "-i", entry, "-o", out];
  if (opts.minify !== false) args.push("--minify");
  const proc = Bun.spawn(["bunx", ...args], { cwd: dirname(entry), stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error("@pramen/cms-editor: tailwind build failed");
  if (opts.inlineFonts ?? (!opts.styles && !opts.designSystem)) {
    await writeFile(out, `${await Bun.file(out).text()}\n${await fontCss(dsRoot)}`);
  }
}

/**
 * The four shims a panel bundle's bare imports resolve to — generated from the React that is
 * actually being bundled.
 *
 * `import(...)` through the design system root, not the bare specifier, for the invariant
 * `panel-globals.ts` is built on: the export list has to come off the very modules the editor
 * links, or a name missing from it becomes a browser link error in somebody else's panel. A
 * host build links the host's React, so the shims must be read off the host's React too.
 */
async function panelGlobals(outdir: string, dsRoot: string): Promise<void> {
  for (const shim of PANEL_GLOBAL_SHIMS) {
    const names = exportableNames(await import(resolveFrom(shim.specifier, dsRoot)));
    if (names.length === 0) throw new Error(`panel globals: ${shim.specifier} exported nothing to re-export`);
    await writeFile(resolve(outdir, shim.file), panelShimSource(shim, names, PANEL_RUNTIME_GLOBAL));
  }
}

/**
 * Build the editor into `outdir`.
 *
 * With only `outdir`, this is exactly what produces the published `dist/`.
 */
export async function buildEditor(opts: BuildEditorOptions): Promise<void> {
  const dsRoot = opts.designSystem ?? PKG;
  // Half-configured is the state worth naming, because it LOOKS like it worked: the bundle
  // renders the host's podoba components against our compiled tokens, so the editor comes up
  // and the colours are subtly not theirs. The two options are one decision (see `styles`),
  // and a build that made only one of them is more likely a forgotten line than an intent.
  if (opts.designSystem && !opts.styles) {
    console.warn("@pramen/cms-editor: `designSystem` is set but `styles` is not — the bundle will link your podoba while the stylesheet stays compiled against ours. Pass your own Tailwind entry too.");
  }
  // Checked up front, by name, for two slips the bundler would report badly: a key that is not
  // a slot (a typo, or a slot from a newer release) is otherwise silently ignored, and a target
  // that does not exist surfaces as an unresolved import deep inside one of our files, naming
  // our source and not the host's config line.
  for (const [name, target] of Object.entries(opts.slots ?? {})) {
    if (!(name in EDITOR_SLOTS)) {
      throw new Error(`@pramen/cms-editor: unknown slot "${name}". This release has: ${Object.keys(EDITOR_SLOTS).join(", ")}.`);
    }
    if (typeof target !== "string" || !(await Bun.file(resolve(target)).exists())) {
      throw new Error(`@pramen/cms-editor: slot "${name}" points at ${JSON.stringify(target)}, which does not exist (relative paths resolve from the working directory, ${process.cwd()}).`);
    }
  }
  await mkdir(opts.outdir, { recursive: true });
  await styles(opts, dsRoot);
  await panelGlobals(opts.outdir, dsRoot);

  const matched = new Set<EditorSlot>();
  const slots = opts.slots ?? {};
  const out = await Bun.build({
    entrypoints: [resolve(PKG, "src/main.tsx")],
    outdir: opts.outdir,
    target: "browser",
    minify: opts.minify !== false,
    sourcemap: opts.sourcemap ? "linked" : "none",
    // A STABLE name, not a content hash. The host's bundler emits this file as an asset and
    // fingerprints it there; hashing here as well would mean the filename changed on every
    // build and no import specifier could name it.
    naming: { entry: "editor.[ext]" },
    // React reads `process.env.NODE_ENV` to decide which of its two builds it is. Unset, the
    // bundler leaves the expression in, nothing is eliminated, and the DEVELOPMENT build ships:
    // ~268KB (19%) of extra bytes, the dev-only warning machinery, and the slower paths it
    // exists to make debuggable. Tied to `minify`, because that is already the flag that means
    // "this is the build someone will be served" — the watch loop wants the dev build and its
    // warnings, and gets them.
    define: { "process.env.NODE_ENV": JSON.stringify(opts.minify === false ? "development" : "production") },
    plugins: [
      ...(opts.plugins ?? []),
      selfEntriesPlugin(),
      ...(Object.keys(slots).length > 0 ? [slotsPlugin(slots, matched)] : []),
      ...(opts.designSystem ? [designSystemPlugin(opts.designSystem)] : []),
      shippedRoutesPlugin(),
    ],
  });
  if (!out.success) {
    for (const log of out.logs) console.error(log);
    throw new Error("@pramen/cms-editor: build failed");
  }
  // A slot that never matched means the module it targets no longer imports that specifier —
  // a release moved it. Loud here, because the alternative is a host shipping our component
  // under the impression it shipped theirs.
  for (const name of Object.keys(slots) as EditorSlot[]) {
    if (!matched.has(name)) {
      throw new Error(`@pramen/cms-editor: slot "${name}" matched nothing — this release no longer imports "${EDITOR_SLOTS[name].specifier}" from ${EDITOR_SLOTS[name].from}/. Review the slot against this version.`);
    }
  }
}
