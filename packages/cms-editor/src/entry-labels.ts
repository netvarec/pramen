// The words for a content type's pages and a collection's rows: its own, or the catalog's.
//
// Upstream said "+ New page" and "N pages total" for every content type, so an Articles list
// read "3 pages total", and a collection lower-cased its label into "+ New {label}". The one
// consumer that ran the editor in Czech patched a table of slugs into our source to say "+ Nový
// článek" / "+ Nová stránka" / "+ Nová akce" and "1 článek / 3 články / 5 článků". A slug table
// in the editor is the wrong owner: the type is declared in the app, so the app declares its
// words (`labels` on `defineContentType` / `collection`) and the editor only composes them.
//
// Pure, apart from reading the page's language: a list header calls these while rendering, and
// the fallbacks are testable without a DOM.

import { getI18n, type I18n, type PluralForms } from "./i18n";
import type { EntryLabels } from "./types";

/**
 * A count's forms from a label's nouns: each noun set into `template` ("{count} {noun} total"),
 * keeping `{count}` for the plural call to fill.
 */
export function labelledForms(nouns: NonNullable<EntryLabels["count"]>, template: string): PluralForms {
  const out: Record<string, string> = {};
  for (const [category, noun] of Object.entries(nouns)) {
    if (typeof noun === "string") out[category] = template.replace("{noun}", noun);
  }
  return out as unknown as PluralForms;
}

/** Whether `labels.count` is usable: an object with a string `other`. The value came over the
 * wire from a row an editor or a codegen may have written, so it is checked, not trusted. */
function countNouns(labels: EntryLabels | null | undefined): NonNullable<EntryLabels["count"]> | undefined {
  const count = labels?.count;
  return count && typeof count === "object" && typeof count.other === "string" ? count : undefined;
}

function newItem(labels: EntryLabels | null | undefined): string | undefined {
  const value = labels?.newItem;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The page list's create button: "+ New article" from the type, else the catalog's neutral
 * "+ New page" / "+ Nový obsah". */
export function pageNewButton(type: { labels?: EntryLabels | null } | null | undefined, i18n: I18n = getI18n()): string {
  const item = newItem(type?.labels);
  return item ? i18n.t("entries.newLabelled", { newItem: item }) : i18n.t("entries.pages.new");
}

/** The create dialog's title for a type that declared `newItem` ("Nový článek"), else
 * `undefined` and the dialog keeps its own sentence. */
export function declaredNewItem(entry: { labels?: EntryLabels | null } | null | undefined): string | undefined {
  return newItem(entry?.labels);
}

/** The page list's count forms: the type's nouns, else "N pages total" / "N záznamů". */
export function pageCountForms(type: { labels?: EntryLabels | null } | null | undefined, i18n: I18n = getI18n()): PluralForms {
  const nouns = countNouns(type?.labels);
  return nouns ? labelledForms(nouns, i18n.t("entries.pages.countLabelled")) : i18n.forms("entries.pages.count");
}

/** A collection's create button: its `newItem`, else "+ New lecture" / "+ Nový záznam". */
export function collectionNewButton(def: { label: string; labels?: EntryLabels | null }, i18n: I18n = getI18n()): string {
  const item = newItem(def.labels);
  return item ? i18n.t("entries.newLabelled", { newItem: item }) : i18n.t("entries.collection.new", { label: def.label.toLowerCase() });
}

/** A collection's count forms: its nouns, else its labels lower-cased ("3 lectures"), or the
 * neutral "3 záznamy" in a language whose grammar the labels cannot be trusted to fit. */
export function collectionCountForms(def: { label: string; pluralLabel: string; labels?: EntryLabels | null }, i18n: I18n = getI18n()): PluralForms {
  const nouns = countNouns(def.labels);
  if (nouns) return labelledForms(nouns, i18n.t("entries.collection.countLabelled"));
  const vars = { label: def.label.toLowerCase(), pluralLabel: def.pluralLabel.toLowerCase() };
  const forms = i18n.forms("entries.collection.count");
  const out: Record<string, string> = {};
  // `{count}` must survive for the plural call, so only the label placeholders are filled here.
  for (const [category, form] of Object.entries(forms)) if (typeof form === "string") out[category] = i18n.format(form, vars);
  return out as unknown as PluralForms;
}
