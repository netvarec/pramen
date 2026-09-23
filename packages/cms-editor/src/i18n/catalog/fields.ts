// Copy of the editor's fields area: the field widgets of a form (`fields.tsx`), the media and
// relation pickers, and the editor's own words around a Block Kit page (`blockkit.tsx`). Text
// a Block Kit page's server sends is data and never passes through here. See `./index.ts` for
// how the areas are assembled.

import type { Translation } from "../types";

export const en = {
  // --- publish field
  "field.publish.notPublished": "Not published",
  /** `{when}` is the scheduled date and time, formatted for the locale. */
  "field.publish.scheduledFor": "Scheduled for {when}",
  /** `{when}` is the date and time it went live, formatted for the locale. */
  "field.publish.publishedAt": "Published {when}",
  "field.publish.now": "Publish now",
  "field.publish.changeSchedule": "Change schedule",
  "field.publish.changeTime": "Change time",
  "field.publish.schedule": "Schedule…",
  "field.publish.unpublish": "Unpublish",

  // --- slug field
  /** The button under a slug field that fills it from another field. `{from}` is that field's
   * name, `{suggestion}` the slug it would produce. */
  "field.slug.generateFrom": "Generate from {from}: {suggestion}",

  // --- select field
  /** The empty first option of a dropdown: "nothing chosen". Also used by Block Kit selects. */
  "field.select.none": "–",

  // --- rich text
  /** The rich-text editor's placeholder while the document is empty. */
  "richText.placeholder": "Write, or press '/' for blocks…",

  // --- repeater
  "repeater.dragToReorder": "Drag to reorder",
  "repeater.moveUp": "Move up",
  "repeater.moveDown": "Move down",
  "repeater.empty": "None yet.",
  /** The button under a repeater. `{label}` is the repeater's own label, as the app declared it. */
  "repeater.add": "+ Add {label}",

  // --- media field
  /** Beside the pick button when the field holds no file. */
  "mediaField.none": "no media",
  "mediaField.pick": "pick",
  "mediaField.clear": "clear",

  // --- pickers (media and relation dialogs)
  /** The media picker's title. `<dim>…</dim>` is rendered dimmed. */
  "picker.media.title": "Choose <dim>a file</dim> from the library",
  "picker.media.upload": "Upload a new file",
  "picker.media.empty": "The library is empty. Upload a file above.",
  /** The relation picker's title. `{title}` is the field's label, lower-cased; `<dim>…</dim>`
   * is rendered dimmed. */
  "picker.relation.title": "Choose <dim>{title}</dim>",
  /** Beside an option that is already in the field. */
  "picker.selected": "selected",
  "picker.noMatches": "Nothing matches.",
  /** The button at the foot of a picker that closes it. */
  "picker.close": "close",
  /** The same button in a picker that adds several at once. */
  "picker.done": "done",

  // --- relation (reference) field
  /** Shown in place of a stored record's label while it is being looked up. */
  "relation.loading": "Loading...",
  /** A schema mistake, shown to whoever can fix it. `referenceFrom` is a code identifier. */
  "relation.noHandler": "This reference field declares no `referenceFrom` handler.",
  "relation.nothingSelected": "Nothing selected.",
  "relation.remove": "remove",
  "relation.add": "+ Add",
  "relation.change": "Change",
  "relation.choose": "Choose",

  // --- Block Kit page (the editor's own words; the page's content comes from the server)
  /** Beside the page title while an interaction is in flight. */
  "blockkit.working": "working…",
  "blockkit.loadFailed": "This screen could not be loaded.",
  /** A block type this editor does not know. `{type}` is the type name. */
  "blockkit.unsupportedBlock": "[unsupported block: {type}]",
  /** A table cell this editor does not know. `{type}` is the type name. */
  "blockkit.unsupportedCell": "[unsupported cell: {type}]",
  /** A table with no rows whose page did not say what to show instead. */
  "blockkit.tableEmpty": "Nothing here.",
  /** A true / false value in a table cell. */
  "blockkit.yes": "yes",
  "blockkit.no": "no",
  /** Beside a form's disabled submit button. `{fields}` is a comma-separated list of labels. */
  "blockkit.fillIn": "Fill in: {fields}",
};

export const cs: Translation<typeof en> = {
  "field.publish.notPublished": "Nepublikováno",
  "field.publish.scheduledFor": "Naplánováno na {when}",
  "field.publish.publishedAt": "Publikováno {when}",
  "field.publish.now": "Publikovat hned",
  "field.publish.changeSchedule": "Změnit plán",
  "field.publish.changeTime": "Změnit čas",
  "field.publish.schedule": "Naplánovat…",
  "field.publish.unpublish": "Zrušit publikování",

  "field.slug.generateFrom": "Vytvořit z pole {from}: {suggestion}",

  "field.select.none": "–",

  "richText.placeholder": "Pište, nebo stiskněte „/“ pro vložení bloku…",

  "repeater.dragToReorder": "Přetažením změníte pořadí",
  "repeater.moveUp": "Posunout nahoru",
  "repeater.moveDown": "Posunout dolů",
  "repeater.empty": "Zatím žádné položky.",
  "repeater.add": "+ Přidat: {label}",

  "mediaField.none": "žádný soubor",
  "mediaField.pick": "Vybrat",
  "mediaField.clear": "Odebrat",

  "picker.media.title": "Vybrat <dim>soubor</dim>",
  "picker.media.upload": "Nahrát nový soubor",
  "picker.media.empty": "Knihovna je prázdná. Nahrajte soubor výše.",
  "picker.relation.title": "Vybrat: <dim>{title}</dim>",
  "picker.selected": "vybráno",
  "picker.noMatches": "Nic nenalezeno.",
  "picker.close": "Zavřít",
  "picker.done": "Hotovo",

  "relation.loading": "Načítám…",
  "relation.noHandler": "Toto pole odkazu nemá nastavený handler `referenceFrom`.",
  "relation.nothingSelected": "Nic nevybráno.",
  "relation.remove": "Odebrat",
  "relation.add": "+ Přidat",
  "relation.change": "Změnit",
  "relation.choose": "Vybrat",

  "blockkit.working": "pracuji…",
  "blockkit.loadFailed": "Tuto obrazovku se nepodařilo načíst.",
  "blockkit.unsupportedBlock": "[nepodporovaný blok: {type}]",
  "blockkit.unsupportedCell": "[nepodporovaná buňka: {type}]",
  "blockkit.tableEmpty": "Nic tu není.",
  "blockkit.yes": "ano",
  "blockkit.no": "ne",
  "blockkit.fillIn": "Vyplňte: {fields}",
};
