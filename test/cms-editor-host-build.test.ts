// `buildEditor` — the editor's build as an API a host can call, proved where it matters.
//
// Two of its options are promises about LINKING, and neither fails visibly when it stops
// working. `designSystem` says "bundle against my podoba, not yours": broken, the build still
// succeeds and still produces a working editor — wearing the wrong design system, which is a
// screenshot's worth of difference nobody reads as a build regression. `slots` says "render my
// component instead of yours": broken, the host ships OUR header believing it shipped theirs.
//
// So neither is tested by asserting the build exits zero. Each is tested by putting a MARKER
// on the far side of the link and looking for it in the emitted bundle: a podoba whose `Button`
// stamps an attribute, a header module with a string in it. If the redirect did not happen, the
// marker is not there, and that is the whole assertion.
//
// Built with `minify: false` throughout, because the markers have to survive to be looked for
// and identifiers are what minification takes first.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildEditor, EDITOR_SLOTS, type EditorSlot } from "../packages/cms-editor/src/build-editor";

const EDITOR = resolve(import.meta.dir, "../packages/cms-editor");

/** Scratch dirs under the EDITOR package's own `node_modules/`, not the system temp.
 *
 * Load-bearing, for the same reason `cms-editor-panel-globals.test.ts` says so: the whole
 * subject is module resolution, and a fake `@podoba/react` only shadows the real one when it
 * sits in a `node_modules` the resolver reaches BEFORE the editor's. Inside the editor's own
 * tree, `react` and `react-dom` still resolve by walking up — which is what a real host's root
 * does too, and what the build needs, since podoba's components call hooks. */
const dirs: string[] = [];
async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(EDITOR, "node_modules", `.test-${prefix}-`));
  dirs.push(dir);
  return dir;
}
/** The one case that needs a root with nothing above it — see the resolve-failure test. */
const outside: string[] = [];
afterAll(async () => {
  for (const dir of [...dirs, ...outside]) await rm(dir, { recursive: true, force: true });
});

/**
 * A design-system root whose `@podoba/react` is the real one with a fingerprint on `Button`.
 *
 * Re-exported rather than reimplemented, because the editor imports a dozen names from podoba
 * and a stub would fail to LINK — which would prove nothing about the redirect, only that the
 * stub was incomplete. `export *` carries every real name; the explicit `Button` declaration
 * shadows the star for that one, so the editor's own `<Button>` call sites (components.tsx)
 * render through the wrapper and drag the marker into the bundle.
 *
 * On `Button` specifically because it is used, and an unused marker export is the one thing
 * tree-shaking is guaranteed to remove.
 */
const MARKER = "data-host-podoba-marker";
async function hostDesignSystem(): Promise<string> {
  const root = await scratch("ds");
  const real = Bun.resolveSync("@podoba/react", EDITOR);
  const pkg = join(root, "node_modules", "@podoba", "react");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@podoba/react", version: "0.0.0-test", type: "module", main: "index.jsx" }));
  await writeFile(
    join(pkg, "index.jsx"),
    `export * from ${JSON.stringify(real)};\n` +
      `import { Button as Real } from ${JSON.stringify(real)};\n` +
      `export function Button(props) { return <Real {...props} ${MARKER}="yes" />; }\n`,
  );
  return root;
}

/** Build into a scratch outdir and hand back the bundle's text. */
async function build(opts: Omit<Parameters<typeof buildEditor>[0], "outdir">): Promise<string> {
  const outdir = await scratch("out");
  await buildEditor({ outdir, minify: false, ...opts });
  return readFile(join(outdir, "editor.js"), "utf8");
}

/**
 * A theme: one module per slot, each typed against `@pramen/cms-editor/slots` and built from
 * podoba, with a marker so the bundle can be searched for it. Nothing in here reaches into our
 * source by a relative path; that is the constraint a real theme package lives under, and the
 * typecheck test below holds these to it.
 */
const THEME: Record<EditorSlot, [string, string]> = {
  pageHeader: ["page-header.tsx", `import type { PageHeaderProps } from "@pramen/cms-editor/slots";
export function PageHeader({ lead, em, children }: PageHeaderProps) { return <div data-theme-slot="pageHeader">{lead}{em}{children}</div>; }
`],
  home: ["home.tsx", `import type { HomeScreenProps } from "@pramen/cms-editor/slots";
import { defineMessages, useI18n, useLocale } from "@pramen/cms-editor/i18n";
import { Button } from "@podoba/react";
const copy = defineMessages({
  en: { hello: "theme-slot-i18n-hello", files: { one: "{count} file", other: "{count} files" } },
  cs: { hello: "Ahoj", files: { one: "{count} soubor", few: "{count} soubory", many: "{count} souboru", other: "{count} souborů" } },
});
export function HomeScreen({ landing, pageList, href, navigate }: HomeScreenProps) {
  const { t } = useI18n();
  return <div data-theme-slot="home" data-theme-locale={useLocale()}><a href={href("media")}>{t("common.close")}</a>{copy.t("hello")} {copy.tp("files", 3)}<Button onPress={() => navigate("schema")}>{landing.kind}</Button>{pageList}</div>;
}
`],
  detailHeader: ["detail-header.tsx", `import type { DetailHeaderProps } from "@pramen/cms-editor/slots";
export function DetailHeader({ title, parent, href, onBack, children }: DetailHeaderProps) {
  return <header data-theme-slot="detailHeader"><a href={href} onClick={(e) => { e.preventDefault(); onBack(); }}>{parent}</a><h1>{title}</h1>{children}</header>;
}
`],
  mediaDetail: ["media-detail.tsx", `import type { MediaDetailFrameProps } from "@pramen/cms-editor/slots";
import { Dialog } from "@podoba/react";
export function MediaDetailFrame({ title, preview, details, actions, onClose, closeLabel }: MediaDetailFrameProps) {
  return <Dialog isOpen title={title} closeLabel={closeLabel} onOpenChange={(o) => !o && onClose()}><div data-theme-slot="mediaDetail"><section>{preview}</section><aside>{details}{actions}</aside></div></Dialog>;
}
`],
  mediaGrid: ["media-grid.tsx", `import type { MediaGridProps, MediaLibraryEmptyProps } from "@pramen/cms-editor/slots";
export function MediaGrid({ label, tiles }: MediaGridProps) {
  return <ul aria-label={label} data-theme-slot="mediaGrid">{tiles.map((t) => <li key={t.id}><button onClick={t.onOpen}>{t.src ? <img src={t.src} alt={t.alt} /> : t.ext}</button>{t.filename} {t.sizeLabel}</li>)}</ul>;
}
export function MediaLibraryEmpty({ title, description }: MediaLibraryEmptyProps) { return <p data-theme-slot="mediaLibraryEmpty">{title}{description}</p>; }
`],
  nav: ["nav.ts", `import { EDITOR_PAGES, type NavHooks } from "@pramen/cms-editor/slots";
export const navHooks: NavHooks = {
  transformNav: ({ sections, active }) => ({ sections: sections.map((s) => ({ ...s, label: "theme-slot-nav:" + s.label })), active }),
  accountMenu: [{ label: "theme-slot-account", page: "schema", requiresNav: "types", visible: () => EDITOR_PAGES.includes("schema") }],
};
`],
};

async function writeTheme(dir: string): Promise<Partial<Record<EditorSlot, string>>> {
  const slots: Partial<Record<EditorSlot, string>> = {};
  for (const [name, [file, source]] of Object.entries(THEME) as [EditorSlot, [string, string]][]) {
    await writeFile(join(dir, file), source);
    slots[name] = join(dir, file);
  }
  return slots;
}

describe("buildEditor", () => {
  test("with no options it emits the published shape", async () => {
    const outdir = await scratch("default");
    await buildEditor({ outdir, minify: false });
    for (const file of ["editor.js", "editor.css", "panel-react.js", "panel-react-dom.js", "panel-jsx-runtime.js", "panel-jsx-dev-runtime.js"]) {
      expect(await Bun.file(join(outdir, file)).exists()).toBe(true);
    }
    // The stylesheet is Tailwind plus podoba's tokens plus the inlined face — all three, or
    // the editor renders unstyled and this test would have said it was fine.
    const css = await readFile(join(outdir, "editor.css"), "utf8");
    expect(css).toContain("--color-surface");
    expect(css).toContain("data:font/woff2;base64,");
  }, 60_000);

  test("designSystem links the HOST's podoba, not ours", async () => {
    const root = await hostDesignSystem();
    expect(await build({ designSystem: root })).toContain(MARKER);
  }, 60_000);

  test("without designSystem the host's podoba is not reachable", async () => {
    // The negative half. Without it, a marker that leaked in some other way (a stale outdir, a
    // shared cache) would make the test above pass while the option did nothing.
    await hostDesignSystem();
    expect(await build({})).not.toContain(MARKER);
  }, 60_000);

  test("designSystem that cannot resolve fails the build, naming what and where", async () => {
    // OUTSIDE the repo, unlike every other scratch dir here, and that is the point of the
    // case. Node resolution walks UP, so a root nested under our own `node_modules` finds our
    // podoba and the build quietly succeeds against it — correct semantics, and the reason
    // this cannot be checked from in here. A host root is somewhere else entirely; a temp dir
    // with nothing above it is the only faithful stand-in.
    const root = await mkdtemp(join(tmpdir(), "pramen-ds-"));
    outside.push(root);
    const outdir = await scratch("out-fail");
    const failed = await buildEditor({ outdir, minify: false, designSystem: root }).catch((e: Error) => e);
    expect(failed).toBeInstanceOf(Error);
    // Names the root AND says what it was being read for. Bun's own message ("Cannot find
    // package 'react' imported from /tmp/x") names the directory and leaves the reader to
    // work out why this package was resolving anything out of /tmp at all.
    expect((failed as Error).message).toContain(root);
    expect((failed as Error).message).toContain("designSystem");
  }, 60_000);

  test("a slot replaces our component with the host's", async () => {
    const dir = await scratch("slot");
    const slot = join(dir, "page-header.jsx");
    await writeFile(slot, `export function PageHeader({ lead, em, children }) { return <div data-host-header="yes">{lead}{em}{children}</div>; }\n`);
    const js = await build({ slots: { pageHeader: slot } });
    expect(js).toContain("data-host-header");
    // And ours is GONE. Asserting only the marker's presence would pass with both headers in
    // the bundle and one of them dead — which is a 190px sticky panel's worth of CSS and a
    // scroll listener still shipped, and the sign that the slot resolved for one importer and
    // not the other.
    expect(js).not.toContain("useCondensed");
    // The theme's `@pramen/cms-editor/i18n` and the editor's `./i18n` are one module.
    expect(js.split("cms-editor/src/i18n/index.ts\n").length - 1).toBe(1);
  }, 60_000);

  test("every slot still names a module the editor imports", async () => {
    // The mirror half of the runtime guard in `buildEditor`. That throw catches a release that
    // moved a module, but only for someone who builds with the slot set; this catches it here,
    // in our own suite, on the commit that moves it. A slot whose specifier nothing imports is
    // an API we are still advertising and quietly no longer honouring.
    for (const [name, slot] of Object.entries(EDITOR_SLOTS) as [EditorSlot, (typeof EDITOR_SLOTS)[EditorSlot]][]) {
      const from = resolve(EDITOR, slot.from);
      const importers = [...new Bun.Glob("*.{ts,tsx}").scanSync(from)];
      const importing = [];
      for (const file of importers) {
        if ((await readFile(join(from, file), "utf8")).includes(`from "${slot.specifier}"`)) importing.push(file);
      }
      expect(importing, `slot "${name}" (${slot.specifier} from ${slot.from}/)`).not.toBeEmpty();
    }
  });

  test("every slot filled by a theme, through public imports only, lands in the bundle", async () => {
    // What a theme package actually is: one module per slot, typed against
    // `@pramen/cms-editor/slots` and built from podoba, and nothing reached through a relative
    // path into our source. Each fixture carries a marker; the assertion is that every marker
    // made it into the bundle, which is only possible if every slot resolved to the fixture.
    // The `nav` fixture also IMPORTS A VALUE from the public entry, so the export map itself
    // is exercised, not just the type graph.
    const dir = await scratch("theme");
    // A new slot without a fixture here would pass this test by omission.
    expect(Object.keys(THEME).sort()).toEqual(Object.keys(EDITOR_SLOTS).sort());
    const slots = await writeTheme(dir);
    const js = await build({ slots });
    for (const marker of ["pageHeader", "home", "detailHeader", "mediaDetail", "mediaGrid", "mediaLibraryEmpty"]) {
      expect(js, marker).toContain(`"data-theme-slot": "${marker}"`);
    }
    expect(js).toContain("theme-slot-nav:");
    expect(js).toContain("theme-slot-account");
    // And the defaults are GONE, which is what shows the slot replaced rather than joined.
    // An unminified bundle opens each module with a `// <path>` comment, so a default that was
    // still linked for some importer would still be named here.
    for (const file of ["page-header.tsx", "home-screen.tsx", "detail-header.tsx", "media-detail.tsx", "media-grid.tsx", "nav-hooks.ts"]) {
      expect(js, file).not.toContain(`cms-editor/src/${file}\n`);
    }
    expect(js).not.toContain("useCondensed");
  }, 60_000);

  test("a theme's i18n import is the editor's own module, even from a nested copy of the package", async () => {
    // The locale lives in ONE module instance, so a slot reads the editor's language only if
    // its `@pramen/cms-editor/i18n` is the same module the editor's own files import by a
    // relative path. Resolved from the theme's directory, the package name can reach a
    // different install: here a nested `node_modules/@pramen/cms-editor` next to the theme,
    // which is what a theme package with its own dependency on the editor looks like. Its i18n
    // entry answers a marker locale. `buildEditor` pins the specifier to its own source, so the
    // marker must NOT be in the bundle, and the real module must be in it exactly once.
    // Under the REPO root's `node_modules`, not the editor's: inside the editor package, Bun
    // resolves `@pramen/cms-editor/*` as a self-reference to that package before it looks at
    // any nested `node_modules`, so the stray copy would never be reached and the test would
    // pass with or without the pin.
    const dir = await mkdtemp(join(EDITOR, "..", "..", "node_modules", ".test-theme-i18n-"));
    outside.push(dir);
    const nested = join(dir, "node_modules", "@pramen", "cms-editor");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "package.json"), JSON.stringify({ name: "@pramen/cms-editor", version: "0.0.0-nested", type: "module", exports: { "./i18n": "./i18n.ts", "./slots": "./slots.ts" } }));
    await writeFile(join(nested, "i18n.ts"), `export const useLocale = () => "nested-copy-locale"; export const useI18n = () => ({ t: (k: string) => k }); export const defineMessages = (c: any) => ({ t: (k: string) => c.en[k], tp: (k: string) => k });\n`);
    await writeFile(join(nested, "slots.ts"), `export {};\n`);
    // The theme's home screen without podoba, which is not installed at the repo root.
    const file = join(dir, "home.tsx");
    await writeFile(file, THEME.home[1].replace(`import { Button } from "@podoba/react";\n`, "").replaceAll("Button", "button").replace("onPress=", "onClick="));
    const js = await build({ slots: { home: file } });
    expect(js).toContain("theme-slot-i18n-hello");
    expect(js).not.toContain("nested-copy-locale");
    // An unminified bundle opens each module with a `// <path>` comment: one comment, one module.
    expect(js.split("cms-editor/src/i18n/index.ts\n").length - 1).toBe(1);
  }, 60_000);

  test("a theme typechecks against the public contracts alone, strictly", async () => {
    // The other half of "public imports only": the contracts have to TYPECHECK from outside,
    // under a stricter config than ours, with no route table, no app context and no path into
    // `src/` other than the published `./slots` entry. A contract that leaked an internal type
    // (the router's page map, the `Api` class) would fail here, not in a theme's CI. Not
    // `exactOptionalPropertyTypes`: podoba ships TypeScript source that does not compile under
    // it, so no theme built on podoba can turn it on either.
    const dir = await scratch("theme-tsc");
    await writeTheme(dir);
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2022", module: "esnext", moduleResolution: "bundler", jsx: "react-jsx", lib: ["es2022", "dom"],
          strict: true, noEmit: true, skipLibCheck: true, verbatimModuleSyntax: true, noUncheckedIndexedAccess: true,
          types: [],
        },
        include: ["*.ts", "*.tsx"],
      }),
    );
    const tsc = Bun.spawn(["bunx", "tsc", "-p", dir], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(tsc.stdout).text();
    expect(out).toBe("");
    expect(await tsc.exited).toBe(0);
  }, 60_000);

  test("a relative `styles` path is taken from the working directory, like every other path", async () => {
    // Tailwind is spawned with the entry's own directory as its cwd, so a relative entry used to
    // be looked for a second time from inside that directory, and the build failed with
    // "input file does not exist" for a file that was right there.
    const dir = await scratch("rel-styles");
    const file = join(dir, "host.css");
    await writeFile(file, `@import "../../src/app.css";\n.host-relative-marker { color: red; }\n`);
    const outdir = join(dir, "out");
    await buildEditor({ outdir, minify: false, styles: relative(process.cwd(), file) });
    expect(await readFile(join(outdir, "editor.css"), "utf8")).toContain(".host-relative-marker");
  }, 60_000);

  test("a slot whose module does not exist fails before building, naming the slot", async () => {
    const outdir = await scratch("missing");
    const failed = await buildEditor({ outdir, minify: false, slots: { mediaGrid: join(outdir, "nope.tsx") } }).catch((e: Error) => e);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain('slot "mediaGrid"');
    expect((failed as Error).message).toContain("does not exist");
    // Before the slow half: nothing was written.
    expect(await Bun.file(join(outdir, "editor.css")).exists()).toBe(false);
  });

  test("an unknown slot name is an error, not an ignored key", async () => {
    const outdir = await scratch("unknown");
    const failed = await buildEditor({ outdir, minify: false, slots: { dashboard: join(outdir, "x.tsx") } as never }).catch((e: Error) => e);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain('unknown slot "dashboard"');
  });

  test("EVERY slot that stops matching is an error, not a silent fallback", async () => {
    // The guard below, for each slot rather than only the first one it was written for: shadow
    // the specifier with an earlier plugin, which is what a release that moved the module looks
    // like from the slot's side.
    for (const [name, slot] of Object.entries(EDITOR_SLOTS) as [EditorSlot, (typeof EDITOR_SLOTS)[EditorSlot]][]) {
      const dir = await scratch(`noslot-${name}`);
      const target = join(dir, "slot.tsx");
      await writeFile(target, "export {};\n");
      const real = resolve(EDITOR, slot.from, slot.specifier);
      const shadow = {
        name: `test-shadow-${name}`,
        setup(b: Bun.PluginBuilder) {
          b.onResolve({ filter: new RegExp(`^${slot.specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }, () => ({ path: Bun.resolveSync(real, EDITOR) }));
        },
      };
      const failed = await build({ slots: { [name]: target }, plugins: [shadow] }).catch((e: Error) => e);
      expect(failed, name).toBeInstanceOf(Error);
      expect((failed as Error).message, name).toContain(`slot "${name}"`);
    }
  }, 120_000);

  test("a slot that matches nothing is an error, not a silent fallback", async () => {
    // The failure this guard exists for, reproduced the only way the API allows: a slot whose
    // target is never reached because the specifier is resolved by an earlier plugin. Same
    // observable as a release that renamed the module — nothing matched — and it must be loud,
    // because the alternative is a host shipping our header under the impression it shipped
    // theirs.
    const dir = await scratch("noslot");
    const slot = join(dir, "page-header.jsx");
    await writeFile(slot, `export function PageHeader() { return null; }\n`);
    const shadow = {
      name: "test-shadow-page-header",
      setup(b: Bun.PluginBuilder) {
        b.onResolve({ filter: /^\.\/page-header$/ }, () => ({ path: resolve(EDITOR, "src/page-header.tsx") }));
      },
    };
    const failed = await build({ slots: { pageHeader: slot }, plugins: [shadow] }).catch((e: Error) => e);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain('slot "pageHeader"');
  }, 60_000);
});

describe("the in-repo build still owns dist/", () => {
  test("scripts/build.ts hands over the route-table plugin", async () => {
    // `buildEditor` falls back to the route table SHIPPED in src/, which is right for a host
    // and wrong for us: in this repo the table is generated from `src/routes`, so a new route
    // would not appear until someone remembered to regenerate. The handover is what keeps the
    // published bundle's routes derived from the directory.
    const script = await readFile(join(EDITOR, "scripts/build.ts"), "utf8");
    expect(script).toContain("buzolaPlugin({ root })");
  });
});
