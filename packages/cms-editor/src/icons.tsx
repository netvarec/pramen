// The editor's icon family: Phosphor, regular weight.
//
// ONE family, chosen for its plainness — at 15px in a nav rail an icon has to survive as a
// silhouette, and Phosphor's regular weight is the simplest set that still reads at that
// size. It replaces two half-families: podoba's own line set (which does not cover a CMS's
// nouns — no taxonomy, no widget area, no redirect) and, next to it, the glyphs this file
// used to draw by hand to fill those gaps. Two sets of hand-fitted curves side by side is
// the one outcome worse than either.
//
// Everything the editor draws comes from HERE, aliased to a name that says what it means in
// this app rather than what it depicts. That is not ceremony: it is what makes the family a
// decision recorded in one file. Swapping it (or moving it into @podoba/react, where it
// belongs once the design system adopts a set) is then this module's imports and nothing
// else — no call site names a vendor.
//
// A HOST's own icon is a separate thing and stays a separate thing: a collection or a Block
// Kit page declares `icon: "🎓"` and that string goes in the icon column verbatim (see
// `NavIcon` in nav.ts). Resolving such a string against Phosphor BY NAME is deliberately not
// offered — a by-name lookup needs the whole 3000-icon registry in the bundle, which is
// megabytes to let a deployment name one glyph it can already supply directly.

import {
  ArrowBendUpRightIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  FileTextIcon,
  FolderIcon,
  GearIcon,
  type Icon,
  ImageIcon,
  LayoutIcon,
  ListDashesIcon,
  ListIcon,
  MoonIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  SquaresFourIcon,
  StackIcon,
  SunIcon,
  TagIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import type { NavGlyph } from "./nav";

/** A drawable glyph. Phosphor's own component type, re-exported so a call site can hold one
 * without importing the vendor. */
export type { Icon };

// --- the chrome's own controls -----------------------------------------------------------
//
// Named for the JOB, not the picture. `MenuToggleIcon` is the hamburger that opens the rail
// below `md`; calling it `ListIcon` at the call site would put it one careless edit away from
// standing in for the Menus SECTION, which is a destination and a different glyph.

/** Opens the collapsed rail below `md`. */
export const MenuToggleIcon = ListIcon;
/** Collapses the rail to icons, and brings it back. ONE glyph for both directions: the
 * button is a toggle, and swapping the picture per state makes the reader decide what the
 * new picture means before they can decide whether to press it. `aria-expanded` carries the
 * state, which is where a state belongs. */
export const RailToggleIcon = SidebarSimpleIcon;
/** A group that is open — points down, as every file tree has agreed. */
export const GroupOpenIcon = CaretDownIcon;
/** …and one that is folded. */
export const GroupFoldedIcon = CaretRightIcon;
/** Switch to the light theme (shown while dark is active). */
export const LightThemeIcon = SunIcon;
/** …and the reverse. */
export const DarkThemeIcon = MoonIcon;
/** Drop the session. */
export { SignOutIcon };
/** The account menu's settings entry — the same glyph the nav's Settings row uses. */
export { GearIcon as SettingsIcon };

// --- the nav's destinations ---------------------------------------------------------------

/** Glyph name -> component. The layout renders `NAV_GLYPHS[entry.icon.name]`; `satisfies`
 * rather than an annotation, so the mapping stays exhaustive over `NavGlyph` (a glyph with no
 * drawing is a compile error, not a blank square in the rail) without widening every value to
 * the shared signature. */
export const NAV_GLYPHS = {
  pages: FileTextIcon,
  collection: FolderIcon,
  media: ImageIcon,
  // NOT the hamburger: that is the control that opens this rail, and one glyph cannot mean
  // both "open the nav" and "the Menus section".
  menus: ListDashesIcon,
  taxonomies: TagIcon,
  widgets: LayoutIcon,
  redirects: ArrowBendUpRightIcon,
  app: SquaresFourIcon,
  types: StackIcon,
  users: UsersIcon,
  settings: GearIcon,
  link: ArrowSquareOutIcon,
} satisfies Record<NavGlyph, Icon>;
