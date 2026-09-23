// Copy of the editor's schema area: the Types screen (`/schema`), the block-type and
// content-type builders, and the field-schema editor they share. See `./index.ts` for how the
// areas are assembled.

import type { Translation } from "../types";

export const en = {
  // --- shared by the three schema routes ---------------------------------------------------
  /** Shown instead of the Types screen or a builder to a session without an editor role. */
  "schema.needsEditor": "Authoring types needs an editor role.",
  /** The detail header's way back from a builder to the Types screen. */
  "schema.parent": "Types",
  /** The short confirmation that flashes after a builder saves. Lower-case on purpose. */
  "schema.savedFlash": "saved",
  /** The builders' Name and Slug inputs, shared by block types and content types. */
  "schema.name": "Name",
  "schema.slug": "Slug",
  /** After "Slug" on an existing type, whose slug cannot change. */
  "schema.slugFixed": "(fixed)",

  // --- the types overview ------------------------------------------------------------------
  /** The screen's title is two lines: this dimmed lead, then `schema.titleMain`. */
  "schema.titleLead": "The shape of",
  "schema.titleMain": "this site",
  /** `<strong>…</strong>` marks the two defined terms. */
  "schema.intro": "A <strong>block type</strong> is a set of fields an editor fills in. A <strong>content type</strong> is a kind of page: the regions it has, and which block types may go in each. Nothing can be authored until there is one of each.",
  "schema.blockTypes": "Block types",
  "schema.blockTypesEmpty": "No block types yet. A page is built from these, so start here.",
  "schema.newBlockType": "+ New block type",
  "schema.contentTypes": "Content types",
  "schema.contentTypesEmpty": "No content types yet. A page needs one: it is what declares the regions blocks go into.",
  "schema.newContentType": "+ New content type",
  /** A block type row's field count. */
  "schema.fieldCount": { one: "{count} field", other: "{count} fields" },
  /** A content type row's region count. */
  "schema.regionCount": { one: "{count} region", other: "{count} regions" },

  // --- code-defined types --------------------------------------------------------------------
  /** The badge on a type declared in code. */
  "schema.codeBadge": "code",
  "schema.codeBadgeTitle": "Defined in code, read-only here",
  /** Above a read-only builder. `{what}` is `schema.managed.blockType` or
   * `schema.managed.contentType`; `{call}` is the declaration, e.g. `defineBlockType("hero", …)`;
   * `{owner}` is `schema.managed.owner` or nothing. `<strong>` and `<code>` are markup. */
  "schema.managed.body": "This {what} is <strong>defined in code</strong>: <code>{call}</code>, applied on every boot by <code>cmsBootstrap</code>{owner}. It is read-only here: a change saved from this screen would be reverted at the next deploy or cold start. Edit the declaration and redeploy.",
  /** Appended to `schema.managed.body` when the type belongs to a module other than the CMS. */
  "schema.managed.owner": " (owner <code>{owner}</code>)",
  "schema.managed.blockType": "block type",
  "schema.managed.contentType": "content type",

  // --- block-type builder ------------------------------------------------------------------
  "blockType.new": "New block type",
  "blockType.unknown": "Unknown block type: {slug}",
  /** The accessible name of the builder's form. */
  "blockType.formLabel": "Block type",
  "blockType.slugHelpNew": "The key a front end maps to a component. Lowercase letters, digits, hyphens or underscores.",
  "blockType.slugHelpFixed": "A block type's slug is its registry key: renaming it would orphan every block of this type.",
  "blockType.icon": "Icon",
  "blockType.iconPlaceholder": "e.g. 🖼",
  "blockType.category": "Category",
  "blockType.categoryPlaceholder": "e.g. Layout",
  "blockType.description": "Description",
  "blockType.fields": "Fields",
  "blockType.fieldsHelp": "These are what an editor fills in for every block of this type. Removing one leaves the values already written under its name in the store, but nothing will render or edit them.",

  // --- content-type builder ----------------------------------------------------------------
  "contentType.new": "New content type",
  "contentType.unknown": "Unknown content type: {slug}",
  "contentType.formLabel": "Content type",
  /** The label of the one region a new content type starts with. Stored with the type. */
  "contentType.defaultRegionLabel": "Content",
  "contentType.slugHelpNew": "A URL segment: lowercase letters, digits and single hyphens.",
  "contentType.slugHelpFixed": "This slug addresses the type's own page list: renaming it would break every link to it.",
  "contentType.regions": "Regions",
  "contentType.regionsHelp": "A region is a named slot on the page. The allow-list decides what may be placed there; leave it empty for “any block type”.",
  "contentType.pageFields": "Page fields",
  "contentType.pageFieldsHelp": "Structured data on the page itself, beside its blocks: a lead image, a byline, a category.",
  "contentType.defaultBlocks": "Default blocks",
  "contentType.defaultBlocksHelp": "Created automatically in a region when a page of this type is created.",
  "contentType.needsRegion": "A content type needs at least one region.",
  /** Asked on save when default blocks name a region that was renamed or removed. `{names}` is
   * the missing region names, comma-separated. */
  "contentType.orphanedConfirm": {
    one: "{count} default block points at a region that no longer exists ({names}). Remove it and save?",
    other: "{count} default blocks point at a region that no longer exists ({names}). Remove them and save?",
  },

  // --- regions -------------------------------------------------------------------------------
  "regions.name": "Name (the key blocks are placed under)",
  "regions.label": "Label",
  "regions.remove": "Remove region",
  "regions.allowed": "Allowed block types",
  /** After "Allowed block types" when the region takes every block type. */
  "regions.allowedAny": "(any)",
  "regions.noBlockTypes": "No block types defined yet.",
  "regions.add": "+ Add region",

  // --- default blocks ------------------------------------------------------------------------
  "defaultBlocks.region": "Region",
  "defaultBlocks.blockType": "Block type",
  "defaultBlocks.add": "+ Add default block",

  // --- the field-schema editor ---------------------------------------------------------------
  "fieldSchema.empty": "No fields yet.",
  "fieldSchema.add": "+ Add field",
  "fieldSchema.maxDepth": "Fields cannot nest deeper than {max} levels.",
  "fieldSchema.moveUp": "Move up",
  "fieldSchema.moveDown": "Move down",
  "fieldSchema.label": "Label",
  "fieldSchema.name": "Name (the stored key)",
  "fieldSchema.type": "Type",
  "fieldSchema.duplicate": "Two fields here are called “{name}”. They would write the same key, and one could never be saved.",
  "fieldSchema.badName": "A name must start with a letter or underscore and hold only letters, digits and underscores.",
  "fieldSchema.help": "Help text (optional)",
  "fieldSchema.helpPlaceholder": "What this field means, when it applies, what empty does",
  "fieldSchema.required": "Required",
  "fieldSchema.nested": "Nested fields",
  /** `{type}` is the field type's label (`fieldSchema.type.group` / `.repeater`). */
  "fieldSchema.nestedNeeded": "A {type} needs at least one nested field.",
  "fieldSchema.optionsFromHandler": "Fetch the options from a query handler",
  /** `{shape}` is the code `{ value, label }[]`, shown as `<code>`. */
  "fieldSchema.optionsHandler": "Handler name (returns <code>{shape}</code>)",
  "fieldSchema.options": "Options, one per line",
  /** `{query}` / `{ids}` are the two request shapes, shown as `<code>`. */
  "fieldSchema.referenceHandler": "Handler name: answers <code>{query}</code> and <code>{ids}</code>",
  "fieldSchema.referenceMultiple": "Allow several",
  "fieldSchema.referenceNeedsHandler": "A reference needs a handler to resolve it.",
  "fieldSchema.slugFrom": "Derived from (a text field beside it, optional)",
  "fieldSchema.slugByHand": "(typed by hand)",
  /** `{types}` is the allowed source types' labels joined with " / ". */
  "fieldSchema.slugSourceHint": "The source must be a {types} field.",
  "fieldSchema.slugNoSource": "No {types} field stands beside this one yet.",
  "fieldSchema.repeaterMin": "Minimum items",
  "fieldSchema.repeaterMax": "Maximum items",

  // The field types, as the type picker and a field row's header name them. English shows the
  // machine value itself; the stored value is always the machine value.
  "fieldSchema.type.text": "text",
  "fieldSchema.type.textarea": "textarea",
  "fieldSchema.type.richtext": "richtext",
  "fieldSchema.type.url": "url",
  "fieldSchema.type.number": "number",
  "fieldSchema.type.boolean": "boolean",
  "fieldSchema.type.date": "date",
  "fieldSchema.type.datetime": "datetime",
  "fieldSchema.type.publish": "publish",
  "fieldSchema.type.slug": "slug",
  "fieldSchema.type.media": "media",
  "fieldSchema.type.select": "select",
  "fieldSchema.type.reference": "reference",
  "fieldSchema.type.repeater": "repeater",
  "fieldSchema.type.group": "group",
};

export const cs: Translation<typeof en> = {
  "schema.needsEditor": "Úprava struktury obsahu vyžaduje roli editora.",
  "schema.parent": "Struktura obsahu",
  "schema.savedFlash": "Uloženo",
  "schema.name": "Název",
  "schema.slug": "Slug",
  "schema.slugFixed": "(neměnný)",

  "schema.titleLead": "Struktura obsahu",
  "schema.titleMain": "tohoto webu",
  "schema.intro": "<strong>Typ bloku</strong> je sada polí, kterou editor vyplňuje. <strong>Typ obsahu</strong> je druh stránky: jaké má oblasti a které typy bloků do každé z nich patří. Dokud neexistuje od každého aspoň jeden, nelze nic vytvořit.",
  "schema.blockTypes": "Typy bloků",
  "schema.blockTypesEmpty": "Zatím žádné typy bloků. Stránky se skládají z bloků, začněte proto tady.",
  "schema.newBlockType": "+ Nový typ bloku",
  "schema.contentTypes": "Typy obsahu",
  "schema.contentTypesEmpty": "Zatím žádné typy obsahu. Stránka potřebuje typ obsahu: ten určuje oblasti, do kterých se vkládají bloky.",
  "schema.newContentType": "+ Nový typ obsahu",
  "schema.fieldCount": { one: "{count} pole", few: "{count} pole", many: "{count} pole", other: "{count} polí" },
  "schema.regionCount": { one: "{count} oblast", few: "{count} oblasti", many: "{count} oblasti", other: "{count} oblastí" },

  "schema.codeBadge": "kód",
  "schema.codeBadgeTitle": "Definováno v kódu, zde jen pro čtení",
  "schema.managed.body": "Tento {what} je <strong>definovaný v kódu</strong>: <code>{call}</code>, který při každém spuštění aplikuje <code>cmsBootstrap</code>{owner}. Zde je jen pro čtení: změna uložená z této obrazovky by se při dalším nasazení nebo studeném startu vrátila. Upravte deklaraci a nasaďte znovu.",
  "schema.managed.owner": " (vlastník <code>{owner}</code>)",
  "schema.managed.blockType": "typ bloku",
  "schema.managed.contentType": "typ obsahu",

  "blockType.new": "Nový typ bloku",
  "blockType.unknown": "Neznámý typ bloku: {slug}",
  "blockType.formLabel": "Typ bloku",
  "blockType.slugHelpNew": "Klíč, podle kterého web přiřadí komponentu. Malá písmena, číslice, pomlčky nebo podtržítka.",
  "blockType.slugHelpFixed": "Slug typu bloku je jeho klíč v registru: přejmenováním by se odpojily všechny bloky tohoto typu.",
  "blockType.icon": "Ikona",
  "blockType.iconPlaceholder": "např. 🖼",
  "blockType.category": "Kategorie",
  "blockType.categoryPlaceholder": "např. Rozvržení",
  "blockType.description": "Popis",
  "blockType.fields": "Pole",
  "blockType.fieldsHelp": "Tato pole editor vyplňuje u každého bloku tohoto typu. Po odebrání pole zůstanou už uložené hodnoty pod jeho názvem v úložišti, ale nic je nevykreslí ani neumožní upravit.",

  "contentType.new": "Nový typ obsahu",
  "contentType.unknown": "Neznámý typ obsahu: {slug}",
  "contentType.formLabel": "Typ obsahu",
  "contentType.defaultRegionLabel": "Obsah",
  "contentType.slugHelpNew": "Část adresy URL: malá písmena, číslice a jednotlivé pomlčky.",
  "contentType.slugHelpFixed": "Tento slug je adresou seznamu stránek tohoto typu: přejmenováním by přestaly fungovat všechny odkazy na něj.",
  "contentType.regions": "Oblasti",
  "contentType.regionsHelp": "Oblast je pojmenované místo na stránce. Seznam povolených typů určuje, co do ní lze vložit; když ho necháte prázdný, povolen je „jakýkoli typ bloku“.",
  "contentType.pageFields": "Pole stránky",
  "contentType.pageFieldsHelp": "Strukturovaná data přímo na stránce, vedle jejích bloků: úvodní obrázek, autor, kategorie.",
  "contentType.defaultBlocks": "Výchozí bloky",
  "contentType.defaultBlocksHelp": "Vytvoří se v oblasti automaticky při založení stránky tohoto typu.",
  "contentType.needsRegion": "Typ obsahu potřebuje aspoň jednu oblast.",
  "contentType.orphanedConfirm": {
    one: "{count} výchozí blok patří do oblasti, která už neexistuje ({names}). Odebrat ho a uložit?",
    few: "{count} výchozí bloky patří do oblasti, která už neexistuje ({names}). Odebrat je a uložit?",
    many: "{count} výchozího bloku patří do oblasti, která už neexistuje ({names}). Odebrat je a uložit?",
    other: "{count} výchozích bloků patří do oblasti, která už neexistuje ({names}). Odebrat je a uložit?",
  },

  "regions.name": "Název (klíč, pod kterým se bloky ukládají)",
  "regions.label": "Popisek",
  "regions.remove": "Odebrat oblast",
  "regions.allowed": "Povolené typy bloků",
  "regions.allowedAny": "(jakékoli)",
  "regions.noBlockTypes": "Zatím nejsou definované žádné typy bloků.",
  "regions.add": "+ Přidat oblast",

  "defaultBlocks.region": "Oblast",
  "defaultBlocks.blockType": "Typ bloku",
  "defaultBlocks.add": "+ Přidat výchozí blok",

  "fieldSchema.empty": "Zatím žádná pole.",
  "fieldSchema.add": "+ Přidat pole",
  "fieldSchema.maxDepth": "Pole nelze vnořit hlouběji než do {max} úrovní.",
  "fieldSchema.moveUp": "Posunout nahoru",
  "fieldSchema.moveDown": "Posunout dolů",
  "fieldSchema.label": "Popisek",
  "fieldSchema.name": "Název (klíč v úložišti)",
  "fieldSchema.type": "Typ",
  "fieldSchema.duplicate": "Dvě pole se tu jmenují „{name}“. Zapisovala by pod stejný klíč a jedno z nich by se nikdy neuložilo.",
  "fieldSchema.badName": "Název musí začínat písmenem nebo podtržítkem a obsahovat jen písmena, číslice a podtržítka.",
  "fieldSchema.help": "Nápověda (nepovinné)",
  "fieldSchema.helpPlaceholder": "Co pole znamená, kdy se použije a co znamená, když zůstane prázdné",
  "fieldSchema.required": "Povinné",
  "fieldSchema.nested": "Vnořená pole",
  "fieldSchema.nestedNeeded": "Pole typu „{type}“ potřebuje aspoň jedno vnořené pole.",
  "fieldSchema.optionsFromHandler": "Načítat možnosti z dotazového handleru",
  "fieldSchema.optionsHandler": "Název handleru (vrací <code>{shape}</code>)",
  "fieldSchema.options": "Možnosti, jedna na řádek",
  "fieldSchema.referenceHandler": "Název handleru: odpovídá na <code>{query}</code> a <code>{ids}</code>",
  "fieldSchema.referenceMultiple": "Povolit více",
  "fieldSchema.referenceNeedsHandler": "Reference potřebuje handler, který ji dohledá.",
  "fieldSchema.slugFrom": "Odvozeno z (sousední textové pole, nepovinné)",
  "fieldSchema.slugByHand": "(zadává se ručně)",
  "fieldSchema.slugSourceHint": "Zdrojem musí být pole typu {types}.",
  "fieldSchema.slugNoSource": "Vedle tohoto pole zatím není žádné pole typu {types}.",
  "fieldSchema.repeaterMin": "Minimální počet položek",
  "fieldSchema.repeaterMax": "Maximální počet položek",

  "fieldSchema.type.text": "Text",
  "fieldSchema.type.textarea": "Víceřádkový text",
  "fieldSchema.type.richtext": "Formátovaný text",
  "fieldSchema.type.url": "URL",
  "fieldSchema.type.number": "Číslo",
  "fieldSchema.type.boolean": "Ano/ne",
  "fieldSchema.type.date": "Datum",
  "fieldSchema.type.datetime": "Datum a čas",
  "fieldSchema.type.publish": "Zveřejnění",
  "fieldSchema.type.slug": "Slug",
  "fieldSchema.type.media": "Médium",
  "fieldSchema.type.select": "Výběr",
  "fieldSchema.type.reference": "Reference",
  "fieldSchema.type.repeater": "Opakovaná skupina",
  "fieldSchema.type.group": "Skupina",
};
