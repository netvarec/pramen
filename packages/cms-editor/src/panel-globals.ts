// The three shim modules a PANEL bundle's bare imports resolve to.
//
// A panel is a project's own React screen, built as a separate bundle and rendered inside
// this editor's tree. It cannot contain React: two copies in one page share no hook
// dispatcher, so the panel's first `useState` throws "invalid hook call". It must instead
// link against the React the editor already loaded — which is published on a global by
// `panel-runtime.ts`, and reached from a panel's ordinary `import { useState } from "react"`
// through an import map in the shell (see `PramenAdmin.astro`) pointing at these files.
//
// GENERATED, not hand-written, and that is the whole reason this module exists rather than
// three checked-in files. A shim has to re-export every name STATICALLY — ESM named exports
// cannot be computed — so by hand the list would be a copy of React's export table that
// nobody would ever revisit. A name missing from it is not a build error anywhere: it is a
// browser link error ("does not provide an export named 'useDeferredValue'") in someone
// else's panel, months later, on the one deployment that used that hook. So the list is read
// off the very modules the editor bundles, at the moment it bundles them, and cannot drift
// from them by construction.
//
// Source-side rather than inside `scripts/build.ts` so the generator is typechecked and can
// be exercised by tests — `test/cms-editor-panel-globals.test.ts` builds a panel against the
// generated text and renders it, which is the only way to prove the mechanism end to end
// without a browser.

/** A module namespace as this generator must treat one: an opaque bag whose NAMES are the
 * entire subject. There is no schema to decode it against — the point is that the list comes
 * from React rather than from anything written here — so the contract is deliberately just
 * "an object with a possible CJS-interop `default`". */
export interface ModuleNamespace {
  readonly default?: ModuleNamespace;
}

/** One shim: which bare specifier it stands in for, which key on the published runtime it
 * reads, and what it is written to. */
export interface PanelGlobalShim {
  /** Filename under `dist/`, and the package export a shell imports with `?url`. */
  readonly file: string;
  /** The bare specifier an import map points at this file. */
  readonly specifier: string;
  /** The property of `PRAMEN_CMS_EDITOR_RUNTIME` holding the namespace. */
  readonly runtimeKey: "react" | "reactDom" | "jsxRuntime" | "jsxDevRuntime";
}

/** The whole set. Four, and meant to stay four — see the surface note in `panel-runtime.ts`
 * for why each is here and what is deliberately not. */
export const PANEL_GLOBAL_SHIMS: readonly PanelGlobalShim[] = [
  { file: "panel-react.js", specifier: "react", runtimeKey: "react" },
  { file: "panel-react-dom.js", specifier: "react-dom", runtimeKey: "reactDom" },
  { file: "panel-jsx-runtime.js", specifier: "react/jsx-runtime", runtimeKey: "jsxRuntime" },
  // The transform a panel built UNMINIFIED emits instead. Not an optional nicety: without
  // it that specifier resolves from the consumer's own node_modules and a second React ends
  // up in the bundle, silently, on exactly the build a developer iterates on.
  { file: "panel-jsx-dev-runtime.js", specifier: "react/jsx-dev-runtime", runtimeKey: "jsxDevRuntime" },
];

/**
 * The names a shim may re-export, read off a module namespace: real identifiers only.
 *
 * The namespace is unwrapped through `default` first, because React and its JSX runtimes are
 * CJS: a bundler's interop puts the real `module.exports` on `default` and mirrors the named
 * exports beside it. Enumerating the unwrapped object means the list is the one `require`
 * would have produced, rather than one that depends on which interop the editor happened to
 * be built with — and it is the same unwrap the generated shim performs at runtime, so the
 * names written out are exactly the names that will be there to destructure.
 *
 * `default` is excluded because it is a keyword (it gets its own `export default` line), and
 * `__`-prefixed keys because React's namespaces carry interop bookkeeping and internals
 * (`__esModule`, `__CLIENT_INTERNALS_…`) that are nobody's API — re-exporting them would put
 * this package's name on a promise React itself does not make.
 *
 * Sorted, so a rebuild against the same React produces a byte-identical file and a diff of
 * `dist/` says something.
 */
export function exportableNames(ns: ModuleNamespace): string[] {
  const real = ns.default ?? ns;
  return Object.keys(real)
    .filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) && k !== "default" && !k.startsWith("__"))
    .sort();
}

/**
 * The shim's source.
 *
 * The `?.` and the throw are not defensive noise. This is the first module a panel bundle
 * imports, so it is the one place where "the editor did not publish its runtime" — a panel
 * loaded outside the admin, or a shell that emitted the import map but not the editor — can
 * be reported as itself instead of as `Cannot read properties of undefined (reading
 * 'react')` from somewhere inside a stranger's bundle.
 *
 * `ns.default ?? ns` is the same CJS-interop unwrap `exportableNames` performs, and it has to
 * be: the names written into this file were read off the unwrapped object, so the object
 * destructured here must be that object and not the namespace around it.
 */
export function panelShimSource(shim: PanelGlobalShim, names: readonly string[], runtimeGlobal: string): string {
  return `// GENERATED by @pramen/cms-editor's build — do not edit.
// Resolves the bare specifier "${shim.specifier}" for a panel bundle, against the React the
// editor already loaded. Wired up by the shell's import map; see docs/cms.md.
const ns = globalThis.${runtimeGlobal}?.${shim.runtimeKey};
if (!ns) throw new Error("pramen/cms-editor: no editor runtime on this page — a panel bundle was loaded outside the CMS editor, or before it booted.");
const m = ns.default ?? ns;
export default m;
export const { ${names.join(", ")} } = m;
`;
}
