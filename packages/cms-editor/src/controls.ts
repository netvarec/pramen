// Which of the editor's optional list controls a deployment has turned off.
//
// Search and filters are on by default and stay the recommendation: a media library is paged at
// sixty files, and without them the sixty-first is a "Load more" away every time. But whether a
// given CMS needs them is a PRODUCT decision, and one deployment made the opposite call (its
// editors browse a small, curated library and found the toolbar noise). It made that call by
// deleting the controls out of our source with regular expressions at build time, which is the
// shape of the problem this module removes: a decision that belongs to the deployment, taken
// with a tool that breaks on our next release.
//
// So it is runtime config, beside `layout` and `pageHeader`, rather than a slot: nothing is
// REPLACED, a control is simply not rendered, and a deployment should not need a build to say
// so. Hiding a control never narrows what a list shows. Every hidden control's state is at its
// default (empty search, no filter, newest first), so the list is the complete, unfiltered one.
//
// Leaf and free of React and DOM-lib imports, like `chrome.ts`: read once at module load,
// resolved by a pure function a test can hand a plain object.

/** A control a deployment may hide. */
export type EditorControl =
  /** The media library's search field. */
  | "mediaSearch"
  /** The media library's sort menu, tag menu and type chips. */
  | "mediaFilters"
  /** The search input in a relation field's picker. */
  | "relationSearch";

/** Every value `hideControls` accepts, for the warning below and for the docs. */
export const EDITOR_CONTROLS: readonly EditorControl[] = ["mediaSearch", "mediaFilters", "relationSearch"];

/**
 * Resolve `hideControls` to the set of hidden controls.
 *
 * Unknown names are WARNED about and skipped, never thrown on, for the reason `resolveLayout`
 * gives: this is hand-edited config read at module load with no error boundary above it, and
 * `"mediaSeach"` silently doing nothing is exactly the slip nobody notices until a client asks
 * why the search is still there.
 */
export function resolveHiddenControls(value: unknown): ReadonlySet<EditorControl> {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value)) {
    console.warn(`pramen/cms-editor: ignoring \`hideControls\` ${JSON.stringify(value)}; expected an array of ${EDITOR_CONTROLS.map((c) => JSON.stringify(c)).join(", ")}.`);
    return new Set();
  }
  const out = new Set<EditorControl>();
  for (const v of value as unknown[]) {
    const name = typeof v === "string" ? v.trim() : "";
    if ((EDITOR_CONTROLS as readonly string[]).includes(name)) out.add(name as EditorControl);
    else console.warn(`pramen/cms-editor: ignoring unknown \`hideControls\` entry ${JSON.stringify(v)}. Expected one of ${EDITOR_CONTROLS.map((c) => JSON.stringify(c)).join(", ")}.`);
  }
  return out;
}

/** The global the host's shell writes. Structural, so this module needs no DOM lib. */
export interface ControlsHost {
  PRAMEN_CMS_EDITOR?: { hideControls?: unknown };
}

/** Pull `hideControls` off a host global, tolerating its absence. */
export function readControlsConfig(host: ControlsHost | undefined): unknown {
  return host?.PRAMEN_CMS_EDITOR?.hideControls;
}

/** The hidden controls for THIS page load. Read at module load, like `CHROME_LAYOUT`. */
export const HIDDEN_CONTROLS: ReadonlySet<EditorControl> = resolveHiddenControls(readControlsConfig(globalThis as ControlsHost));

/** Whether a control is shown on this page load. */
export function controlShown(control: EditorControl): boolean {
  return !HIDDEN_CONTROLS.has(control);
}
