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
import { join, resolve } from "node:path";
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
