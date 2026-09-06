// The chrome's light/dark choice, as a store rather than a component's state.
//
// It used to be a `useState` inside `_layout.tsx`, which was fine while the layout was the
// only reader. It is not the only reader any more: a panel (a project's own React screen —
// see `panels.ts`) is handed the theme, and it is rendered through `<Outlet />` under that
// same layout. Threading it down as a prop would mean every route the layout renders had to
// carry a value only one of them wants; a second `useState` would mean two sources of truth
// for one document attribute, drifting the moment either is set.
//
// A store instead: one value, one place that writes the DOM attribute and localStorage, and
// a `useSyncExternalStore` hook for anyone who wants to re-render on a change. It is also
// what lets `main.tsx` apply the stored theme BEFORE the first paint, which the layout's
// effect could not do — an editor left in dark mode used to flash white on every load.

import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

/** Per-browser, like the folded nav groups: a reading preference, not deployment
 * configuration, so nothing server-side carries it. */
const THEME_KEY = "pramen.cms.theme";

let current: Theme = "light";
const listeners = new Set<() => void>();

/** Read the stored choice, tolerating every shape localStorage can be in (absent, another
 * version's value, hand-edited, a private window that throws on access). Anything that is
 * not exactly `"dark"` is light, which is the default the editor has always had. */
function stored(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Put the choice where podoba can see it. The tokens flip under `[data-theme="dark"]` on
 * the document root — there are no `dark:` variants to toggle — so this one attribute is the
 * whole of "apply the theme". */
function apply(theme: Theme): void {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
}

/** Adopt the stored choice and paint it. Called once, from `main.tsx`, before `createRoot`. */
export function initTheme(): void {
  current = stored();
  apply(current);
}

export function getTheme(): Theme {
  return current;
}

export function setTheme(theme: Theme): void {
  if (theme === current) return;
  current = theme;
  apply(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A private window that refuses writes costs the memory of the choice, nothing else.
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current theme, re-rendering the caller when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, getTheme, getTheme);
}

/** Drop every listener and return to the default. Tests only — the store is module state. */
export function resetTheme(): void {
  listeners.clear();
  current = "light";
}
