// What the editor bundle publishes on `globalThis` for panel bundles to build against.
//
// A panel is a separate bundle that renders into THIS bundle's React tree. Two copies of
// React in one page share no hook dispatcher, so a second copy does not degrade — the first
// `useState` in a panel throws "invalid hook call" and the screen is a blank error. The
// panel bundle therefore cannot contain React; it must import the one already here.
//
// So the editor publishes its React (plus react-dom and both JSX runtimes) on a global, and
// the shell's import map points those bare specifiers at four tiny shim modules that read it
// back out — see `panel-globals.ts`, which GENERATES the shims from the very namespaces
// published here, so the names they re-export cannot drift from the React actually loaded.
//
// The consequence, and the whole point: a panel is written as ordinary React, with ordinary
// `import { useState } from "react"`, built with react/react-dom marked external. Nothing
// about the source says it is a panel except the one `registerPanel` call. That is what
// makes an existing standalone screen portable rather than rewritable.
//
// THE SURFACE IS FOUR NAMESPACES AND ONE FUNCTION, and it is meant to stay that size —
// every name here is a thing this package can never move again:
//
//   - `react` — the shared copy. Non-negotiable; it is the reason this exists.
//   - `reactDom` — shared for the same reason, one level down. A panel that bundled its own
//     react-dom would be a SECOND RECONCILER driving one React, which is worse than a second
//     React because it can appear to work. It is also where `createPortal` lives, and a
//     dialog is the first thing a panel needs that Block Kit could not express.
//   - `jsxRuntime` / `jsxDevRuntime` — the automatic JSX transform emits imports from
//     `react/jsx-runtime`, or from `react/jsx-dev-runtime` when the panel is built
//     unminified. A panel bundle does not choose this, its compiler does — and the dev half
//     is the one that MUST be here: left out, a development build resolves that specifier
//     from the consumer's own node_modules and quietly bundles a second React, which is the
//     exact failure this whole mechanism exists to prevent, arriving on the one build where
//     nobody is looking for it.
//   - `registerPanel` — the registration itself.
//
// Not published, and each for a reason: the `Api` class (a panel gets the narrow `PanelApi`
// through props — see `panels.ts`), the router (a panel owns its own screen, not the
// editor's routing table), the podoba component library (it is a dependency a panel can
// install itself, and freezing OUR version of it as a global API is a promise this package
// should not make), and the app context (it carries the CMS's own state, none of which is a
// project screen's business).

import * as react from "react";
import * as reactDom from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import { registerPanel, type PanelDefinition } from "./panels";

/** Where the runtime is published. Namespaced away from `PRAMEN_CMS_EDITOR`, which is the
 * SHELL's config: that object is written by the server and read by the editor, this one is
 * written by the editor and read by panel bundles, and putting them together would invite a
 * shell to think it may set part of this. */
export const PANEL_RUNTIME_GLOBAL = "PRAMEN_CMS_EDITOR_RUNTIME";

/** Bumped only when a published name changes meaning or disappears. A panel bundle built
 * against an older editor can read it and say so, instead of failing at whichever import
 * happens to be first. */
export const PANEL_RUNTIME_CONTRACT = 1;

export interface PanelRuntime {
  readonly contract: number;
  readonly react: typeof react;
  readonly reactDom: typeof reactDom;
  readonly jsxRuntime: typeof jsxRuntime;
  readonly jsxDevRuntime: typeof jsxDevRuntime;
  registerPanel(def: PanelDefinition): void;
}

/** The host object a panel runtime is published on. */
export interface PanelRuntimeHost {
  [PANEL_RUNTIME_GLOBAL]?: PanelRuntime;
}

export function panelRuntime(): PanelRuntime {
  return {
    contract: PANEL_RUNTIME_CONTRACT,
    react,
    reactDom,
    jsxRuntime,
    jsxDevRuntime,
    // Wrapped rather than passed by reference so the published function is this module's,
    // not the registry's — the registry keeps a second parameter (its warning sink) that is
    // a test seam and must not become part of the surface a panel bundle can reach.
    registerPanel: (def) => registerPanel(def),
  };
}

/**
 * Publish the runtime. Called at the very top of `main.tsx`, before anything is imported
 * dynamically and before the router mounts, so that by the time a panel bundle's first
 * `import "react"` is evaluated the global is already there.
 *
 * Publishing is unconditional — it does not wait to see whether any panel is configured.
 * The object is four references; making it conditional would mean a deployment that adds a
 * panel later has a second thing to switch on, and a debugging session that starts with
 * "is the runtime there?" would have two answers.
 */
export function publishPanelRuntime(host: PanelRuntimeHost): void {
  host[PANEL_RUNTIME_GLOBAL] = panelRuntime();
}
