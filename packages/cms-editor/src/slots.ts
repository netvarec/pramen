// The contracts a THEME implements: `@pramen/cms-editor/slots`.
//
// `buildEditor({ slots })` swaps one of the editor's own modules for a host's, and a slot is
// only as good as the promise that its props stay stable. That promise used to live in a
// comment above the component (the screen header's "takes `{ lead, em, children }`"), which a
// theme could read but not import. So a host typed its replacement by copying the props, and
// the copy drifted the first time either side changed. Here it is a type the host imports, and
// the editor's own default for each slot is declared against the SAME type, so a change to a
// contract is a compile error on both sides of it.
//
// A LEAF, and it has to stay one. A theme package typechecks this file with ITS compiler
// options and ITS installed dependencies, so everything reachable from here is part of the
// public surface: it imports only types, only from other leaves (`types.ts` has no imports;
// `nav.ts` has none beyond it and this file), and nothing that needs the editor's generated
// route table, its app context or its router. Everything a slot needs from the running app
// (the API client, the mount prefix, the session's content types, a way to navigate) arrives
// as PROPS for the same reason: a hook export would have to reach into `app-context.tsx`, and
// a theme resolving that module out of its own `node_modules` is a second React context the
// editor never provided, which throws on first render.
//
// The one runtime value is `EDITOR_PAGES`, because a route named in RUNTIME config (an
// account-menu item from the shell) has to be checked against something that exists at runtime.

import type { ReactNode } from "react";
import type { AdminPageMeta, CmsCapabilities, CollectionMeta, ContentType, JsonValue, RpcInput } from "./types";
import type { NavGlyph, NavSection } from "./nav";

export type { AdminPageMeta, CmsCapabilities, CollectionMeta, ContentType } from "./types";
export type { ExtraNavLink, NavEntry, NavGlyph, NavIcon, NavSection, NavSectionId } from "./nav";

// --- routes --------------------------------------------------------------------------------

/**
 * Every screen the editor routes to, by the id its router knows it by.
 *
 * Written out rather than derived from the generated route table (`buzola.gen.ts`), because
 * deriving it would put the router and every route module in the type graph of anyone who
 * imports this file. Kept honest from the other side: `routes/_layout.tsx` fails to compile if
 * this list and the router's page map disagree in either direction, and a test compares it with
 * the runtime registry.
 */
export const EDITOR_PAGES = [
  "admin-page",
  "block-type",
  "collection",
  "collection-item",
  "content-type",
  "home",
  "media",
  "menu",
  "menus",
  "page",
  "redirects",
  "schema",
  "settings",
  "taxonomies",
  "taxonomy",
  "type",
  "users",
  "widget-area",
  "widgets",
] as const;

/** A screen of the editor. See {@link EDITOR_PAGES}. */
export type EditorPage = (typeof EDITOR_PAGES)[number];

/** The slice of the API client a slot may use: an authenticated handler call, as the signed-in
 * user, and the resolution of a backend-relative path (a media file, a signed download) to a
 * URL the browser can load. The same two a custom panel is given. */
export interface EditorApi {
  call<T = unknown>(name: string, input?: RpcInput): Promise<T>;
  resolve(path: string): string;
}

// --- pageHeader ----------------------------------------------------------------------------

/** `slots.pageHeader`: the sticky panel with a list screen's `<h1>` and its primary action.
 * Export `PageHeader`. */
export interface PageHeaderProps {
  /** The screen's name ("Media", a collection's plural label). Stable while the screen is
   * open, which is why the default cover art is seeded on it. */
  lead: string;
  /** The screen's state ("3 files", "None yet", "Loading…"). Changes as data arrives. */
  em: string;
  /** The primary action(s): the editor's own `Button`s, with their handlers, refs and disabled
   * state. Media also passes the hidden `<input type="file">` its upload button drives, so
   * render every child, not just the buttons. */
  children?: ReactNode;
}

// --- home ----------------------------------------------------------------------------------

/**
 * Where the built-in landing sends `/`, decided by the editor so a home screen of your own
 * does not have to re-derive it.
 *
 * - `pending`: the content types have not been answered yet; nothing is decided.
 * - `collection`: a collections-only deployment (`hidePages`): the first collection.
 * - `type`: a deployment split by content type: the first type's own list.
 * - `pages`: the pooled page list IS the home screen (one content type, or an older server).
 * - `none`: collections-only with no collection to land on.
 */
export type HomeLanding =
  | { kind: "pending" }
  | { kind: "collection"; slug: string }
  | { kind: "type"; slug: string }
  | { kind: "pages" }
  | { kind: "none" };

/** `slots.home`: what `/` renders. Export `HomeScreen`. The default follows `landing`: it
 * redirects for `collection` and `type`, and renders `pageList` for `pages`. */
export interface HomeScreenProps {
  api: EditorApi;
  /** The prefix the editor is mounted under ("/__admin"), for links you build yourself. `""`
   * at the origin root. Prefer `href`, which already includes it. */
  basePath: string;
  /** `null` until the server has answered. */
  contentTypes: ContentType[] | null;
  collections: CollectionMeta[];
  /** Block Kit pages and panels this caller may open, already role-filtered by the server. */
  adminPages: AdminPageMeta[];
  isAdmin: boolean;
  cms: CmsCapabilities;
  landing: HomeLanding;
  /** Go where `landing` points, replacing `/` in history. A no-op for `pending`, `pages` and
   * `none`. */
  goToLanding: () => void;
  /**
   * The pooled page list, when `landing` is `pages`; otherwise `null`.
   *
   * Handed over rather than left out because on such a deployment the nav's "Pages" entry
   * points at `/`, so a home screen that drops this makes the page list unreachable. Render it
   * under your own content, or behind a link of your own.
   */
  pageList: ReactNode;
  /** An href for a screen of the editor, mount prefix included. Put it on a real `<a>` so
   * middle-click and "open in new tab" work. The editor's router intercepts a plain click on
   * a same-document link inside its prefix, so an ordinary anchor stays in-app. */
  href: (page: EditorPage, params?: Record<string, string>) => string;
  /** Navigate in-app. */
  navigate: (page: EditorPage, params?: Record<string, string>) => void;
  /** Show a message in the chrome's error banner; `""` clears it. */
  onError: (message: string) => void;
}

// --- detailHeader --------------------------------------------------------------------------

/**
 * `slots.detailHeader`: the header of ONE record's screen: a way back to the list it belongs
 * to, and its title. Export `DetailHeader`.
 *
 * Every detail screen renders it: the page editor, a collection item, a block type, a content
 * type, a menu, a vocabulary, a widget area.
 */
export interface DetailHeaderProps {
  /** The record's name, or "New …" while it is being created. */
  title: ReactNode;
  /** The label of the list this record belongs to ("Types", "Menus", a content type's name). */
  parent: string;
  /** That list's href, mount prefix included, for a theme that renders the way back as a
   * real link. The default renders a button and does not use it. */
  href: string;
  /** Go back to the list. Already wrapped in the screen's unsaved-changes guard where it has
   * one, so call it rather than following `href` yourself on a plain click. */
  onBack: () => void;
  /** Facts about the record that sit beside the title: its slug, a "defined in code" badge. */
  children?: ReactNode;
}

// --- media ---------------------------------------------------------------------------------

/**
 * `slots.mediaDetail`: the dialog frame around one file's detail. Export `MediaDetailFrame`.
 *
 * The editor owns what is IN it (the preview element, the alt-text form, the facts, the tags,
 * the actions and their handlers); the frame decides where each part goes and owns the
 * dialog: overlay, dismissal, focus, the close control.
 */
export interface MediaDetailFrameProps {
  /** The dialog's title: the filename, dressed. */
  title: ReactNode;
  /** The file itself: an `<img>` for an image, a placeholder with the extension otherwise. */
  preview: ReactNode;
  /** The alt-text field, the file's facts (type, size, upload date, URL) and its tags. */
  details: ReactNode;
  /** Save, preview, download, copy URL, delete, close, as one row. */
  actions: ReactNode;
  /** Dismiss. Called for Esc, an outside click and the close control alike. */
  onClose: () => void;
  /** The accessible name for the close control. */
  closeLabel: string;
}

/** One file, as the library grid shows it. */
export interface MediaTile {
  id: string;
  /** The uploaded filename, or the id for a file stored without one. */
  filename: string;
  /** Bytes, when the store recorded them. */
  size: number | undefined;
  /** `size`, formatted ("84 KB"). */
  sizeLabel: string;
  /** The extension in capitals ("PDF"), for a non-image placeholder. */
  ext: string;
  /** The stored MIME type, when there is one. */
  contentType: string | undefined;
  /** The full-size URL of an image; `null` for anything the browser should not try to render
   * as one. Load it lazily: a page of the library is sixty of these. */
  src: string | null;
  alt: string;
  /** Whether this file's detail is open. */
  selected: boolean;
  /** Open this file's detail. */
  onOpen: () => void;
}

/** `slots.mediaGrid`: the media library's grid. Export `MediaGrid` AND `MediaLibraryEmpty`. */
export interface MediaGridProps {
  /** The grid's accessible name. */
  label: string;
  /** Never empty: an empty library renders `MediaLibraryEmpty`, and a filter that matched
   * nothing is the editor's own message, since clearing the filter is the way out. */
  tiles: MediaTile[];
}

/** The library with nothing in it at all (no filter applied). */
export interface MediaLibraryEmptyProps {
  title: string;
  description: string;
}

// --- account -------------------------------------------------------------------------------

/**
 * What the identity provider said about the signed-in person: the `profile` an OIDC sign-in
 * stores (`mapProfile` in `@pramen/auth`), as `me` returns it.
 *
 * Parsed once, where `me` arrives, so a slot reads it without checking it again: `name` is a
 * non-empty string or absent, and `picture` an absolute `https:` URL (safe for `<img src>`) or
 * absent. Anything else a deployment mapped is passed through under its own key, as JSON.
 * Absent altogether for a session that never signed in through OIDC.
 */
export interface AccountProfile {
  name?: string;
  picture?: string;
  [key: string]: JsonValue | undefined;
}

/** The signed-in identity, as the server resolved it (`me`). `userId` is the account key,
 * which is a username or an email, not a display name: prefer `profile.name` for that. */
export interface AccountIdentity {
  userId?: string;
  roles?: string[];
  profile?: AccountProfile | null;
}

/** One deployment row of the account menu (`accountMenu` in the shell config, or
 * `navHooks.accountMenu`), already filtered for this session and wrapped in the unsaved-changes
 * guard. Render it and call `onSelect`; `id` is stable, use it as the key. */
export interface AccountMenuRow {
  id: string;
  label: string;
  icon?: NavGlyph;
  /** Navigates, through the guard. Returns whether it went (false when the reader chose to
   * stay on a screen with unsaved changes), so a menu that closes itself can stay open. */
  onSelect: () => boolean;
}

/**
 * `slots.account`: the account cluster at the end of the chrome, the avatar and what opens
 * from it. Export `AccountMenu`.
 *
 * Both chromes render it: the topbar at the right end of the bar (`compact`) and in its
 * small-viewport menu, the sidebar at the foot of the rail. Whatever it renders, it owns the
 * session's way to the theme, Settings and sign-out, so a replacement that drops one of them
 * drops it from the editor.
 */
export interface AccountMenuProps {
  /** `null` until the `me` call has answered. */
  me: AccountIdentity | null;
  /** The current theme, as the editor names it. */
  theme: string;
  /** The topbar's shape: a bare avatar, no name beside it. */
  compact: boolean;
  /** The deployment's own rows, in order. Usually empty. */
  items: readonly AccountMenuRow[];
  /** Toggle light and dark. */
  onTheme: () => void;
  /** Open Settings, through the guard. Returns whether it went. */
  onSettings: () => boolean;
  /** Sign out. Returns whether it went. */
  onSignOut: () => boolean;
}

// --- nav -----------------------------------------------------------------------------------

/** What the nav hooks are given: the nav exactly as the editor built it for this session. */
export interface NavContext {
  /** The grouped nav, in order, BEFORE any transform. */
  sections: NavSection[];
  /** The key of the entry lit for the current route, or `""`. */
  active: string;
  isAdmin: boolean;
  /** The signed-in user as the server resolved them. `null` while that call is in flight. */
  me: { userId?: string; roles?: string[] } | null;
}

/** What `transformNav` returns: the nav to render and the key to light in it. */
export interface NavTransform {
  sections: NavSection[];
  active: string;
}

/** An extra row in the account menu that opens a screen of the editor. */
export interface AccountMenuItem {
  label: string;
  page: EditorPage;
  params?: Record<string, string>;
  /** One of the nav's glyphs, so the row lines up with Settings and Sign out. Unset leaves the
   * icon column empty. */
  icon?: NavGlyph;
  /** Show the row only when the nav the editor built (before `transformNav`) has an entry with
   * this key, e.g. `"types"`, which exists only for a session that may author the schema.
   * This is how runtime config states a capability, since it cannot carry a function. */
  requiresNav?: string;
  /** Show the row only when this returns true. Build-time only (`slots.nav`). */
  visible?: (context: NavContext) => boolean;
}

/**
 * `slots.nav`: hooks over the nav both chromes render. Export `navHooks`.
 *
 * Both are optional; `{}` is the editor as it ships.
 */
export interface NavHooks {
  /**
   * Rename, hide, reorder or regroup entries, and move the highlight to match.
   *
   * Runs on every render of the layout, so keep it pure and cheap. Return NEW objects rather
   * than mutating `sections`: the input is also what `requiresNav` is checked against. Moving
   * `active` is how a hidden entry's route keeps something lit: hide `type:events` in favour
   * of `app:events`, and light `app:events` while `type:events` is the route. An entry left
   * with no sections is fine; an empty section is dropped. If it throws, the editor logs it
   * and renders the nav untransformed rather than taking the admin down.
   */
  transformNav?: (context: NavContext) => NavTransform;
  /** Rows added to the account menu, after the theme toggle and before Settings. Appended to
   * any the shell's runtime config declares (`accountMenu`). */
  accountMenu?: readonly AccountMenuItem[];
}
