// Copy of the editor's shell area. See `./index.ts` for how the areas are assembled.
//
// The shell is everything around a screen: the nav and its section headings, both chromes
// (sidebar rail and topbar), the account menu, the Setup screen, the 404, the Apps route that
// hosts a project's own screens, and the transport errors the banner shows.

import type { Translation } from "../types";

export const en = {
  // --- nav: the built-in entries ------------------------------------------------------------
  //
  // Collections, content types, Block Kit pages and `extraNav` links are named by their own
  // (server or host) labels; these are the editor's own screens.
  "nav.pages": "Pages",
  "nav.media": "Media",
  "nav.menus": "Menus",
  "nav.taxonomies": "Taxonomies",
  "nav.widgets": "Widgets",
  "nav.redirects": "Redirects",
  /** The schema screen: where block types and content types are authored. */
  "nav.types": "Types",
  "nav.users": "Users",
  "nav.settings": "Settings",

  // --- nav: section headings ----------------------------------------------------------------
  /** Pages / content types, collections, media. */
  "nav.section.content": "Content",
  /** Menus, taxonomies, widget areas, redirects. */
  "nav.section.site": "Site",
  /** A project's own screens (Block Kit pages and panels). */
  "nav.section.apps": "Apps",
  /** Types, users, settings, host links. */
  "nav.section.system": "System",

  // --- chrome: both shapes ------------------------------------------------------------------
  /** Accessible name of the wordmark button that goes to the admin's home. `{brand}` is the
   * deployment's name. */
  "chrome.home": "{brand}: home",
  /** Accessible name of the sidebar rail landmark. */
  "chrome.sidebar": "Sidebar",
  /** Accessible name of the main nav landmark. */
  "chrome.primaryNav": "Primary",
  /** The small-viewport menu button. */
  "chrome.showNav": "Show navigation",
  "chrome.hideNav": "Hide navigation",
  /** The title of the topbar's small-viewport nav dialog. */
  "chrome.navDialog": "Navigation",
  /** The app bar button that narrows the rail to its icons, and widens it again. */
  "chrome.expandSidebar": "Expand the sidebar",
  "chrome.collapseSidebar": "Collapse the sidebar",

  // --- breadcrumb ---------------------------------------------------------------------------
  /** Accessible name of the breadcrumb landmark. */
  "breadcrumb.label": "Breadcrumb",

  // --- account menu -------------------------------------------------------------------------
  /** Accessible name of the avatar button. `{who}` is the signed-in username. */
  "account.trigger": "Account: {who}",
  /** Stands in for the username until the server has said who is signed in. */
  "account.fallbackName": "account",
  /** Opens the editor's Settings screen. */
  "account.settings": "Settings",
  "account.signOut": "Sign out",

  // --- theme toggle (in the account menu) ---------------------------------------------------
  /** Shown while the light theme is on: switches to dark. */
  "theme.dark": "Dark theme",
  /** Shown while the dark theme is on: switches to light. */
  "theme.light": "Light theme",

  // --- setup: the sign-in screen when no external sign-in page is configured ----------------
  "setup.intro": "Paste an editor/reviewer JWT to sign in.",
  /** When the shell declared no backend. `<code>…</code>` renders as code. */
  "setup.introWithWorker": "Point at your Worker and paste an editor/reviewer JWT. CORS must allow this origin (<code>CORS_ORIGINS</code>).",
  "setup.baseUrl": "Worker base URL",
  "setup.tenant": "Tenant",
  "setup.token": "Bearer token (editor or reviewer)",
  "setup.connect": "Connect",

  // --- session ------------------------------------------------------------------------------
  /** The default prompt before leaving a screen with unsaved edits. */
  "session.unsavedChanges": "You have unsaved changes. Leave anyway?",

  // --- 404 ----------------------------------------------------------------------------------
  "notFound.eyebrow": "Not found",
  "notFound.title": "Nothing lives here",
  "notFound.body": "That page doesn't exist.",
  "notFound.back": "← back to pages",

  // --- apps route: a project's own screen ---------------------------------------------------
  "adminPage.back": "← Pages",
  /** `{slug}` is the slug from the address bar. */
  "adminPage.unknown": "Unknown page: {slug}",
  /** The server lists the panel, but no loaded bundle registered it. */
  "adminPage.panelMissing": "No panel is registered for '{slug}'. Check that this deployment's panel bundle is listed in the admin's `panels` config and calls registerPanel({ slug: \"{slug}\", … }).",

  // --- panels: a project's own React screen -------------------------------------------------
  /** Rendered in place of a panel that threw while rendering; the error follows on its own
   * line. `<strong>…</strong>` wraps the slug. */
  "panel.failed": "The <strong>{slug}</strong> panel failed to render.",
  /** The error line when the panel threw something with no message. */
  "panel.noMessage": "threw a value with no message",
  /** Why a panel bundle was turned away, shown on its route (and in the console).
   * `{implemented}` is the contract this editor implements, `{react}` its React major. */
  "panel.contract.missing": "The '{slug}' panel did not state which panel runtime contract it was built against. Add `contract: {implemented}` to its registerPanel() call and rebuild it against the @pramen/cms-editor this admin serves (React {react}).",
  /** `{stated}` is the contract the bundle was built against (older than this editor's). */
  "panel.contract.stale": "The '{slug}' panel was built against panel runtime contract {stated}, and this editor implements {implemented}. Rebuild the bundle against the @pramen/cms-editor this admin serves (React {react}) and set `contract: {implemented}` in its registerPanel() call.",
  /** `{stated}` is the contract the bundle was built against (newer than this editor's). */
  "panel.contract.ahead": "The '{slug}' panel was built against panel runtime contract {stated}, and this editor implements {implemented}. Upgrade @pramen/cms-editor (and the shell that serves it) to the release implementing contract {stated}, or rebuild the panel against this one.",
  /** `{type}` is a JavaScript `typeof` answer ("string", "undefined", …). */
  "panel.renderNotComponent": "The '{slug}' panel was ignored: 'render' must be a React component, and this one is of type {type}.",

  // --- api: transport errors shown in the banner --------------------------------------------
  /** `{status}` is the HTTP status code. */
  "api.nonJson": "non-JSON response (HTTP {status})",
  "api.requestFailed": "request failed (HTTP {status})",
  /** Appended to the server's error on a 403. Starts with a space. */
  "api.forbiddenHint": " (check your token has an editor/reviewer role)",
  "api.uploadFailed": "upload failed (HTTP {status})",
};

export const cs: Translation<typeof en> = {
  "nav.pages": "Stránky",
  "nav.media": "Média",
  "nav.menus": "Menu",
  "nav.taxonomies": "Taxonomie",
  "nav.widgets": "Widgety",
  "nav.redirects": "Přesměrování",
  "nav.types": "Struktura obsahu",
  "nav.users": "Uživatelé",
  "nav.settings": "Nastavení",

  "nav.section.content": "Obsah",
  "nav.section.site": "Web",
  "nav.section.apps": "Aplikace",
  "nav.section.system": "Systém",

  "chrome.home": "{brand}: úvod",
  "chrome.sidebar": "Postranní panel",
  "chrome.primaryNav": "Hlavní navigace",
  "chrome.showNav": "Zobrazit navigaci",
  "chrome.hideNav": "Skrýt navigaci",
  "chrome.navDialog": "Navigace",
  "chrome.expandSidebar": "Rozbalit postranní panel",
  "chrome.collapseSidebar": "Sbalit postranní panel",

  "breadcrumb.label": "Drobečková navigace",

  "account.trigger": "Účet: {who}",
  "account.fallbackName": "účet",
  "account.settings": "Nastavení účtu",
  "account.signOut": "Odhlásit se",

  "theme.dark": "Tmavý režim",
  "theme.light": "Světlý režim",

  "setup.intro": "Pro přihlášení vložte JWT token s rolí editor nebo reviewer.",
  "setup.introWithWorker": "Zadejte adresu svého Workeru a vložte JWT token s rolí editor nebo reviewer. CORS musí tento původ povolovat (<code>CORS_ORIGINS</code>).",
  "setup.baseUrl": "Základní URL Workeru",
  "setup.tenant": "Tenant",
  "setup.token": "Bearer token (editor nebo reviewer)",
  "setup.connect": "Připojit",

  "session.unsavedChanges": "Máte neuložené změny. Opravdu odejít?",

  "notFound.eyebrow": "Nenalezeno",
  "notFound.title": "Tady nic není",
  "notFound.body": "Tato stránka neexistuje.",
  "notFound.back": "← zpět na stránky",

  "adminPage.back": "← Stránky",
  "adminPage.unknown": "Neznámá stránka: {slug}",
  "adminPage.panelMissing": "Pro „{slug}“ není zaregistrovaný žádný panel. Ověřte, že je balíček panelů této instalace uvedený v konfiguraci `panels` administrace a volá registerPanel({ slug: \"{slug}\", … }).",

  "panel.failed": "Panel <strong>{slug}</strong> se nepodařilo vykreslit.",
  "panel.noMessage": "chyba bez popisu",
  "panel.contract.missing": "Panel „{slug}“ neuvádí, proti kterému kontraktu runtime panelů byl sestaven. Doplňte `contract: {implemented}` do jeho volání registerPanel() a sestavte ho znovu proti @pramen/cms-editor, který tato administrace používá (React {react}).",
  "panel.contract.stale": "Panel „{slug}“ byl sestaven proti kontraktu runtime panelů {stated}, tento editor ale implementuje {implemented}. Sestavte balíček znovu proti @pramen/cms-editor, který tato administrace používá (React {react}), a ve volání registerPanel() nastavte `contract: {implemented}`.",
  "panel.contract.ahead": "Panel „{slug}“ byl sestaven proti kontraktu runtime panelů {stated}, tento editor ale implementuje {implemented}. Aktualizujte @pramen/cms-editor (i shell, který ho servíruje) na verzi s kontraktem {stated}, nebo panel sestavte znovu proti této verzi.",
  "panel.renderNotComponent": "Panel „{slug}“ byl ignorován: „render“ musí být komponenta Reactu, tato je typu {type}.",

  "api.nonJson": "odpověď není JSON (HTTP {status})",
  "api.requestFailed": "požadavek selhal (HTTP {status})",
  "api.forbiddenHint": " (ověřte, že má váš token roli editor nebo reviewer)",
  "api.uploadFailed": "nahrání selhalo (HTTP {status})",
};
