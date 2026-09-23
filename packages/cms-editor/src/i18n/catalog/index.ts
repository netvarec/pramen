// The editor's message catalogs, assembled from one file per area of the editor.
//
// Split by area rather than kept as one `en.ts` + one `cs.ts`, so the English string and its
// translation sit a screen apart instead of two thousand lines apart, and so a change to one
// screen's copy touches one file. Keys are prefixed by area (`media.`, `users.`, …), which is
// what keeps the spread below from silently letting one area overwrite another: a duplicate
// key is caught by `test/cms-editor-i18n.test.ts`.

import type { Translation } from "../types";
import * as common from "./common";
import * as components from "./components";
import * as fields from "./fields";
import * as furniture from "./furniture";
import * as schema from "./schema";
import * as shell from "./shell";

/** English: the default, and the language every key is declared in first. */
export const en = {
  ...common.en,
  ...shell.en,
  ...components.en,
  ...fields.en,
  ...furniture.en,
  ...schema.en,
};

/** The editor's messages, by key. */
export type EditorMessages = typeof en;

/** Czech. */
export const cs: Translation<EditorMessages> = {
  ...common.cs,
  ...shell.cs,
  ...components.cs,
  ...fields.cs,
  ...furniture.cs,
  ...schema.cs,
};

/** Every catalog the editor ships, by language. */
export const CATALOGS: Readonly<Record<string, Translation<EditorMessages>>> = { en, cs };

/** The per-area modules, for the duplicate-key check. */
export const AREAS: Readonly<Record<string, { en: Record<string, unknown>; cs: Record<string, unknown> }>> = { common, shell, components, fields, furniture, schema };
