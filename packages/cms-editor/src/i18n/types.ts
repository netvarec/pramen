// The shapes of a message catalog. A leaf with no imports, so every catalog file can depend on
// it without a cycle through the runtime in `./index.ts`.

/** A CLDR plural category, as `Intl.PluralRules#select` returns it. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/**
 * One message per plural category of a language.
 *
 * `other` is the one every language has, so it is the one that is required; the rest are the
 * categories the language actually distinguishes. English needs `one` and `other`. Czech needs
 * `one` (1), `few` (2–4), `many` (fractions: "1,5 souboru") and `other` (0 and 5+: "5 souborů").
 * Note that a whole number of five or more is `other` in Czech, not `many`, which is the one
 * surprise in the table.
 *
 * `{count}` in a form is the number, formatted for the locale.
 */
export type PluralForms = { readonly other: string } & { readonly [C in Exclude<PluralCategory, "other">]?: string };

/** A catalog entry: text, or text per plural category. */
export type MessageValue = string | PluralForms;

/** Values substituted for `{name}` placeholders. */
export type MessageVars = Readonly<Record<string, string | number>>;

/**
 * A catalog translating the English catalog `E`: the same keys, text where `E` has text and
 * plural forms where `E` has plural forms.
 *
 * Mapped from `E` rather than declared as a `Record`, so a translation missing a key (or
 * carrying one English no longer has) is a compile error in the catalog that is out of step,
 * and `test/cms-editor-i18n.test.ts` checks the same at runtime, including that every plural
 * message covers every category its language uses.
 */
export type Translation<E> = { readonly [K in keyof E]: E[K] extends string ? string : PluralForms };
