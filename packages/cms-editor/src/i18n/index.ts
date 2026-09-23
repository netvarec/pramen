// The editor's language: `@pramen/cms-editor/i18n`.
//
// Every word the editor shows comes from a message catalog (`./catalog`), in the language the
// deployment configured (`locale` in the shell's runtime config, `pramenCms({ admin: { locale
// } })`). Before this the copy was English literals in the components, and the one consumer
// that needed Czech rebuilt the editor with some sixty `.replace()` calls against our source,
// every one of them a silent break at our next release.
//
// PUBLIC, and a runtime entry, because a theme needs the same language the editor speaks. A
// slot (`buildEditor({ slots })`) is bundled into the editor, so it can read the active locale
// and translate its own strings with `defineMessages`, or reuse the editor's own wording with
// `t`. For that to work the theme's `import … from "@pramen/cms-editor/i18n"` has to reach
// THIS module instance, not a copy: `buildEditor` pins the specifier to this file, so a theme
// with its own nested install of the package still shares the editor's locale
// (`test/cms-editor-host-build.test.ts` proves it on a bundle).
//
// React-free and DOM-free, like `brand.ts` and `chrome.ts`: the language is a fact of the page
// load, resolved from config before anything renders, so there is no provider to mount and no
// hook rule to follow. `confirm()` text in an event handler and a `listSummary` in a pure
// function translate the same way a component does. The `use*` names are kept for the call
// sites that ARE components, so a later runtime language switch can become a context without
// touching them.

import { CATALOGS, en, type EditorMessages } from "./catalog";
import type { MessageValue, MessageVars, PluralCategory, PluralForms, Translation } from "./types";

export type { MessageValue, MessageVars, PluralCategory, PluralForms, Translation } from "./types";
export type { EditorMessages } from "./catalog";

/** Any key of the editor's catalog. */
export type MessageKey = keyof EditorMessages;
/** A key whose message is text. */
export type TextKey = { [K in MessageKey]: EditorMessages[K] extends string ? K : never }[MessageKey];
/** A key whose message is plural forms. */
export type PluralKey = Exclude<MessageKey, TextKey>;

/** The language every deployment gets unless it configures another. */
export const DEFAULT_LOCALE = "en";

/** The languages the editor ships a catalog for. */
export const EDITOR_LOCALES: readonly string[] = Object.keys(CATALOGS);

/** What the shell may set under `window.PRAMEN_CMS_EDITOR`. */
export interface I18nConfig {
  /** A BCP 47 tag: `"cs"`, `"cs-CZ"`, `"en"`. The catalog is picked by its language
   * subtag, and the whole tag is what dates and numbers are formatted with. */
  locale?: unknown;
  /** Replacements for individual messages of the chosen catalog, by key. */
  messages?: unknown;
}

/** The language the editor speaks on this page load. */
export interface I18n {
  /** The catalog in use: `"en"` or `"cs"`. */
  readonly locale: string;
  /** The tag dates, numbers and plurals are formatted with (`"cs-CZ"` when that is what was
   * configured). `undefined` when nothing was configured, which is the browser's own
   * language: what `toLocaleString()` did before there was a setting. */
  readonly tag: string | undefined;
  /** A text message, with `{name}` placeholders filled from `vars`. */
  t(key: TextKey, vars?: MessageVars): string;
  /** A plural message for `count`. `{count}` is the formatted number unless `vars.count`
   * says otherwise (a list header passes `"50+"`). */
  tp(key: PluralKey, count: number, vars?: MessageVars): string;
  /** A plural message's forms, for a caller that composes its own (`labelledForms`). */
  forms(key: PluralKey): PluralForms;
  /** Pick one of `forms` for `count` by this locale's plural rules, and fill it. */
  plural(count: number, forms: PluralForms, vars?: MessageVars): string;
  /** Fill `{name}` placeholders in a template. Unknown placeholders are left as written. */
  format(template: string, vars?: MessageVars): string;
  /** A number, grouped for the locale ("1,234" / "1 234"). */
  number(value: number): string;
  /** A calendar date ("9/23/2026" / "23. 9. 2026"). */
  date(value: Date | number | string): string;
  /** A date and time. */
  dateTime(value: Date | number | string): string;
  /** A time relative to now ("3 minutes ago" / "před 3 minutami"). */
  relative(value: Date | number | string, now?: number): string;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(template: string, vars: MessageVars | undefined): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

function isPluralForms(value: unknown): value is PluralForms {
  return typeof value === "object" && value !== null && typeof (value as { other?: unknown }).other === "string";
}

function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Resolve `locale` to a shipped catalog and the tag to format with.
 *
 * An unusable or unknown value is WARNED about and falls back to English, never thrown on:
 * this is hand-edited config read at module load with no error boundary above it, the same
 * rule `resolveLayout` and `resolveBrand` follow. `"de"` rendering an English editor with a
 * console line is recoverable; a blank admin is not.
 */
export function resolveLocale(value: unknown): { locale: string; tag: string | undefined } {
  if (value === undefined || value === null || value === "") return { locale: DEFAULT_LOCALE, tag: undefined };
  const raw = typeof value === "string" ? value.trim() : "";
  let tag: string | undefined;
  try {
    // Canonicalizes the case ("CS-cz" -> "cs-CZ") and rejects what is not a tag at all.
    tag = raw ? Intl.getCanonicalLocales(raw)[0] : undefined;
  } catch {
    tag = undefined;
  }
  const language = tag?.split("-")[0];
  if (tag && language && language in CATALOGS) return { locale: language, tag };
  console.warn(`pramen/cms-editor: no catalog for \`locale\` ${JSON.stringify(value)}, so the editor stays in English. Shipped: ${EDITOR_LOCALES.map((l) => JSON.stringify(l)).join(", ")}.`);
  return { locale: DEFAULT_LOCALE, tag: DEFAULT_LOCALE };
}

/**
 * Apply a deployment's `messages` override to a catalog.
 *
 * Per KEY, and checked against the shape of the message it replaces: a string for text, forms
 * with `other` for a plural. Anything else is warned about and skipped, so a typo in one key
 * costs that one string and says so, rather than a thrown error at boot.
 */
export function applyOverrides<C extends Record<string, MessageValue>>(catalog: C, overrides: unknown): C {
  if (overrides === undefined || overrides === null) return catalog;
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    console.warn(`pramen/cms-editor: ignoring \`messages\`; expected an object of message keys, got ${JSON.stringify(overrides)}.`);
    return catalog;
  }
  const out: Record<string, MessageValue> = { ...catalog };
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    const current = catalog[key];
    if (current === undefined) {
      console.warn(`pramen/cms-editor: ignoring \`messages\` key ${JSON.stringify(key)}; the editor has no such message.`);
    } else if (typeof current === "string" ? typeof value === "string" : isPluralForms(value)) {
      out[key] = value as MessageValue;
    } else {
      console.warn(`pramen/cms-editor: ignoring \`messages\` key ${JSON.stringify(key)}; expected ${typeof current === "string" ? "a string" : "plural forms with at least `other`"}.`);
    }
  }
  return out as C;
}

/** Build the language for one configuration. Pure apart from the warnings; the editor itself
 * uses the page's one instance, {@link getI18n}. */
export function createI18n(config: I18nConfig = {}): I18n {
  const { locale, tag } = resolveLocale(config.locale);
  const catalog = applyOverrides(CATALOGS[locale] ?? en, config.messages) as Translation<EditorMessages>;
  const rules = new Intl.PluralRules(tag ?? locale);
  const numbers = new Intl.NumberFormat(tag ?? locale);
  const relativeFormat = new Intl.RelativeTimeFormat(tag ?? locale, { numeric: "auto" });

  const select = (count: number, forms: PluralForms): string => forms[rules.select(count) as PluralCategory] ?? forms.other;

  const i18n: I18n = {
    locale,
    tag,
    t: (key, vars) => {
      const message = catalog[key] as MessageValue | undefined;
      // A plural read as text is a caller bug the types already refuse; `other` beats "[object
      // Object]" if a cast gets one through.
      return fill(typeof message === "string" ? message : isPluralForms(message) ? message.other : String(key), vars);
    },
    tp: (key, count, vars) => i18n.plural(count, i18n.forms(key), vars),
    forms: (key) => {
      const message = catalog[key] as MessageValue | undefined;
      return isPluralForms(message) ? message : { other: typeof message === "string" ? message : String(key) };
    },
    plural: (count, forms, vars) => fill(select(count, forms), { count: numbers.format(count), ...vars }),
    format: fill,
    number: (value) => numbers.format(value),
    date: (value) => toDate(value).toLocaleDateString(tag),
    dateTime: (value) => toDate(value).toLocaleString(tag),
    relative: (value, now = Date.now()) => {
      const seconds = Math.round((toDate(value).getTime() - now) / 1000);
      const abs = Math.abs(seconds);
      if (abs < 45) return relativeFormat.format(0, "second");
      if (abs < 45 * 60) return relativeFormat.format(Math.round(seconds / 60), "minute");
      if (abs < 22 * 3600) return relativeFormat.format(Math.round(seconds / 3600), "hour");
      if (abs < 26 * 86400) return relativeFormat.format(Math.round(seconds / 86400), "day");
      return toDate(value).toLocaleDateString(tag);
    },
  };
  return i18n;
}

/** The global the shell writes. Structural, so this module needs no DOM lib. */
export interface I18nHost {
  PRAMEN_CMS_EDITOR?: { locale?: unknown; messages?: unknown };
}

/** Pull the language settings off a host global, tolerating its absence. */
export function readI18nConfig(host: I18nHost | undefined): I18nConfig {
  const cfg = host?.PRAMEN_CMS_EDITOR;
  return { locale: cfg?.locale, messages: cfg?.messages };
}

let active: I18n | undefined;

/**
 * The page's language, built on first use from the shell's config.
 *
 * Lazily rather than at module load, because a theme module can be evaluated before this one
 * is asked for anything, and the warnings for a bad `locale` should come out once, when it is
 * first needed.
 */
export function getI18n(): I18n {
  active ??= createI18n(readI18nConfig(globalThis as I18nHost));
  return active;
}

/**
 * Replace the page's language. The editor never calls this (its language is the shell's
 * config); it is for code that renders editor components outside the editor's own boot: a
 * theme's stories, a test.
 */
export function configureI18n(config: I18nConfig): I18n {
  active = createI18n(config);
  return active;
}

/** The page's language, in a component. See {@link getI18n}. */
export function useI18n(): I18n {
  return getI18n();
}

/** The active catalog's language, `"en"` or `"cs"`. */
export function useLocale(): string {
  return getI18n().locale;
}

/** A text message of the editor's catalog, in the active language. */
export function t(key: TextKey, vars?: MessageVars): string {
  return getI18n().t(key, vars);
}

/** Pick one of `forms` for `count` by the active language's plural rules. */
export function plural(count: number, forms: PluralForms, vars?: MessageVars): string {
  return getI18n().plural(count, forms, vars);
}

/** A theme's own messages, translated like the editor's. */
export interface Messages<E extends Record<string, MessageValue>> {
  /** The active language's text for `key`; English where that language has no catalog or
   * no entry. */
  t<K extends { [P in keyof E]: E[P] extends string ? P : never }[keyof E]>(key: K, vars?: MessageVars): string;
  /** The active language's plural message for `key`. */
  tp<K extends { [P in keyof E]: E[P] extends string ? never : P }[keyof E]>(key: K, count: number, vars?: MessageVars): string;
}

/**
 * Declare a theme's own strings, in English and in any other language it ships.
 *
 * ```ts
 * const copy = defineMessages({
 *   en: { greeting: "Hello, {name}", files: { one: "{count} file", other: "{count} files" } },
 *   cs: { greeting: "Dobrý den, {name}", files: { one: "{count} soubor", few: "{count} soubory", many: "{count} souboru", other: "{count} souborů" } },
 * });
 * copy.t("greeting", { name });   copy.tp("files", 3);
 * ```
 *
 * `en` is required and is the fallback for a language the theme does not ship or a key a
 * translation lacks. Resolved on each call against the editor's active language, so the result
 * can be created at module scope.
 */
export function defineMessages<E extends Record<string, MessageValue>>(catalogs: { en: E } & { readonly [locale: string]: Partial<Translation<E>> }): Messages<E> {
  const pick = (key: string): MessageValue | undefined => {
    const own = (catalogs[getI18n().locale] as Record<string, MessageValue> | undefined)?.[key];
    return own ?? (catalogs.en as Record<string, MessageValue>)[key];
  };
  return {
    t: (key, vars) => {
      const message = pick(key as string);
      return fill(typeof message === "string" ? message : isPluralForms(message) ? message.other : String(key), vars);
    },
    tp: (key, count, vars) => {
      const message = pick(key as string);
      return getI18n().plural(count, isPluralForms(message) ? message : { other: typeof message === "string" ? message : String(key) }, vars);
    },
  };
}
