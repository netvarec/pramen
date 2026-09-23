// Words the editor says in more than one place, and the wording of lists and counts.
//
// The successor of `copy.ts`'s `COMMON_COPY`: one table for the "Close" a dozen dialogs share,
// so a translation says it once and cannot differ by a capital letter between two screens.
// Screen-specific copy lives in its screen's own catalog file beside this one.

import type { Translation } from "../types";

export const en = {
  /** The accessible name of every dialog's ✕. podoba defaults it to "Close" already; passing
   * it explicitly is what makes it translatable, since a default inside the design system is a
   * string no host can reach. */
  "common.close": "Close",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.saving": "Saving…",
  "common.saved": "Saved",
  "common.delete": "Delete",
  "common.remove": "Remove",
  "common.create": "Create",
  "common.creating": "Creating…",
  "common.edit": "Edit",
  "common.add": "Add",
  "common.done": "Done",
  "common.back": "Back",
  "common.search": "Search",
  "common.untitled": "untitled",
  /** A list's header while its first page is in flight. */
  "common.loading": "Loading…",
  /** A list's header when its first page never arrived. The error itself is in the banner;
   * this only has to stop the header from claiming "None yet" about data it never saw. */
  "common.loadFailed": "Not loaded",
  /** The body line under a list whose first page failed, and the button that asks again. */
  "common.loadFailedBody": "This list could not be loaded.",
  "common.retry": "Try again",
  "common.loadMore": "Load more",
  /** A list header's summary when the answer is zero. */
  "common.noneYet": "None yet",
  /** The same under a search or a filter: zero of what was asked for, not zero overall. */
  "common.noMatches": "No matches",

  // --- entries: the wording of a content type's pages and a collection's rows ---------------
  //
  // A type or collection may declare its own nouns (`labels` on `defineContentType` /
  // `collection`, see `entry-labels.ts`); these are what is said when it did not. English
  // keeps what the editor always said. Neutral in other languages on purpose: a Czech noun has
  // a gender the "New" in front of it must agree with, so a label cannot be slotted into a
  // fixed "Nový {label}" without getting a third of them wrong.

  /** The page list's create button when the type declares no `newItem`. */
  "entries.pages.new": "+ New page",
  /** The page list's count when the type declares no `count` nouns. */
  "entries.pages.count": { one: "{count} page total", other: "{count} pages total" },
  /** The page list's count built from a type's own nouns; `{noun}` is the form for `{count}`. */
  "entries.pages.countLabelled": "{count} {noun} total",
  /** A collection's create button when it declares no `newItem`. `{label}` is its singular
   * label, lower-cased. */
  "entries.collection.new": "+ New {label}",
  /** A collection's count when it declares no `count` nouns. `{label}` / `{pluralLabel}` are
   * its labels, lower-cased. */
  "entries.collection.count": { one: "{count} {label}", other: "{count} {pluralLabel}" },
  "entries.collection.countLabelled": "{count} {noun}",
  /** A create button built from a declared `newItem` ("New article"). */
  "entries.newLabelled": "+ {newItem}",
};

export const cs: Translation<typeof en> = {
  "common.close": "Zavřít",
  "common.cancel": "Zrušit",
  "common.save": "Uložit",
  "common.saving": "Ukládám…",
  "common.saved": "Uloženo",
  "common.delete": "Odstranit",
  "common.remove": "Odebrat",
  "common.create": "Vytvořit",
  "common.creating": "Vytvářím…",
  "common.edit": "Upravit",
  "common.add": "Přidat",
  "common.done": "Hotovo",
  "common.back": "Zpět",
  "common.search": "Hledat",
  "common.untitled": "bez názvu",
  "common.loading": "Načítám…",
  "common.loadFailed": "Nenačteno",
  "common.loadFailedBody": "Seznam se nepodařilo načíst.",
  "common.retry": "Zkusit znovu",
  "common.loadMore": "Načíst další",
  "common.noneYet": "Zatím žádné záznamy",
  "common.noMatches": "Žádná shoda",

  "entries.pages.new": "+ Nový obsah",
  "entries.pages.count": { one: "{count} záznam", few: "{count} záznamy", many: "{count} záznamu", other: "{count} záznamů" },
  "entries.pages.countLabelled": "{count} {noun}",
  "entries.collection.new": "+ Nový záznam",
  "entries.collection.count": { one: "{count} záznam", few: "{count} záznamy", many: "{count} záznamu", other: "{count} záznamů" },
  "entries.collection.countLabelled": "{count} {noun}",
  "entries.newLabelled": "+ {newItem}",
};
