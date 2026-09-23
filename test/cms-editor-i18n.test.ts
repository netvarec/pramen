// @pramen/cms-editor: the editor's language.
//
// The catalogs are data that two people keep in step by hand, so the things that go wrong are
// the ones a type cannot always see: a key added in English and forgotten in Czech (a mapped
// type catches it in the catalog file, this catches it however the catalog was assembled), a
// Czech plural with three forms where the language needs four, a `{placeholder}` renamed on
// one side only, two areas declaring the same key so one silently overwrites the other.
//
// And the plural rules themselves, because Czech is the case that shows whether they were
// used or guessed: 1 soubor, 2–4 soubory, 5 and up (and 0) souborů, fractions souboru.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AREAS, CATALOGS, cs, en } from "../packages/cms-editor/src/i18n/catalog";
import {
  applyOverrides,
  configureI18n,
  createI18n,
  defineMessages,
  getI18n,
  readI18nConfig,
  resolveLocale,
  type PluralForms,
} from "../packages/cms-editor/src/i18n";
import { collectionCountForms, collectionNewButton, declaredNewItem, pageCountForms, pageNewButton } from "../packages/cms-editor/src/entry-labels";
import { listSummary } from "../packages/cms-editor/src/list-state";
import { adminLang } from "../packages/cms-astro/src/admin";
import { normalizeEntryLabels } from "../packages/cms/src/index";

const isPlural = (v: unknown): v is PluralForms => typeof v === "object" && v !== null;
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
const tags = (s: string): string[] => [...s.matchAll(/<(\w+)>/g)].map((m) => m[1]!).sort();
const texts = (v: string | PluralForms): string[] => (typeof v === "string" ? [v] : Object.values(v).filter((x): x is string => typeof x === "string"));

afterEach(() => {
  configureI18n({});
});

describe("the catalogs", () => {
  test("Czech has every English key, and nothing English does not", () => {
    const enKeys = Object.keys(en).sort();
    const csKeys = Object.keys(cs).sort();
    expect(csKeys.filter((k) => !(k in en))).toEqual([]);
    expect(enKeys.filter((k) => !(k in cs))).toEqual([]);
  });

  test("every shipped catalog has the same keys as English", () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(Object.keys(catalog).sort(), locale).toEqual(Object.keys(en).sort());
    }
  });

  test("a message is text or plural in every language alike", () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [key, value] of Object.entries(en)) {
        expect(isPlural((catalog as Record<string, unknown>)[key]), `${locale} ${key}`).toBe(isPlural(value));
      }
    }
  });

  test("no two areas declare the same key", () => {
    // `catalog/index.ts` spreads the areas into one object, where a repeated key is last-wins
    // and says nothing.
    for (const locale of ["en", "cs"] as const) {
      const seen = new Map<string, string>();
      const dupes: string[] = [];
      for (const [area, mod] of Object.entries(AREAS)) {
        for (const key of Object.keys(mod[locale])) {
          if (seen.has(key)) dupes.push(`${key} (${seen.get(key)} and ${area})`);
          seen.set(key, area);
        }
      }
      expect(dupes, locale).toEqual([]);
    }
  });

  test("every plural message covers every category its language selects", () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      for (const [key, value] of Object.entries(catalog)) {
        if (!isPlural(value)) continue;
        for (const category of categories) {
          expect((value as Record<string, unknown>)[category], `${locale} ${key} needs "${category}"`).toBeString();
        }
      }
    }
  });

  test("a translation uses only the placeholders and markup its English does", () => {
    // A translation MAY drop a placeholder (Czech says a neutral "záznam" where English
    // lower-cases the collection's label), but one English never fills would render as "{x}".
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [key, value] of Object.entries(catalog)) {
        const source = texts((en as Record<string, string | PluralForms>)[key]!);
        const allowed = new Set(source.flatMap(placeholders));
        const allowedTags = new Set(source.flatMap(tags));
        for (const text of texts(value)) {
          for (const p of placeholders(text)) expect(allowed.has(p), `${locale} ${key}: {${p}}`).toBe(true);
          for (const tag of tags(text)) expect(allowedTags.has(tag), `${locale} ${key}: <${tag}>`).toBe(true);
        }
      }
    }
  });

  test("no message is empty, and none uses an em dash", () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [key, value] of Object.entries(catalog)) {
        for (const text of texts(value)) {
          expect(text.trim(), `${locale} ${key}`).not.toBe("");
          expect(text.includes("\u2014"), `${locale} ${key}`).toBe(false);
        }
      }
    }
  });
});

describe("Czech plurals", () => {
  const i18n = createI18n({ locale: "cs" });
  const files: PluralForms = { one: "{count} soubor", few: "{count} soubory", many: "{count} souboru", other: "{count} souborů" };

  test("one, few, other for whole numbers; many only for fractions", () => {
    expect(i18n.plural(1, files)).toBe("1 soubor");
    expect(i18n.plural(2, files)).toBe("2 soubory");
    expect(i18n.plural(4, files)).toBe("4 soubory");
    expect(i18n.plural(5, files)).toBe("5 souborů");
    expect(i18n.plural(0, files)).toBe("0 souborů");
    expect(i18n.plural(22, files)).toBe("22 souborů");
    expect(i18n.plural(101, files)).toBe("101 souborů");
    expect(i18n.plural(1.5, files)).toBe("1,5 souboru");
  });

  test("numbers are grouped the Czech way", () => {
    expect(i18n.plural(1234, files).replace(/\s/g, " ")).toBe("1 234 souborů");
  });

  test("a list header counts in Czech, and N+ takes the plural", () => {
    configureI18n({ locale: "cs" });
    const words = { empty: getI18n().t("common.noneYet"), forms: files };
    expect(listSummary("loading", 0, words)).toBe("Načítám…");
    expect(listSummary("ready", 0, words)).toBe("Zatím žádné záznamy");
    expect(listSummary("ready", 1, words)).toBe("1 soubor");
    expect(listSummary("ready", 3, words)).toBe("3 soubory");
    expect(listSummary("ready", 60, words, true)).toBe("60+ souborů");
    expect(listSummary("failed", 0, words)).toBe("Nenačteno");
  });

  test("the neutral entry count", () => {
    expect(i18n.tp("entries.pages.count", 1)).toBe("1 záznam");
    expect(i18n.tp("entries.pages.count", 3)).toBe("3 záznamy");
    expect(i18n.tp("entries.pages.count", 7)).toBe("7 záznamů");
  });

  test("English keeps its two forms", () => {
    const english = createI18n({ locale: "en" });
    expect(english.tp("entries.pages.count", 1)).toBe("1 page total");
    expect(english.tp("entries.pages.count", 0)).toBe("0 pages total");
    expect(english.tp("entries.pages.count", 2)).toBe("2 pages total");
  });
});

describe("locale config", () => {
  test("nothing configured is English, formatted like the browser", () => {
    expect(resolveLocale(undefined)).toEqual({ locale: "en", tag: undefined });
    expect(createI18n().locale).toBe("en");
  });

  test("a region subtag picks the language's catalog and keeps the tag", () => {
    expect(resolveLocale("cs-CZ")).toEqual({ locale: "cs", tag: "cs-CZ" });
    expect(resolveLocale(" CS ")).toEqual({ locale: "cs", tag: "cs" });
  });

  test("an unknown or unusable locale warns and stays English", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveLocale("de").locale).toBe("en");
      expect(resolveLocale("not a tag!").locale).toBe("en");
      expect(resolveLocale(42).locale).toBe("en");
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  test("read off the shell's global", () => {
    expect(readI18nConfig({ PRAMEN_CMS_EDITOR: { locale: "cs", messages: { a: "b" } } })).toEqual({ locale: "cs", messages: { a: "b" } });
    expect(readI18nConfig(undefined)).toEqual({ locale: undefined, messages: undefined });
  });

  test("messages override single strings, and a bad key or shape is warned and skipped", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const i18n = createI18n({
        locale: "cs",
        messages: {
          "common.close": "Hotovo",
          "entries.pages.count": { one: "{count} kus", other: "{count} kusů" },
          "no.such.key": "x",
          "common.save": { other: "wrong shape" },
        },
      });
      expect(i18n.t("common.close")).toBe("Hotovo");
      expect(i18n.tp("entries.pages.count", 5)).toBe("5 kusů");
      expect(i18n.t("common.save")).toBe("Uložit");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(applyOverrides({ a: "x" }, "nope")).toEqual({ a: "x" });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a theme's own messages", () => {
  const copy = defineMessages({
    en: { hello: "Hello, {name}", files: { one: "{count} file", other: "{count} files" }, onlyEnglish: "fallback" },
    cs: { hello: "Dobrý den, {name}", files: { one: "{count} soubor", few: "{count} soubory", many: "{count} souboru", other: "{count} souborů" } },
  });

  test("follow the editor's active language, falling back to English per key", () => {
    expect(copy.t("hello", { name: "Jana" })).toBe("Hello, Jana");
    configureI18n({ locale: "cs" });
    expect(copy.t("hello", { name: "Jana" })).toBe("Dobrý den, Jana");
    expect(copy.tp("files", 3)).toBe("3 soubory");
    expect(copy.t("onlyEnglish")).toBe("fallback");
  });
});

describe("content type and collection wording", () => {
  const english = createI18n({ locale: "en" });
  const czech = createI18n({ locale: "cs" });
  const article = { labels: { newItem: "Nový článek", count: { one: "článek", few: "články", many: "článku", other: "článků" } } };

  test("a type without labels keeps the neutral wording", () => {
    expect(pageNewButton(undefined, english)).toBe("+ New page");
    expect(pageNewButton({ labels: null }, czech)).toBe("+ Nový obsah");
    expect(czech.plural(5, pageCountForms(undefined, czech))).toBe("5 záznamů");
    expect(english.plural(5, pageCountForms(undefined, english))).toBe("5 pages total");
    expect(declaredNewItem({})).toBeUndefined();
  });

  test("a type's own labels are gender- and number-correct", () => {
    expect(pageNewButton(article, czech)).toBe("+ Nový článek");
    expect(declaredNewItem(article)).toBe("Nový článek");
    const forms = pageCountForms(article, czech);
    expect(czech.plural(1, forms)).toBe("1 článek");
    expect(czech.plural(3, forms)).toBe("3 články");
    expect(czech.plural(5, forms)).toBe("5 článků");
  });

  test("English composes a type's nouns into its own sentence", () => {
    const forms = pageCountForms({ labels: { count: { one: "article", other: "articles" } } }, english);
    expect(english.plural(1, forms)).toBe("1 article total");
    expect(english.plural(2, forms)).toBe("2 articles total");
  });

  test("a collection falls back to its labels in English and to a neutral noun in Czech", () => {
    const lectures = { label: "Lecture", pluralLabel: "Lectures" };
    expect(collectionNewButton(lectures, english)).toBe("+ New lecture");
    expect(english.plural(1, collectionCountForms(lectures, english))).toBe("1 lecture");
    expect(english.plural(4, collectionCountForms(lectures, english))).toBe("4 lectures");
    expect(collectionNewButton(lectures, czech)).toBe("+ Nový záznam");
    expect(czech.plural(4, collectionCountForms(lectures, czech))).toBe("4 záznamy");
    const declared = { ...lectures, labels: { newItem: "Nová přednáška", count: { one: "přednáška", few: "přednášky", other: "přednášek" } } };
    expect(collectionNewButton(declared, czech)).toBe("+ Nová přednáška");
    expect(czech.plural(2, collectionCountForms(declared, czech))).toBe("2 přednášky");
    // A category the declaration left out uses `other`.
    expect(czech.plural(1.5, collectionCountForms(declared, czech))).toBe("1,5 přednášek");
  });

  test("labels from the wire are checked, not trusted", () => {
    expect(pageNewButton({ labels: { newItem: "   " } }, english)).toBe("+ New page");
    expect(english.plural(2, pageCountForms({ labels: { count: "nope" } as never }, english))).toBe("2 pages total");
  });
});

describe("declaring labels in @pramen/cms", () => {
  test("canonical shape, or null when there is nothing", () => {
    expect(normalizeEntryLabels(undefined)).toBeNull();
    expect(normalizeEntryLabels({})).toBeNull();
    expect(normalizeEntryLabels({ newItem: " Nový článek ", count: { one: "článek", other: "článků" } })).toEqual({ newItem: "Nový článek", count: { one: "článek", other: "článků" } });
  });

  test("refuses what the editor could never show", () => {
    expect(() => normalizeEntryLabels({ count: { one: "článek" } })).toThrow(/other/);
    expect(() => normalizeEntryLabels({ count: { other: "x", plural: "y" } })).toThrow(/plural category/);
    expect(() => normalizeEntryLabels({ newItem: "" })).toThrow();
    expect(() => normalizeEntryLabels({ title: "x" })).toThrow(/unknown key/);
    expect(() => normalizeEntryLabels("Nový článek")).toThrow();
  });
});

describe("the shell's <html lang>", () => {
  const backend = { url: "", tenant: "main" };
  test("the configured locale, canonicalized, else English", () => {
    expect(adminLang({ backend })).toBe("en");
    expect(adminLang({ backend, locale: "cs" })).toBe("cs");
    expect(adminLang({ backend, locale: "cs-cz" })).toBe("cs-CZ");
    expect(adminLang({ backend, locale: "<script>" })).toBe("en");
  });
});
