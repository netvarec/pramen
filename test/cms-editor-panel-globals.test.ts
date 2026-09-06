// The shared-React mechanism, proved end to end.
//
// A panel is a project's own React screen, built as its own bundle and rendered inside the
// editor's tree. The one thing that has to work for that to be possible is that the panel's
// `import { useState } from "react"` resolves to the editor's React and not to a second
// copy — two copies share no hook dispatcher, so the failure is not "slower" or "bigger",
// it is an "invalid hook call" exception on the panel's first render.
//
// That mechanism is three parts (the runtime published on a global, a generated shim per
// specifier, and an import map in the shell wiring the two together), and none of them fails
// visibly on its own: the shim's export list is generated, so a missing name is a browser
// link error in someone else's bundle; a shim that reads the wrong key returns `undefined`
// and blames React. So the test is the whole chain, not the pieces — build a real panel
// bundle with react marked EXTERNAL, resolve those externals through the generated shims,
// import it with the runtime published, and check that the hook it got is the very function
// the editor exported.
//
// The import map is the one link a Bun test cannot execute (it is an HTML feature). It is
// stood in for by rewriting the same bare specifiers to the same generated files — which is
// exactly what `adminImportMap` tells the browser to do, and
// `test/cms-astro-integration.test.ts` pins that it says so.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as react from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as reactDom from "react-dom";
import { exportableNames, panelShimSource, PANEL_GLOBAL_SHIMS, type ModuleNamespace, type PanelGlobalShim } from "../packages/cms-editor/src/panel-globals";
import { PANEL_RUNTIME_CONTRACT, PANEL_RUNTIME_GLOBAL, panelRuntime, type PanelRuntimeHost } from "../packages/cms-editor/src/panel-runtime";
import { getPanel, registerPanel, resetPanels, type PanelDefinition } from "../packages/cms-editor/src/panels";

/** The namespace behind one shim's runtime key — the same four the editor publishes. */
function namespaceFor(key: PanelGlobalShim["runtimeKey"]): ModuleNamespace {
  if (key === "react") return react;
  if (key === "reactDom") return reactDom;
  return key === "jsxRuntime" ? jsxRuntime : jsxDevRuntime;
}

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Scratch dir for one case's shims and bundle.
 *
 * Under the repo's own `node_modules/` rather than in the system temp, and that is
 * load-bearing rather than tidy: a panel is built where react IS installed (it is the
 * consumer's project), and marking a specifier external only comes up AFTER the bundler has
 * resolved it. From a directory with no `node_modules` above it, Bun cannot resolve the JSX
 * runtime it injects itself and the build fails before externals are consulted — which would
 * make this test a statement about temp directories rather than about the mechanism.
 * `node_modules` is ignored by git and emptied in `afterAll`. */
const SCRATCH_ROOT = join(import.meta.dir, "..", "node_modules");

/** Write the shims exactly as the build does, into a scratch dir. */
async function writeShims(): Promise<string> {
  const dir = await mkdtemp(join(SCRATCH_ROOT, ".pramen-panel-"));
  dirs.push(dir);
  for (const shim of PANEL_GLOBAL_SHIMS) {
    await writeFile(join(dir, shim.file), panelShimSource(shim, exportableNames(namespaceFor(shim.runtimeKey)), PANEL_RUNTIME_GLOBAL));
  }
  return dir;
}

describe("what a shim re-exports", () => {
  test("the list is read off the module's real exports, through the CJS interop", () => {
    // Synthetic, because the property being pinned is invisible against React itself: its
    // namespace and its `module.exports` carry the same names, so skipping the unwrap looks
    // identical there and would only diverge on some future build of some other bundler.
    expect(exportableNames({ default: { alpha: 1, beta: 2 } as unknown as ModuleNamespace, gamma: 3 } as ModuleNamespace)).toEqual(["alpha", "beta"]);
  });

  test("`default` and React's internals are never named", () => {
    // `default` is a keyword — naming it would emit `export const { default } = m`, which does
    // not parse — and it has its own `export default` line. `__`-prefixed keys are React's
    // interop bookkeeping and internals, which are nobody's API.
    expect(exportableNames({ alpha: 1, default: undefined, __esModule: true, __CLIENT_INTERNALS: {} } as ModuleNamespace)).toEqual(["alpha"]);
    // Not an identifier at all — it could not be destructured.
    expect(exportableNames({ "not-an-identifier": 1, ok: 2 } as ModuleNamespace)).toEqual(["ok"]);
  });

  test("re-export every name the editor's React actually has", () => {
    // The point of generating them. A hand-written list is a copy of React's export table
    // that drifts silently — and drifts into a browser link error in a consumer's panel, not
    // into anything this repo would notice.
    const names = exportableNames(react);
    expect(names).toContain("useState");
    expect(names).toContain("useSyncExternalStore");
    expect(names).toContain("createContext");
    // …and nothing that is not a name a panel may import.
    expect(names).not.toContain("default");
    expect(names.some((n) => n.startsWith("__"))).toBe(false);
  });

  test("the jsx runtime shims carry what the automatic transform emits", () => {
    const names = exportableNames(jsxRuntime);
    // A panel bundle does not choose these imports — its compiler does. Missing `jsxs` is a
    // panel that renders a single child and blank-screens on a list.
    expect(names).toEqual(expect.arrayContaining(["jsx", "jsxs", "Fragment"]));
    // The DEV half is the one that matters most, and it is the least obvious: without it an
    // unminified panel build resolves `react/jsx-dev-runtime` from the consumer's own
    // node_modules and quietly ships a second React.
    const dev = exportableNames(jsxDevRuntime);
    expect(dev).toContain("jsxDEV");
    expect(PANEL_GLOBAL_SHIMS.map((s) => s.specifier)).toContain("react/jsx-dev-runtime");
  });

  test("react-dom is shared too, which is where a panel's dialog comes from", () => {
    const names = exportableNames(reactDom);
    // A panel bundling its own react-dom is a SECOND RECONCILER driving one React, which is
    // worse than a second React because it can appear to work.
    expect(names).toContain("createPortal");
  });

  test("each shim reads ITS OWN namespace off the runtime", async () => {
    // The link that is invisible if you only check that a panel builds: every shim is
    // generated from one template, so a template that names a fixed key instead of the
    // shim's own produces four files that all hand out React — and a panel's `createPortal`
    // becomes `undefined`, which reads as a React bug rather than a build one.
    const dir = await writeShims();
    (globalThis as PanelRuntimeHost)[PANEL_RUNTIME_GLOBAL] = panelRuntime();
    const r = (await import(join(dir, "panel-react.js"))) as { useState?: unknown };
    const rd = (await import(join(dir, "panel-react-dom.js"))) as { createPortal?: unknown };
    const j = (await import(join(dir, "panel-jsx-runtime.js"))) as { jsx?: unknown };
    const jd = (await import(join(dir, "panel-jsx-dev-runtime.js"))) as { jsxDEV?: unknown };
    expect(r.useState).toBe(react.useState);
    expect(rd.createPortal).toBe(reactDom.createPortal);
    expect(typeof j.jsx).toBe("function");
    expect(typeof jd.jsxDEV).toBe("function");
  });

  test("a shim hands out the module's exports, not the namespace around them", async () => {
    // Synthetic again, and for the same reason: React's namespace and its `module.exports`
    // agree, so the unwrap is unobservable against the real thing. Where they DISAGREE — any
    // other interop, any other bundler — reading the namespace would hand a panel a
    // different object than `require` would, and the names written into the file were read
    // off the unwrapped one.
    const dir = await writeShims();
    const source = panelShimSource({ file: "x.js", specifier: "x", runtimeKey: "react" }, ["marker"], "PRAMEN_PANEL_FAKE_RUNTIME");
    const file = join(dir, "unwrap.js");
    await writeFile(file, source);
    (globalThis as Record<string, unknown>).PRAMEN_PANEL_FAKE_RUNTIME = { react: { default: { marker: "unwrapped" }, marker: "raw" } };
    const mod = (await import(file)) as { marker?: unknown };
    expect(mod.marker).toBe("unwrapped");
    delete (globalThis as Record<string, unknown>).PRAMEN_PANEL_FAKE_RUNTIME;
  });

  test("a shim says what is wrong when there is no editor on the page", async () => {
    const dir = await writeShims();
    const host = globalThis as PanelRuntimeHost;
    const saved = host[PANEL_RUNTIME_GLOBAL];
    delete host[PANEL_RUNTIME_GLOBAL];
    try {
      // The first module a panel imports, so the only place this can be reported as itself
      // rather than as `Cannot read properties of undefined` from inside a stranger's bundle.
      await expect(import(`${join(dir, "panel-react.js")}?nohost`)).rejects.toThrow(/no editor runtime on this page/);
    } finally {
      if (saved !== undefined) host[PANEL_RUNTIME_GLOBAL] = saved;
    }
  });
});

describe("a panel bundle built against the editor's React", () => {
  /** Build a panel the way a consumer does — externals and all — then resolve those externals
   * the way the shell's import map would. */
  async function buildPanel(dir: string, name: string, minify: boolean): Promise<string> {
    const entry = join(dir, `${name}.tsx`);
    // An ordinary React component. Nothing in this source says "panel" except the one
    // registration call — which is the property that makes an existing screen portable
    // rather than rewritable.
    await writeFile(
      entry,
      `import { useState } from "react";
       import { createPortal } from "react-dom";
       export const hookSeen = useState;
       export const portalSeen = createPortal;
       function Curation() { const [n] = useState(0); return <div>{n}</div>; }
       export const element = <Curation />;
       globalThis.${PANEL_RUNTIME_GLOBAL}.registerPanel({ slug: "${name}", render: Curation });
      `,
    );
    const built = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      minify,
      // THE contract a consumer's build has to honour, and the whole of it — taken from the
      // shim set rather than written out, so the docs, the import map and this cannot drift.
      external: PANEL_GLOBAL_SHIMS.map((s) => s.specifier),
    });
    expect(built.success).toBe(true);
    let code = await built.outputs[0]!.text();
    for (const shim of PANEL_GLOBAL_SHIMS) code = code.replaceAll(`"${shim.specifier}"`, `"${join(dir, shim.file)}"`);
    // The stand-in has to be TOTAL, or this proves nothing: a specifier left bare would
    // resolve from the repo's own node_modules and the panel would quietly link against a
    // second React — which is the failure the whole mechanism exists to prevent.
    for (const shim of PANEL_GLOBAL_SHIMS) expect(code).not.toContain(`"${shim.specifier}"`);
    const out = join(dir, `${name}.js`);
    await writeFile(out, code);
    return out;
  }

  test("gets the editor's own hooks, and registers itself", async () => {
    resetPanels();
    const dir = await writeShims();
    // The editor's boot, in one line: publish the runtime, then import the bundle.
    (globalThis as PanelRuntimeHost)[PANEL_RUNTIME_GLOBAL] = panelRuntime();
    const mod = (await import(await buildPanel(dir, "curation", true))) as { hookSeen: unknown; portalSeen: unknown; element: unknown };

    // Not "a React", THE React: identity, because a second copy would satisfy any weaker
    // assertion and still throw on the panel's first hook.
    expect(mod.hookSeen).toBe(react.useState);
    expect(mod.portalSeen).toBe(reactDom.createPortal);
    // …and its JSX produced an element this React recognises as its own.
    expect(react.isValidElement(mod.element)).toBe(true);
    // …and the registration reached the registry the route reads.
    expect(getPanel("curation")?.slug).toBe("curation");
    resetPanels();
  }, 30_000);

  test("an UNMINIFIED build links too — the jsx-dev-runtime footgun", async () => {
    // The one that would have shipped broken. A development build emits
    // `react/jsx-dev-runtime`; unmapped, that is the single bare import that still RESOLVES —
    // from the consumer's own node_modules — so the panel gets a second React and the first
    // hook throws, on exactly the build a developer iterates against.
    resetPanels();
    const dir = await writeShims();
    (globalThis as PanelRuntimeHost)[PANEL_RUNTIME_GLOBAL] = panelRuntime();
    const mod = (await import(await buildPanel(dir, "rota", false))) as { element: unknown };
    expect(react.isValidElement(mod.element)).toBe(true);
    expect(getPanel("rota")?.slug).toBe("rota");
    resetPanels();
  }, 30_000);
});

describe("the published runtime", () => {
  test("is the names a panel needs, and no more", () => {
    // Every key here is something this package can never move again, so the set is pinned:
    // adding one is a decision, and this test is where it gets made rather than noticed.
    expect(Object.keys(panelRuntime()).sort()).toEqual(["contract", "jsxDevRuntime", "jsxRuntime", "react", "reactDom", "registerPanel"]);
    expect(panelRuntime().contract).toBe(PANEL_RUNTIME_CONTRACT);
  });

  test("hands out the same React the editor renders with", () => {
    const rt = panelRuntime();
    expect(rt.react).toBe(react);
    expect(rt.reactDom).toBe(reactDom);
    expect(rt.jsxRuntime).toBe(jsxRuntime);
    expect(rt.jsxDevRuntime).toBe(jsxDevRuntime);
  });

  test("registerPanel does not leak the registry's test seam", () => {
    // The registry's second parameter is its warning sink. Published by reference it would
    // become part of the surface a panel bundle could reach — and then part of what this
    // package has to keep. So the published function must not BE it, and must not forward a
    // second argument to it.
    resetPanels();
    expect(panelRuntime().registerPanel).not.toBe(registerPanel);
    const intercepted: string[] = [];
    const rt = panelRuntime();
    const Screen = () => null;
    rt.registerPanel({ slug: "seam", render: Screen });
    (rt.registerPanel as (d: PanelDefinition, w: (m: string) => void) => void)({ slug: "seam", render: Screen }, (m) => void intercepted.push(m));
    // The duplicate above WOULD have warned; it went to the console, not to the sink a
    // bundle handed in.
    expect(intercepted).toEqual([]);
    resetPanels();
  });
});
