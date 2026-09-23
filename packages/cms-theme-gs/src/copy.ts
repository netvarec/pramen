// The theme's own words, in every language the editor ships.
//
// Only what the THEME adds. Everything the editor already says (a screen's name, its count,
// "Close", "Try again") arrives translated as a slot prop or is read with `useI18n().t`, so a
// deployment's `messages` override and the editor's own plural rules reach it without the theme
// restating them. What is here is the Graphic Standard's own voice: the sentence on the CTA
// pill, the dashboard's greeting and its sections, the dashboard tiles' statistics.
//
// `en` is the fallback for a language this file does not cover, per key, which is what
// `defineMessages` promises. `cs` is complete; `test/cms-theme-gs.test.ts` holds the two to the
// same keys and plural categories.

import { defineMessages, type Translation } from "@pramen/cms-editor/i18n";

export const en = {
  // --- the CTA pill: "Let's / create / something new", the middle word set in the brand face.
  "cta.lead": "Let's",
  "cta.emphasis": "create",
  "cta.tail": "something new",
  "cta.media.lead": "Let's",
  "cta.media.emphasis": "upload",
  "cta.media.tail": "new media",
  "cta.users.lead": "Invite",
  "cta.users.emphasis": "colleagues",
  "cta.users.tail": "to the team",

  // --- the media header's upload hub
  "media.hubOpen": "Upload media",
  "media.hubClose": "Close upload",
  "media.hubTitle": "Add files to the library",
  "media.hubBody": "Pick images, videos or documents from your device.",
  "media.emptyTitle": "Your media library is empty for now",
  "media.emptyDescription": "Upload images and files with the button in the header.",
  "media.previewLabel": "File preview",
  "media.detailsLabel": "File details",

  // --- the dashboard at `/`
  "home.welcome": "Welcome back",
  "home.title": "Content administration",
  "home.hubLabel": "What do you want to manage?",
  "home.hubTitleLead": "What do you want to",
  "home.hubTitleEm": "manage?",
  "home.hubClose": "Close the section menu",
  "home.cta.lead": "Let's",
  "home.cta.emphasis": "create",
  "home.cta.tail": "site content",
  "home.start": "Start",
  "home.startLabel": "Start: show what you can work on",
  "home.loadingSections": "Loading sections…",
  "home.group.content": "Site content",
  "home.group.quick": "Quick access",
  "home.openSection": "Open section",
  "home.tile.type": "Create, edit and publish site content.",
  "home.tile.collection": "Manage the records of this collection.",
  "home.tile.media": "Images and files for your content.",
  "home.tile.app": "A tool of this administration.",
  "home.stat.loading": "Loading current numbers…",
  "home.stat.failed": "The numbers could not be loaded.",
  "home.stat.retry": "Try again: {label}",
  /** The noun after a tile's number, WITHOUT the number: the tile sets the two apart. */
  "home.stat.entries": { one: "record in total", other: "records in total" },
  /** Deliberately not agreeing with a number: one line for pages, articles and events alike. */
  "home.stat.status": "Published {published} · drafts {draft}",
  "home.stat.files": { one: "file in the library", other: "files in the library" },
  "home.stat.filesDetail": "Images and documents",
};

export const cs: Translation<typeof en> = {
  "cta.lead": "Pojďme",
  "cta.emphasis": "vytvořit",
  "cta.tail": "něco nového",
  "cta.media.lead": "Pojďme",
  "cta.media.emphasis": "nahrát",
  "cta.media.tail": "nová média",
  "cta.users.lead": "Pozvěte",
  "cta.users.emphasis": "kolegy",
  "cta.users.tail": "do týmu",

  "media.hubOpen": "Nahrát média",
  "media.hubClose": "Zavřít nahrávání",
  "media.hubTitle": "Přidat soubory do knihovny",
  "media.hubBody": "Vyberte obrázky, videa nebo dokumenty ze svého zařízení.",
  "media.emptyTitle": "Vaše knihovna médií je zatím prázdná",
  "media.emptyDescription": "Nahrajte obrázky a soubory pomocí tlačítka v hlavičce.",
  "media.previewLabel": "Náhled souboru",
  "media.detailsLabel": "Informace o souboru",

  "home.welcome": "Vítejte zpět",
  "home.title": "Správa obsahu",
  "home.hubLabel": "Co chcete spravovat?",
  "home.hubTitleLead": "Co chcete",
  "home.hubTitleEm": "spravovat?",
  "home.hubClose": "Zavřít nabídku sekcí",
  "home.cta.lead": "Pojďme",
  "home.cta.emphasis": "tvořit",
  "home.cta.tail": "obsah webu",
  "home.start": "Začít",
  "home.startLabel": "Začít: zobrazit možnosti práce s obsahem",
  "home.loadingSections": "Načítám dostupné sekce…",
  "home.group.content": "Obsah webu",
  "home.group.quick": "Rychlé přístupy",
  "home.openSection": "Otevřít sekci",
  "home.tile.type": "Vytvářejte, upravujte a publikujte obsah webu.",
  "home.tile.collection": "Spravujte záznamy této kolekce.",
  "home.tile.media": "Obrázky a soubory pro obsah webu.",
  "home.tile.app": "Nástroj této administrace.",
  "home.stat.loading": "Načítám aktuální čísla…",
  "home.stat.failed": "Čísla se nepodařilo načíst.",
  "home.stat.retry": "Zkusit načíst znovu: {label}",
  "home.stat.entries": { one: "záznam celkem", few: "záznamy celkem", many: "záznamu celkem", other: "záznamů celkem" },
  // "Publikováno", not "publikovaných": the neutral form agrees with no number and no gender,
  // and this one line counts Stránky (f.), Články (m.) and Akce (f.) alike.
  "home.stat.status": "Publikováno {published} · v konceptu {draft}",
  "home.stat.files": { one: "soubor v knihovně", few: "soubory v knihovně", many: "souboru v knihovně", other: "souborů v knihovně" },
  "home.stat.filesDetail": "Obrázky a dokumenty",
};

export const copy = defineMessages({ en, cs });
