// Copy of the editor's furniture area. See `./index.ts` for how the areas are assembled.
//
// Menus, redirects, taxonomies (vocabularies and their terms) and widget areas: the four
// site-level screens in `furniture.tsx` and their routes.

import type { Translation } from "../types";

export const en = {
  // --- shared by the four screens ------------------------------------------------------
  /** Shown instead of any of these screens when the server has no site-furniture handlers. */
  "furniture.unavailable": "This deployment's CMS does not provide site furniture.",
  "furniture.label": "Label",
  /** The machine name a layout reads a menu / widget area / vocabulary / term by. */
  "furniture.key": "Key",
  /** Hint under the key of a new menu or widget area. */
  "furniture.keyHint.layout": "What your layout asks for. Not renameable afterwards.",
  /** The short confirmation after a menu or widget area is saved. */
  "furniture.saved": "saved",
  "furniture.moveUp": "Move up",
  "furniture.moveDown": "Move down",
  /** The empty first option of a select (a menu item's target, a menu widget's menu). */
  "furniture.pickOne": "Pick one…",
  /** A row's small delete button (a redirect, a term). */
  "furniture.delete": "delete",

  // --- menus list ----------------------------------------------------------------------
  "menus.lead": "Navigation",
  /** The header's summary when there are no menus. */
  "menus.none": "0 menus",
  "menus.count": { one: "{count} menu", other: "{count} menus" },
  /** `<code>` renders as code. */
  "menus.empty": "No menus yet. A menu is read by name (<code>getMenu(\"primary\")</code>) from your layout.",
  /** A menu row's number of items, nested ones included. */
  "menus.itemCount": { one: "{count} item", other: "{count} items" },
  "menus.new": "New menu",
  "menus.create": "Create menu",

  // --- one menu ------------------------------------------------------------------------
  /** The detail header's way back to the list. */
  "menu.parent": "Menus",
  "menu.unknown": "Unknown menu: {name}",
  /** `{label}` is the menu's label. */
  "menu.confirmDelete": "Delete the menu “{label}”? Any layout reading it will render nothing.",
  /** The label a freshly added item starts with. */
  "menu.newItem": "New item",
  "menu.noItems": "No items yet.",
  "menu.addItem": "+ Add item",
  "menu.save": "Save menu",
  "menu.delete": "Delete menu",
  /** A menu item's kind select; the options below complete the sentence. */
  "menu.item.pointsAt": "Points at",
  "menu.kind.custom": "A URL",
  "menu.kind.page": "A page",
  "menu.kind.term": "A term",
  "menu.kind.collection": "A collection",
  "menu.item.indent": "Nest under the item above",
  "menu.item.outdent": "Move out a level",
  "menu.item.url": "URL",
  "menu.item.urlPlaceholder": "/about or https://…",
  "menu.item.target": "Target",
  /** A menu item's link-target select; the options below complete the sentence. */
  "menu.item.opensIn": "Opens in",
  "menu.item.sameTab": "this tab",
  "menu.item.newTab": "a new tab",
  "menu.item.needsTarget": "Pick a target, or this item cannot be saved.",
  "menu.item.resolvedHint": "The URL is worked out when the menu is read, so it follows the target. An item whose target is unpublished or gone is left out of the public menu rather than rendered as a dead link.",

  // --- redirects -----------------------------------------------------------------------
  "redirects.lead": "Old URLs, kept alive",
  "redirects.none": "0 redirects",
  "redirects.count": { one: "{count} redirect", other: "{count} redirects" },
  "redirects.intro": "Changing a page's slug changes a live URL and breaks every link to it. A redirect is how the old one keeps working. Disabling one keeps the record of what the old URL was, which deleting it does not.",
  "redirects.empty": "No redirects yet.",
  "redirects.disable": "disable",
  "redirects.enable": "enable",
  /** `{from}` is the redirected path. */
  "redirects.confirmDelete": "Delete the redirect from {from}?",
  "redirects.new": "New redirect",
  "redirects.from": "From (a path on this site)",
  "redirects.fromPlaceholder": "/old-page",
  "redirects.to": "To (a path, or a full URL)",
  "redirects.toPlaceholder": "/new-page",
  "redirects.status": "Status",
  /** An HTTP status option; `{status}` is the code (301, 308). */
  "redirects.status.permanent": "{status} permanent",
  /** An HTTP status option; `{status}` is the code (302, 307). */
  "redirects.status.temporary": "{status} temporary",
  "redirects.add": "Add redirect",

  // --- vocabularies list ---------------------------------------------------------------
  /** The screen title, read as one phrase with `taxonomies.leadEm`. */
  "taxonomies.lead": "How this site",
  "taxonomies.leadEm": "is classified",
  "taxonomies.intro": "A vocabulary is a way of grouping pages (categories, tags, regions). There are no built-in ones: a deployment declares what it sorts by, the same way it declares its content types.",
  "taxonomies.empty": "No vocabularies yet.",
  /** A vocabulary row: its terms can nest. */
  "taxonomies.nested": "nested",
  /** A vocabulary row: its terms cannot nest. */
  "taxonomies.flat": "flat",
  /** A vocabulary row's scope when it applies to everything. */
  "taxonomies.everything": "everything",
  "taxonomies.new": "New vocabulary",
  "taxonomies.keyHint": "A URL segment: terms live under it. Not renameable afterwards.",
  "taxonomies.hierarchical": "Terms can nest (categories rather than tags)",
  "taxonomies.create": "Create vocabulary",
  "taxonomies.appliesTo": "Applies to",
  "taxonomies.appliesTo.everything": "Everything",
  "taxonomies.target.page": "Pages",
  "taxonomies.target.media": "Media",

  // --- one vocabulary ------------------------------------------------------------------
  /** The detail header's way back to the list. */
  "taxonomy.parent": "Taxonomies",
  "taxonomy.unknown": "Unknown vocabulary: {slug}",
  /** `{label}` is the vocabulary's label. */
  "taxonomy.confirmDelete": "Delete the vocabulary “{label}”? Every term in it goes too, along with every page's assignments.",
  "taxonomy.scope.title": "Where this vocabulary is offered",
  "taxonomy.scope.hint": "Narrowing is refused while the vocabulary is still assigned to something it would stop applying to. Remove those assignments first, so nothing is left tagged with a vocabulary you can no longer see.",
  "taxonomy.delete": "Delete this vocabulary",

  // --- a vocabulary's terms ------------------------------------------------------------
  "taxonomyTerms.empty": "No terms yet.",
  /** The accessible name of a term's label input; `{label}` is its current label. */
  "taxonomyTerms.labelFor": "Label for {label}",
  /** `{label}` is the term's label. */
  "taxonomyTerms.confirmDelete": "Delete “{label}”? Pages tagged with it lose the tag; any terms under it move to the top level.",
  "taxonomyTerms.new": "New term",
  "taxonomyTerms.keyHint": "The URL segment for this term.",
  "taxonomyTerms.parent": "Nested under",
  /** The parent select's option for no parent. */
  "taxonomyTerms.topLevel": "(top level)",
  "taxonomyTerms.add": "Add term",

  // --- widget areas list ---------------------------------------------------------------
  /** The screen title, read as one phrase with `widgets.leadEm`. */
  "widgets.lead": "Parts of the layout",
  "widgets.leadEm": "you can fill in",
  /** `<code>` renders as code. */
  "widgets.intro": "A widget area is a named slot in your layout (a sidebar, a footer column) that an editor fills without touching code. Your layout reads one by name: <code>getWidgetArea(\"sidebar\")</code>.",
  "widgets.empty": "No widget areas yet.",
  /** A widget area row's number of widgets. */
  "widgets.count": { one: "{count} widget", other: "{count} widgets" },
  "widgets.new": "New widget area",
  "widgets.create": "Create widget area",

  // --- one widget area -----------------------------------------------------------------
  /** The detail header's way back to the list. */
  "widgetArea.parent": "Widgets",
  "widgetArea.unknown": "Unknown widget area: {name}",
  /** `{label}` is the area's label. */
  "widgetArea.confirmDelete": "Delete the widget area “{label}”?",
  "widgetArea.empty": "No widgets yet.",
  "widgetArea.addText": "+ Text",
  "widgetArea.addMenu": "+ Menu",
  "widgetArea.addComponent": "+ Component",
  "widgetArea.delete": "Delete area",
  /** A widget's kind, shown small at the top of its card. */
  "widgetArea.type.content": "content",
  "widgetArea.type.menu": "menu",
  "widgetArea.type.component": "component",
  "widgetArea.titlePlaceholder": "Title (optional)",
  "widgetArea.titleLabel": "Widget title",
  "widgetArea.menu": "Menu",
  "widgetArea.componentId": "Component id: your front end maps this to one of its own components",
  "widgetArea.props": "Props (JSON object, optional)",
  "widgetArea.propsInvalid": "Not a JSON object. The last valid value is what will be saved.",
};

export const cs: Translation<typeof en> = {
  "furniture.unavailable": "CMS tohoto webu nepodporuje menu, přesměrování, taxonomie ani widgety.",
  "furniture.label": "Název",
  "furniture.key": "Klíč",
  "furniture.keyHint.layout": "Podle tohoto klíče čte obsah šablona. Později nejde změnit.",
  "furniture.saved": "uloženo",
  "furniture.moveUp": "Posunout nahoru",
  "furniture.moveDown": "Posunout dolů",
  "furniture.pickOne": "Vyberte…",
  "furniture.delete": "odstranit",

  "menus.lead": "Navigace",
  "menus.none": "Zatím žádné menu",
  "menus.count": { one: "{count} menu", few: "{count} menu", many: "{count} menu", other: "{count} menu" },
  "menus.empty": "Zatím žádné menu. Šablona čte menu podle názvu: <code>getMenu(\"primary\")</code>.",
  "menus.itemCount": { one: "{count} položka", few: "{count} položky", many: "{count} položky", other: "{count} položek" },
  "menus.new": "Nové menu",
  "menus.create": "Vytvořit menu",

  "menu.parent": "Menu",
  "menu.unknown": "Neznámé menu: {name}",
  "menu.confirmDelete": "Odstranit menu „{label}“? Šablony, které ho čtou, nevykreslí nic.",
  "menu.newItem": "Nová položka",
  "menu.noItems": "Zatím žádné položky.",
  "menu.addItem": "+ Přidat položku",
  "menu.save": "Uložit menu",
  "menu.delete": "Odstranit menu",
  "menu.item.pointsAt": "Odkazuje na",
  "menu.kind.custom": "Adresu URL",
  "menu.kind.page": "Stránku",
  "menu.kind.term": "Termín",
  "menu.kind.collection": "Kolekci",
  "menu.item.indent": "Zanořit pod položku výše",
  "menu.item.outdent": "Vysunout o úroveň výš",
  "menu.item.url": "Adresa URL",
  "menu.item.urlPlaceholder": "/o-nas nebo https://…",
  "menu.item.target": "Cíl",
  "menu.item.opensIn": "Otevírá se v",
  "menu.item.sameTab": "tomto panelu",
  "menu.item.newTab": "novém panelu",
  "menu.item.needsTarget": "Vyberte cíl, jinak položku nepůjde uložit.",
  "menu.item.resolvedHint": "Adresa se dopočítá až při čtení menu, takže vždy vede na aktuální cíl. Položka, jejíž cíl není publikovaný nebo už neexistuje, se ve veřejném menu vynechá, aby nevedla na nefunkční odkaz.",

  "redirects.lead": "Staré adresy, stále funkční",
  "redirects.none": "Zatím žádné přesměrování",
  "redirects.count": { one: "{count} přesměrování", few: "{count} přesměrování", many: "{count} přesměrování", other: "{count} přesměrování" },
  "redirects.intro": "Změnou slugu stránky se změní její živá adresa a rozbijí se všechny odkazy na ni. Přesměrování zajistí, že stará adresa dál funguje. Vypnuté přesměrování uchová záznam o původní adrese, smazané ne.",
  "redirects.empty": "Zatím žádná přesměrování.",
  "redirects.disable": "vypnout",
  "redirects.enable": "zapnout",
  "redirects.confirmDelete": "Odstranit přesměrování z {from}?",
  "redirects.new": "Nové přesměrování",
  "redirects.from": "Z (cesta na tomto webu)",
  "redirects.fromPlaceholder": "/stara-stranka",
  "redirects.to": "Na (cesta nebo celá adresa URL)",
  "redirects.toPlaceholder": "/nova-stranka",
  "redirects.status": "Stavový kód",
  "redirects.status.permanent": "{status} trvalé",
  "redirects.status.temporary": "{status} dočasné",
  "redirects.add": "Přidat přesměrování",

  "taxonomies.lead": "Jak se na tomto webu",
  "taxonomies.leadEm": "třídí obsah",
  "taxonomies.intro": "Slovník je způsob, jak seskupovat stránky (kategorie, štítky, regiony). Žádné nejsou předem dané: web si sám určí, podle čeho třídí, stejně jako si určuje typy obsahu.",
  "taxonomies.empty": "Zatím žádné slovníky.",
  "taxonomies.nested": "vnořený",
  "taxonomies.flat": "plochý",
  "taxonomies.everything": "vše",
  "taxonomies.new": "Nový slovník",
  "taxonomies.keyHint": "Část adresy URL, pod kterou leží termíny. Později nejde změnit.",
  "taxonomies.hierarchical": "Termíny lze vnořovat (spíš kategorie než štítky)",
  "taxonomies.create": "Vytvořit slovník",
  "taxonomies.appliesTo": "Platí pro",
  "taxonomies.appliesTo.everything": "Vše",
  "taxonomies.target.page": "Stránky",
  "taxonomies.target.media": "Média",

  "taxonomy.parent": "Taxonomie",
  "taxonomy.unknown": "Neznámý slovník: {slug}",
  "taxonomy.confirmDelete": "Odstranit slovník „{label}“? Zmizí i všechny jeho termíny a jejich přiřazení ke stránkám.",
  "taxonomy.scope.title": "Kde se slovník nabízí",
  "taxonomy.scope.hint": "Zúžení nejde uložit, dokud je slovník přiřazený k něčemu, pro co by přestal platit. Nejdřív tato přiřazení odeberte, aby nic nezůstalo označené slovníkem, který už neuvidíte.",
  "taxonomy.delete": "Odstranit tento slovník",

  "taxonomyTerms.empty": "Zatím žádné termíny.",
  "taxonomyTerms.labelFor": "Název termínu {label}",
  "taxonomyTerms.confirmDelete": "Odstranit „{label}“? Stránky o tento termín přijdou a termíny pod ním se přesunou na nejvyšší úroveň.",
  "taxonomyTerms.new": "Nový termín",
  "taxonomyTerms.keyHint": "Část adresy URL pro tento termín.",
  "taxonomyTerms.parent": "Nadřazený termín",
  "taxonomyTerms.topLevel": "(nejvyšší úroveň)",
  "taxonomyTerms.add": "Přidat termín",

  "widgets.lead": "Části šablony,",
  "widgets.leadEm": "které můžete vyplnit",
  "widgets.intro": "Oblast widgetů je pojmenované místo v šabloně (postranní panel, sloupec v patičce), které redaktor vyplní bez zásahu do kódu. Šablona ji čte podle názvu: <code>getWidgetArea(\"sidebar\")</code>.",
  "widgets.empty": "Zatím žádné oblasti widgetů.",
  "widgets.count": { one: "{count} widget", few: "{count} widgety", many: "{count} widgetu", other: "{count} widgetů" },
  "widgets.new": "Nová oblast widgetů",
  "widgets.create": "Vytvořit oblast widgetů",

  "widgetArea.parent": "Widgety",
  "widgetArea.unknown": "Neznámá oblast widgetů: {name}",
  "widgetArea.confirmDelete": "Odstranit oblast widgetů „{label}“?",
  "widgetArea.empty": "Zatím žádné widgety.",
  "widgetArea.addText": "+ Text",
  "widgetArea.addMenu": "+ Menu",
  "widgetArea.addComponent": "+ Komponenta",
  "widgetArea.delete": "Odstranit oblast",
  "widgetArea.type.content": "text",
  "widgetArea.type.menu": "menu",
  "widgetArea.type.component": "komponenta",
  "widgetArea.titlePlaceholder": "Nadpis (nepovinné)",
  "widgetArea.titleLabel": "Nadpis widgetu",
  "widgetArea.menu": "Menu",
  "widgetArea.componentId": "ID komponenty: web ho přiřadí jedné ze svých komponent",
  "widgetArea.props": "Vlastnosti (objekt JSON, nepovinné)",
  "widgetArea.propsInvalid": "Toto není objekt JSON. Uloží se poslední platná hodnota.",
};
