// What both chromes are made of.
//
// The editor ships TWO shapes of the same nav (a sidebar rail, `chrome-sidebar.tsx`, and a
// Graphic Standard-style topbar, `chrome-topbar.tsx`) chosen per deployment by
// `CHROME_LAYOUT`. This module is the seam between them: the props `routes/_layout.tsx`
// hands whichever one is mounted, plus the pieces that are the same in both.
//
// The seam is deliberately narrow and free of routing. `_layout.tsx` derives the nav, works
// out what is lit, and wraps every way OUT of a screen in the unsaved-changes guard; a
// chrome is handed the ANSWERS and renders them. That is what keeps the two from drifting:
// there is exactly one place that decides where a nav entry goes and what happens when it is
// clicked, and adding a third shape means writing markup, not re-deriving state.

import { useEffect, useState, type ReactNode } from "react";
import type { Me } from "./app-context";
import { NAV_GLYPHS } from "./icons";
import type { ExtraNavLink, NavEntry, NavIcon, NavSection } from "./nav";
import type { AccountMenuRow } from "./slots";

/** A nav entry that goes somewhere in the SPA: the half a chrome navigates rather than
 * links to. Narrowed here so neither chrome has to re-derive the discriminant. */
export type NavRoute = Extract<NavEntry, { kind: "route" }>;

/** A deployment's own row in the account menu (`accountMenu` in the shell config, or
 * `navHooks.accountMenu` in a theme), resolved by the layout: already filtered for this
 * session, already wrapped in the unsaved-changes guard. A chrome hands it to the account menu,
 * which renders it and calls `onSelect`, and never needs to know what any particular row is
 * for. The contract is `AccountMenuRow` in `slots.ts`, since the account menu is a slot. */
export type AccountMenuEntry = AccountMenuRow;

/** Everything a chrome is handed. */
export interface ChromeProps {
  /** The nav, grouped and in order (`navSections`). */
  sections: NavSection[];
  /** Whether the groups are worth naming; false on a deployment with a single group. */
  labelled: boolean;
  /** The key of the lit entry, or `""` where nothing matches the route. */
  active: string;
  /** The lit entry, when it is a route: the section half of the breadcrumb and the way
   * back to its list. Taken from what is LIT rather than re-derived from the path: the nav
   * already answered "where am I", and a second answer computed differently can disagree. */
  sectionCrumb: NavRoute | undefined;
  /** The detail half, published by whatever screen is mounted (see `breadcrumb.tsx`). */
  crumb: string | null;
  me: Me | null;
  theme: string;
  onTheme: () => void;
  /** Every one of these is already wrapped in the unsaved-changes guard by `_layout.tsx`,
   * and each RETURNS whether it actually went, so false when the reader answered "stay".
   *
   * The return value is not decoration. A chrome that dismisses itself on click (the
   * topbar's small-viewport dialog) would otherwise close before the prompt is answered, so
   * declining leaves you on the dirty screen with the nav gone. The sidebar has always got
   * this right by closing on a CHANGE of route rather than on the click; a modal cannot
   * watch for that, so it is told. */
  onSettings: () => boolean;
  onSignOut: () => boolean;
  onHome: () => boolean;
  /** The deployment's own account-menu rows, in order. Usually empty. */
  accountItems: AccountMenuEntry[];
  onGo: (entry: NavRoute) => boolean;
  /** Whether a host link may navigate the CURRENT tab (`opensInSameTab`), applied by the
   * layout because it depends on the router's base path. */
  sameTab: (link: ExtraNavLink) => boolean;
  /** The guard itself, for the one navigation a chrome makes directly: a same-tab host link
   * is a real cross-document navigation, so it consults the guard before unloading. */
  confirmNavigation: () => boolean;
  /** The global error banner and the routed screen. */
  children: ReactNode;
}

/** Tailwind's `md`, as a media query. Shared so JS and the `md:`-scoped classes that express
 * the same breakpoint cannot describe two different chromes. */
export const MD_BREAKPOINT = "(min-width: 48rem)";

/**
 * Whether a media query matches, kept in sync as the viewport changes.
 *
 * SSR-safe and paranoid about the API: `matchMedia` is absent in a non-browser render and has
 * been present-but-partial (no `addEventListener`, only the deprecated `addListener`) in
 * browsers this editor still meets. Defaults to TRUE, which is the desktop reading, the same
 * direction the layout already fails in, and the one where every control is on screen.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    try {
      return globalThis.matchMedia?.(query).matches ?? true;
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const mql = globalThis.matchMedia?.(query);
    if (!mql) return;
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

/** The icon column of a nav row.
 *
 * A collection and a Block Kit page may declare their own icon server-side, which is an
 * arbitrary string (an emoji, in practice). It used to be prepended to the LABEL, where it
 * read as part of the words and wrapped with them; here both cases occupy the same 16px box,
 * so a nav mixing declared emoji with built-in glyphs still has one aligned icon column.
 */
export function NavIconSlot({ icon }: { icon: NavIcon }): ReactNode {
  if (icon.kind === "emoji") {
    return (
      <span aria-hidden="true" className="flex h-[15px] w-[15px] shrink-0 items-center justify-center text-[13px] leading-none">
        {icon.char}
      </span>
    );
  }
  const Glyph = NAV_GLYPHS[icon.name];
  return <Glyph className="h-[15px] w-[15px] shrink-0" />;
}

