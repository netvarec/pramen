// @pramen/cms — a Drupal-Paragraphs-style block/page builder, built as an ordinary
// pramen app fragment (schema + handlers + ACL + tasks). Nothing here is a new runtime
// primitive: it composes the ones pramen already ships — `t.json()` for block field
// payloads, `t.fileRef()`+R2 for media, relations for page↔block traversal, the ACL for
// editor RBAC, and `ctx.tasks` (the transactional outbox) for scheduled publish/unpublish.
//
// Model (borrowed from WollyCMS / Drupal Paragraphs):
//   - a BLOCK TYPE is a schema — a slug + a recursive field schema (data-driven, so a
//     webmaster adds a type with no deploy);
//   - a BLOCK is an instance — content matching a type's field schema (optionally reusable);
//   - a PAGE has a content type, which declares named REGIONS (each with an allow-list of
//     block types) and optional DEFAULT BLOCKS;
//   - a PAGE_BLOCK places a block into a page's region at a position, optionally as a
//     SHARED block with per-placement field OVERRIDES.
//
// Publishing writes a fully-assembled JSON snapshot into a revision; the public content
// API serves that snapshot (fast, and it never exposes unpublished block rows directly).
// Rendering stays the frontend's job — see `@pramen/cms/react` (BlockRenderer).
//
// Usage:
//   import { cmsSchema, cmsHandlers, cmsPolicies, cmsTasks } from "@pramen/cms";
//   const schema = defineSchema({ ...cmsSchema, ...yourEntities });
//   const handlers = { ...cmsHandlers, ...yourHandlers };
//   const acl = [ role("anonymous", [...cmsPolicies().public]),
//                 role("editor",    [...cmsPolicies().editor]) ];
//   const app = { schema, handlers, acl, tasks: { ...cmsTasks } };

import {
  Entity,
  query,
  mutation,
  primaryKey,
  generated,
  notNull,
  unique,
  indexed,
  defaultTo,
  expr,
  policy,
  allow,
  $now,
  partitionOf,
  DEFAULT_PARTITION,
  BadRequest,
  Forbidden,
  PramenError,
  Conflict,
  signToken,
  verifyToken,
  resolveSecret,
  authorizeHandler,
} from "@pramen/server";
import type { HandlerContext, Policy, FileRef, BootstrapFn, JsonValue, SchemaDef, FieldDef, FieldType } from "@pramen/server";
import type { EnvBag } from "@pramen/server";
import { isSafeHref, normalizeHref } from "./href";
import { NAV_ORDER } from "./nav";

// --- field schema DSL (the block-editor field language) ---------------------

/** A field in a block type's (or content type's) field schema. Recursive: a `repeater`
 * or `group` nests `fields`. Mirrors WollyCMS's FieldDefinition. */
export interface FieldDefinition {
  name: string;
  label?: string;
  type:
    | "text"
    | "textarea"
    | "richtext"
    | "url"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    /**
     * A publication timestamp with three states: unset (hidden), a past time
     * (published), or a future time (scheduled). The editor renders it as
     * publish-now / schedule / unpublish rather than a bare date picker, because that is
     * the decision an editor is actually making.
     *
     * Validated as a `datetime` on the wire, but NOT interchangeable with one: the
     * `publish` control always writes a UTC instant with a `Z` suffix
     * (`2026-08-20T12:00:00.000Z`), where the `datetime` control writes the picker's
     * naive local string (`2026-08-20T14:00`). Both land in the same TEXT column and
     * both pass validation, yet they sort and range-compare lexicographically against
     * each other as if hours apart — so converting an existing `datetime` field to
     * `publish` needs a backfill of the stored values, not just a type change.
     *
     * A collection has no page-style publish workflow, so this is how a row goes live.
     * Scope the anonymous read policy to it with `$now()` from `@pramen/server`:
     *
     * ```ts
     * policy("cms_lectures", { read: { where: { publishedAt: { lte: $now() } } } })
     * ```
     *
     * That, and not `{ publishedAt: { isNull: false } }`, is the real access boundary.
     * `isNull: false` matches a FUTURE timestamp too, so a row the editor scheduled for
     * next week would be anonymously readable the moment it was saved — the scheduling
     * affordance would be a UI label over no enforcement at all.
     */
    | "publish"
    /**
     * A URL segment, derived from another field as you type.
     *
     * Set `from` to the field it follows (usually the title). The editor keeps them in
     * sync only while the slug is untouched — once it has been edited, or on a row that
     * already has one, it stops following, because silently rewriting a slug changes a
     * live URL and breaks every link to it.
     *
     * Stored as text. Uniqueness is the schema's job (`unique(t.text())`).
     */
    | "slug"
    | "media"
    | "select"
    /**
     * A pointer to a record that is NOT this row — another pramen row, or a record in a
     * system the CMS does not own. Stored as an OPAQUE id (a string), so the same field
     * links a `cms_pages` row, a collection row and an external CRM record alike.
     *
     * `optionsFrom` on a `select` is most of this already, and stays the ergonomic case for
     * a short closed list: it fetches `{ value, label }[]` ONCE and renders a `<select>`.
     * What it cannot do is scale — no search term, no paging, and no way to render the
     * label of a value whose record is not in the first (only) page. Twenty campaigns are
     * fine; a thousand records are a dropdown nobody can use and a stored id that renders
     * as a uuid.
     *
     * So a reference declares `referenceFrom`, a query handler called with BOTH shapes:
     *
     *   { search?: string; limit: number; offset: number }  -> browse / search
     *   { ids: string[] }                                   -> resolve stored values
     *
     * and returning `{ items: ReferenceOption[]; hasMore?: boolean }` either way. The
     * second shape is what makes an already-stored value renderable without fetching the
     * whole set — the reason this is a field type and not a wider `select`.
     */
    | "reference"
    | "repeater"
    | "group";
  required?: boolean;
  default?: unknown;
  /** repeater/group only — the nested fields. */
  fields?: FieldDefinition[];
  /** repeater only — item count bounds. */
  min?: number;
  max?: number;
  /** select only. */
  options?: string[];
  /** select only — fetch options at edit time from a query handler of this name (returns
   * `{ value, label }[]`), e.g. a live list of campaigns. Takes precedence over `options`. */
  optionsFrom?: string;
  /** slug only — the sibling field this one is derived from (e.g. `"title"`). */
  from?: string;
  /** reference only — the query handler that resolves this reference. See the `reference`
   * type above for the two request shapes it must answer. */
  referenceFrom?: string;
  /** reference only — store a LIST of ids rather than one. A multiple reference is a
   * `t.json()` column (an array), a single one is `t.text()`; `validateCollections`
   * enforces the difference, because storing an array in a TEXT column is a raw driver
   * error on the first write and nothing earlier. */
  multiple?: boolean;
}

/** One option a `reference` field's `referenceFrom` handler returns. `hint` is secondary
 * text (a date, an owner, a status) shown under the label — a picker over a thousand
 * records usually needs more than a name to tell two rows apart. */
export interface ReferenceOption {
  value: string;
  label: string;
  hint?: string;
}

/** What a `reference` field's `referenceFrom` handler returns, for BOTH request shapes.
 * `hasMore` drives the picker's "Load more"; omitting it means "this is everything". */
export interface ReferenceResult {
  items: ReferenceOption[];
  hasMore?: boolean;
}

/** A named region on a content type; `allowedTypes` (block-type slugs) restricts what
 * may be placed there — `null`/omitted means any. */
export interface RegionDefinition {
  name: string;
  label?: string;
  allowedTypes?: string[] | null;
}

/** A block auto-created in a region when a page of this content type is created. */
export interface DefaultBlockDefinition {
  region: string;
  blockTypeSlug: string;
  fields?: FieldValues;
}

// --- hybrid typed blocks: compile-time inference over a const FieldDefinition[] --------
//
// The data-driven half stores block field schemas as JSON rows (webmasters add types with
// no deploy). For DEVELOPER-authored blocks, `defineBlockType(slug, fields as const)` gives
// compile-time field typing with NO build step — a rendered block's `fields` is inferred from
// the schema, exactly like `typeof app.handlers` types the RPC client. (A `pramen cms codegen`
// command that emits these types from DB-stored schemas is future work.)

/**
 * A rich-text document — the editor's structured JSON (a ProseMirror/TipTap doc tree).
 *
 * **Not an HTML string.** HTML never enters storage: the write path validates this tree
 * against a node/mark allow-list (`normalizeRichText`) and the render side maps node types
 * to components, so there is no `set:html` / `dangerouslySetInnerHTML` anywhere in the
 * chain and nothing to scrub. The one attribute that can still carry script is a `link`
 * mark's `href`, so that one IS checked — see `isSafeHref`.
 */
export interface RichTextDoc {
  type: "doc";
  content?: RichTextNode[];
}

/** One node in a {@link RichTextDoc}. A leaf carries `text` (plus optional inline `marks`);
 * a container carries `content`. */
export interface RichTextNode {
  type: string;
  content?: RichTextNode[];
  text?: string;
  marks?: RichTextMark[];
  attrs?: Record<string, JsonValue>;
}

/** An inline mark on a text node — bold, link, highlight, … */
export interface RichTextMark {
  type: string;
  attrs?: Record<string, JsonValue>;
}

/** The value of a `richtext` field. */
export type RichText = RichTextDoc;

/** Map one FieldDefinition (as a const literal) to the TS type of its RENDERED value.
 * Media resolves to `ResolvedMedia` (the assemble-time shape a component receives). */
export type FieldTsType<D extends FieldDefinition> = D["type"] extends "text" | "textarea" | "url" | "select" | "date" | "datetime" | "publish" | "slug"
  ? string
  : D["type"] extends "richtext"
    ? RichText
    : D["type"] extends "number"
      ? number
      : D["type"] extends "boolean"
        ? boolean
        : D["type"] extends "media"
          ? ResolvedMedia | null
          : D["type"] extends "reference"
            ? (D extends { multiple: true } ? string[] : string)
          : D["type"] extends "group"
            ? InferBlockFields<NonNullable<D["fields"]>>
            : D["type"] extends "repeater"
              ? InferBlockFields<NonNullable<D["fields"]>>[]
              : unknown;

/** Infer the `fields` object type from a const `FieldDefinition[]`. Required fields are
 * present; optional ones are `| undefined`. */
export type InferBlockFields<T extends readonly FieldDefinition[]> = {
  [D in T[number] as D["name"]]: D extends { required: true } ? FieldTsType<D> : FieldTsType<D> | undefined;
};

/** A developer-authored block type: a slug + a const field schema, carrying enough type
 * info to (a) create the DB block type and (b) type a rendering component's `fields`. */
export interface BlockTypeDef<S extends string = string, F extends readonly FieldDefinition[] = readonly FieldDefinition[]> {
  readonly slug: S;
  readonly name: string;
  readonly fieldsSchema: F;
  readonly description?: string;
  readonly icon?: string;
  readonly category?: string;
}

/** Declare a typed block type. Pass `fields as const` to preserve the literals so
 * `BlockFieldsOf<typeof def>` infers the field shape:
 *
 *   const hero = defineBlockType("hero", [
 *     { name: "heading", type: "text", required: true },
 *     { name: "image", type: "media" },
 *   ] as const);
 *   type HeroFields = BlockFieldsOf<typeof hero>; // { heading: string; image: ResolvedMedia|null|undefined }
 *
 * Spread `hero` (minus fieldsSchema key naming) into `createBlockType`, and use
 * `BlockFieldsOf<typeof hero>` to type the block's React component. */
export function defineBlockType<S extends string, F extends readonly FieldDefinition[]>(
  slug: S,
  fields: F,
  opts: { name?: string; description?: string; icon?: string; category?: string } = {},
): BlockTypeDef<S, F> {
  return {
    slug: checkedDefinition("block type", slug, () => assertRegistryKey(slug, "block type slug")) as S,
    name: opts.name ?? slug,
    // Held to the SAME rules the editor's `createBlockType` enforces. tsc types a const
    // `FieldDefinition[]`, but it does not know that a `select` needs options or that two
    // fields may not share a name — so without this a code-declared type could store a
    // schema the editor then REFUSES to save, and the only surface that reports the problem
    // is the one that cannot fix it. Canonicalized as well as checked, so the stored row is
    // byte-identical to what the editor would have written and does not read as drift.
    fieldsSchema: checkedDefinition("block type", slug, () => normalizeFieldSchema(fields, `block type '${slug}' fields`)) as unknown as F,
    description: opts.description,
    icon: opts.icon,
    category: opts.category,
  };
}

/** Run an authoring validator at DECLARATION time. The validators throw `BadRequest` — a
 * 400, which is meaningless here: the caller is a module body, not a request. Rethrown as a
 * plain Error naming the definition, so a bad `defineBlockType` fails the boot with a
 * message that says WHICH one rather than a stray 400 with no subject. */
function checkedDefinition<T>(what: string, slug: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new Error(`${what} '${slug}': ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The inferred `fields` type of a `defineBlockType` result. */
export type BlockFieldsOf<D extends BlockTypeDef> = InferBlockFields<D["fieldsSchema"]>;

// --- code-defined content types + bootstrap reconcile ---------------------------------
//
// Block/content types are runtime rows (a webmaster can add one with no deploy), but a repo
// that hard-depends on a fixed shape (e.g. an Astro site whose build fails unless an
// `article` type with certain fields exists) wants them CODE-DEFINED and auto-applied. These
// helpers let you declare types in code and converge them into the store on boot via pramen's
// `app.bootstrap` — so a fresh / reprovisioned database has them without a manual
// createContentType/createBlockType call.

/** A developer-authored content type: a page template. Page-level `fields`, named `regions`
 * (each with an optional block-type allow-list), and optional `defaultBlocks` scaffolded when
 * a page of this type is created. Mirror of `BlockTypeDef`; feed to `cmsBootstrap`. */
export interface ContentTypeDef {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly fields?: readonly FieldDefinition[];
  readonly regions: readonly RegionDefinition[];
  readonly defaultBlocks?: readonly DefaultBlockDefinition[];
}

/** Declare a content type in code. Spread the result into `cmsBootstrap({ contentTypes })`:
 *
 *   const article = defineContentType("article", {
 *     name: "Article",
 *     fields: [{ name: "perex", type: "textarea" }, { name: "date", type: "date" }],
 *     regions: [{ name: "content", allowedTypes: ["rich_text", "image"] }],
 *   }); */
export function defineContentType(
  slug: string,
  opts: {
    name?: string;
    description?: string;
    fields?: readonly FieldDefinition[];
    regions: readonly RegionDefinition[];
    defaultBlocks?: readonly DefaultBlockDefinition[];
  },
): ContentTypeDef {
  // Same reasoning as `defineBlockType` — the editor validates an authored content type, so
  // a code-declared one is held to the same rules rather than being the one way to store a
  // shape the builder cannot round-trip.
  const regions = checkedDefinition("content type", slug, () => normalizeRegions(opts.regions));
  return {
    slug: checkedDefinition("content type", slug, () => assertRegistryKey(slug, "content type slug")),
    name: opts.name ?? slug,
    description: opts.description,
    fields: checkedDefinition("content type", slug, () => normalizeFieldSchema(opts.fields, `content type '${slug}' fields`)),
    regions,
    defaultBlocks: checkedDefinition("content type", slug, () => normalizeDefaultBlocks(opts.defaultBlocks, regions)),
  };
}

/** The narrow slice of the system Db a reconcile needs. `cmsBootstrap` runs with a SYSTEM
 * Db (ACL bypassed), so these calls are unrestricted; kept loose to avoid threading the
 * host app's schema generic through a library helper. */
interface ReconcileDb {
  find(q: { from: string; where?: Record<string, unknown>; limit?: number }): Promise<Record<string, unknown>[]>;
  insert(table: string, values: Record<string, unknown>): Promise<unknown>;
  update(table: string, id: string, patch: Record<string, unknown>): Promise<unknown>;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Insert `values` if no row has this `slug`, else patch only the columns that drifted
 * (never `id`/`slug`/`createdAt`). Idempotent — an identical definition is a no-op. */
async function upsertBySlug(db: ReconcileDb, table: string, slug: string, values: Record<string, unknown>): Promise<void> {
  const existing = (await db.find({ from: table, where: { slug }, limit: 1 }))[0];
  if (!existing) {
    await db.insert(table, values);
    return;
  }
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (k === "slug") continue;
    if (!sameJson(existing[k], v)) patch[k] = v;
  }
  if (Object.keys(patch).length) await db.update(table, String(existing.id), patch);
}

/** Clear `managed` on rows this reconciler no longer declares.
 *
 * A type dropped from the repo keeps its row — pages are still built out of it — but nothing
 * converges it any more, so leaving it read-only in the builder would be a lock with nothing
 * behind it, next to a note pointing at code that no longer mentions it.
 *
 * This is the reason all code-defined types belong in ONE `cmsBootstrap` call: the argument
 * is read as the COMPLETE set, so two calls each declaring half would take turns releasing
 * the other half. A table the call says nothing about (`blockTypes` omitted entirely) is left
 * alone rather than swept. */
async function releaseUndeclared(db: ReconcileDb, table: string, declared: ReadonlySet<string>): Promise<void> {
  for (const row of await db.find({ from: table, where: { managed: true } })) {
    if (!declared.has(String(row.slug))) await db.update(table, String(row.id), { managed: false });
  }
}

/** Build a pramen `bootstrap` reconciler that upserts code-defined block + content types by
 * `slug` on each boot. Idempotent: inserts a missing type, updates a drifted one, leaves an
 * identical one untouched. Register it on your app:
 *
 *   export const app = { schema, handlers, acl, tasks,
 *     bootstrap: [ cmsBootstrap({ blockTypes: [...], contentTypes: [...] }) ] };
 *
 * Runs with a privileged system Db, so a fresh/reprovisioned database converges to the
 * code-declared types with no manual createContentType/createBlockType call.
 *
 * Every row it declares is flagged `managed`, which makes the editor show it read-only —
 * convergence and an editor pointed at the same rows are otherwise a silent data-loss pair
 * (GitHub #48). Declare ALL code-defined types in ONE call: the argument is read as the
 * complete set, and a type that drops out of it is released back to the editor. */
export function cmsBootstrap(defs: { blockTypes?: readonly BlockTypeDef[]; contentTypes?: readonly ContentTypeDef[] }): BootstrapFn {
  return async ({ db }) => {
    const sys = db as unknown as ReconcileDb;
    for (const bt of defs.blockTypes ?? []) {
      await upsertBySlug(sys, "cms_block_types", bt.slug, {
        name: bt.name,
        slug: bt.slug,
        description: bt.description ?? null,
        fieldsSchema: bt.fieldsSchema ?? [],
        icon: bt.icon ?? null,
        category: bt.category ?? null,
        // What tells the editor this row is code-owned, so it renders read-only instead of
        // accepting an edit this same loop would revert on the next cold start.
        managed: true,
      });
    }
    if (defs.blockTypes) await releaseUndeclared(sys, "cms_block_types", new Set(defs.blockTypes.map((bt) => bt.slug)));
    for (const ct of defs.contentTypes ?? []) {
      await upsertBySlug(sys, "cms_content_types", ct.slug, {
        name: ct.name,
        slug: ct.slug,
        description: ct.description ?? null,
        fieldsSchema: ct.fields ?? [],
        regions: ct.regions ?? [],
        defaultBlocks: ct.defaultBlocks ?? [],
        managed: true,
      });
    }
    if (defs.contentTypes) await releaseUndeclared(sys, "cms_content_types", new Set(defs.contentTypes.map((ct) => ct.slug)));
  };
}

// --- codegen: emit .ts field interfaces from DB-stored block schemas ------------------
//
// The data-driven half (webmaster-created block types) has no static type. This is the
// runtime mirror of `InferBlockFields`: read `cms_block_types.fieldsSchema` rows and emit a
// `.ts` module of per-slug field interfaces + a `BlockFieldsBySlug` registry. A future
// `pramen cms codegen` CLI command fetches the rows over HTTP and writes the output.

const pascal = (s: string): string => s.replace(/(^|[_-])(\w)/g, (_m, _sep, c: string) => c.toUpperCase());

function tsTypeOf(f: FieldDefinition): string {
  switch (f.type) {
    case "text":
    case "textarea":
    case "url":
    case "select":
    case "date":
    case "datetime":
    case "publish":
    case "slug":
      return "string";
    case "richtext":
      return "RichText";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "media":
      return "ResolvedMedia | null";
    // An opaque id — the record it points at may not be ours to type.
    case "reference":
      return f.multiple ? "string[]" : "string";
    case "group":
      return `{ ${(f.fields ?? []).map(tsFieldLine).join(" ")} }`;
    case "repeater":
      return `Array<{ ${(f.fields ?? []).map(tsFieldLine).join(" ")} }>`;
    default:
      return "unknown";
  }
}
/** Which imported helper types a field schema actually needs, found by walking the tree
 * (group/repeater nest, so a `richtext` three levels down still counts). Order is stable
 * so the emitted import line does not churn between runs. */
function referencedHelperTypes(fields: readonly FieldDefinition[]): string[] {
  const found = new Set<string>();
  const walk = (defs: readonly FieldDefinition[]): void => {
    for (const f of defs) {
      if (f.type === "richtext") found.add("RichText");
      else if (f.type === "media") found.add("ResolvedMedia");
      else if (f.fields) walk(f.fields);
    }
  };
  walk(fields);
  return ["ResolvedMedia", "RichText"].filter((t) => found.has(t));
}

const tsFieldLine = (f: FieldDefinition): string => `${JSON.stringify(f.name)}${f.required ? "" : "?"}: ${tsTypeOf(f)};`;

/** Emit a `.ts` module of per-slug field interfaces + a `BlockFieldsBySlug` registry from
 * DB-stored block types (`{ slug, fieldsSchema }` rows). The runtime counterpart to the
 * compile-time `InferBlockFields`, for webmaster-authored (data-driven) block types. */
export function generateBlockTypes(blockTypes: Array<{ slug: string; fieldsSchema?: FieldDefinition[] | null }>): string {
  // Slugs are webmaster-authored with no deploy, so they are not guaranteed to map to a
  // valid or DISTINCT TypeScript identifier: "2-col" -> `interface 2ColFields` is a syntax
  // error, and "rich-text"/"rich_text" both -> `RichTextFields`. Fail with the offending
  // slugs rather than emit a file that does not parse.
  const seen = new Map<string, string>();
  const bad: string[] = [];
  for (const bt of blockTypes) {
    const name = pascal(bt.slug);
    // Unicode-aware: `úvodní-blok` -> `úvodníBlok` IS a legal TypeScript identifier, and an
    // ASCII-only test rejected it — aborting codegen for the WHOLE tenant over a slug that
    // works, with no fix short of renaming production data.
    if (!/^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u.test(name)) bad.push(`${bt.slug} (-> '${name}', not an identifier)`);
    else if (seen.has(name)) bad.push(`${bt.slug} (-> '${name}', collides with '${seen.get(name)}')`);
    else seen.set(name, bt.slug);
  }
  if (bad.length) throw new BadRequest(`cannot generate types for block type slug(s): ${bad.join("; ")}`);

  const interfaces = blockTypes
    .map((bt) => {
      const fields = Array.isArray(bt.fieldsSchema) ? bt.fieldsSchema : [];
      const body = fields.map((f) => `  ${tsFieldLine(f)}`).join("\n");
      return `export interface ${pascal(bt.slug)}Fields {\n${body}\n}`;
    })
    .join("\n\n");
  const registry = blockTypes.map((bt) => `  ${JSON.stringify(bt.slug)}: ${pascal(bt.slug)}Fields;`).join("\n");
  // Import ONLY what the emitted interfaces reference: every tsconfig in this repo sets
  // `noUnusedLocals`, so an unconditional import is a guaranteed TS6192 build break in the
  // consumer's own project — for a file they are told not to edit.
  //
  // Walk the SCHEMA rather than regexing the rendered text: field names are printed into
  // the output, so a field literally named `RichText` matched a `\bRichText\b` scan and
  // produced the unused import this exists to avoid.
  const used = referencedHelperTypes(blockTypes.flatMap((bt) => (Array.isArray(bt.fieldsSchema) ? bt.fieldsSchema : [])));
  const importLine = used.length ? `import type { ${used.join(", ")} } from "@pramen/cms";\n\n` : "";
  return `// AUTO-GENERATED by @pramen/cms — do not edit.\n${importLine}${interfaces}\n\nexport interface BlockFieldsBySlug {\n${registry}\n}\n`;
}

// --- schema fragment: spread into your defineSchema so the tables migrate --------

/** The block/page builder tables. All in the default partition (relations can't cross
 * partitions). Prefixed `cms_` to avoid colliding with your own entities. */
// --- site furniture: the shapes ----------------------------------------------
//
// Menus, taxonomies and widget areas are the site-level furniture a client expects to edit
// without a deploy. They are deliberately NOT modelled on pages: none of them has a slug, a
// status, a revision or a workflow, and bending them into `cms_pages` would put a null
// branch through every page read to serve something that shares no field with a page.

/** What a menu item points at.
 *
 * `custom` is a literal href. The rest are REFERENCES resolved at read time, which is the
 * whole reason the kind exists: a menu that stored `/about` verbatim breaks silently the
 * day the page's slug changes, and the redirect that covers it is a second thing to
 * remember. A `page` item follows the page. */
export type MenuItemKind = "custom" | "page" | "term" | "collection";

/** One entry in a menu tree. */
export interface MenuItem {
  /** Stable within the menu — the editor's list key and the only handle a reorder has. */
  id: string;
  label: string;
  /** Defaults to `"custom"` (a literal `url`). */
  kind?: MenuItemKind;
  /** `page`: a `cms_pages` id · `term`: a `cms_terms` id · `collection`: a collection slug. */
  ref?: string | null;
  /** `custom`: the href, stored verbatim (and `isSafeHref`-checked on write). For the
   * resolved kinds this is FILLED IN by `getMenu` and ignored on write. */
  url?: string;
  target?: string;
  titleAttr?: string;
  cssClasses?: string;
  children?: MenuItem[];
}

/** A named navigation menu. Read whole with `getMenu(name)`. */
export interface Menu {
  id: string;
  name: string;
  label: string;
  items: MenuItem[];
}

/** How deep a menu tree may nest. Menus are stored as one document, so without a cap a
 * client could post a tree deep enough to blow the stack in the resolver — and no real
 * navigation is more than three levels anyway. */
export const MAX_MENU_DEPTH = 5;

/** How many items one menu may hold, at every level combined.
 *
 * Depth alone is not a bound: a FLAT list of 800 `page` items is legal under
 * `MAX_MENU_DEPTH` and turns every anonymous `getMenu` — the read on every page render of
 * the site — into a single `WHERE id IN (?×800)`, which the read engine emits with no
 * chunking. Every other read added alongside this one is bounded (`MAX_TERMS`,
 * `clampLimit`); this one was not, and it is the one on the hot path. */
export const MAX_MENU_ITEMS = 200;

/** A classification vocabulary — `category`, `tag`, `region`, whatever the site sorts by. */
export interface Taxonomy {
  id: string;
  slug: string;
  label: string;
  pluralLabel?: string | null;
  description?: string | null;
  /** Terms may declare a `parentId`. A flat vocabulary REJECTS one on write, rather than
   * accepting it and rendering it nowhere. */
  hierarchical: boolean;
}

/** One term in a vocabulary. `children` is present only on the tree read (`getTermTree`). */
export interface Term {
  id: string;
  taxonomyId: string;
  slug: string;
  label: string;
  description?: string | null;
  parentId?: string | null;
  position: number;
  children?: Term[];
}

/** How deep a term hierarchy may nest — the same argument as {@link MAX_MENU_DEPTH}, except
 * here the tree is rows and the risk is a parent CYCLE, which `assertTermParent` refuses. */
export const MAX_TERM_DEPTH = 5;

/** What a widget renders. `component` is the escape hatch: the CMS stores an id + props and
 * the front end maps the id to one of its own components, exactly as `BlockRenderer` maps a
 * block type slug — so a widget area can hold something the CMS has no idea how to draw. */
export type WidgetType = "content" | "menu" | "component";

/** One widget in a widget area. */
export interface Widget {
  id: string;
  type: WidgetType;
  title?: string | null;
  /** `content`: a rich-text document (normalized on write like any other richtext value). */
  content?: RichTextDoc;
  /** `menu`: a `cms_menus.name`. `getWidgetArea` resolves it to `menu` alongside. */
  menuName?: string;
  /** `component`: the front end's own component id + its props. */
  componentId?: string;
  componentProps?: FieldValues;
}

/** A widget as READ back: a `menu` widget carries its resolved menu, so a layout renders a
 * whole sidebar from one call rather than one call per widget. */
export interface ResolvedWidget extends Widget {
  menu?: Menu | null;
}

/** A named template region an admin fills without touching code. */
export interface WidgetArea {
  id: string;
  name: string;
  label: string;
  description?: string | null;
  widgets: ResolvedWidget[];
}

export const cmsSchema = {
  cms_content_types: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    name: notNull(t.text()),
    slug: unique(notNull(t.text())),
    description: t.text(),
    fieldsSchema: t.json(), // FieldDefinition[] for page-level fields
    regions: t.json(), // RegionDefinition[]
    defaultBlocks: t.json(), // DefaultBlockDefinition[]
    // TRUE while `cmsBootstrap` declares this type in code. See cms_block_types.managed.
    managed: defaultTo(t.bool(), false),
    createdAt: defaultTo(t.text(), expr.now()),
  })),

  cms_block_types: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    name: notNull(t.text()),
    slug: unique(notNull(t.text())),
    description: t.text(),
    fieldsSchema: t.json(), // FieldDefinition[]
    icon: t.text(),
    category: t.text(),
    // TRUE while this row is CODE-DEFINED — `cmsBootstrap` declares it and converges it on
    // every boot. The editor authors these rows too (GitHub #9), and the two are otherwise
    // indistinguishable: an editor would add a field, get a 200, and lose it silently at the
    // next cold start when `upsertBySlug` patched the column back to the literal in `app.ts`.
    // So the flag is set by the reconciler, refused by `updateBlockType`/`updateContentType`,
    // and rendered read-only in the builder. Cleared again when the definition leaves the repo
    // (see `releaseUndeclared`) — a lock with nothing behind it is worse than no lock.
    managed: defaultTo(t.bool(), false),
    createdAt: defaultTo(t.text(), expr.now()),
  })),

  cms_blocks: Entity(
    (t) => ({
      id: primaryKey(generated(t.uuid())),
      typeId: notNull(t.uuid()),
      title: t.text(),
      fields: t.json(), // content matching the block type's fieldsSchema
      isReusable: defaultTo(t.bool(), false),
      // Optimistic concurrency: bumped on every edit. A caller may pass the version it
      // read as `expectedVersion` and get a 409 instead of silently clobbering.
      version: defaultTo(t.int(), 1),
      createdAt: defaultTo(t.text(), expr.now()),
      updatedAt: defaultTo(t.text(), expr.now()),
    }),
    (r) => ({ type: r.belongsTo("cms_block_types", "typeId") }),
  ),

  cms_pages: Entity(
    (t) => ({
      id: primaryKey(generated(t.uuid())),
      // Indexed because the editor lists pages ONE TYPE AT A TIME (`listPages({ contentType })`,
      // a tab per type): without it every tab load scans all of cms_pages before sorting, and
      // on the D1 store that scan is paid over RPC. Relation columns are never auto-indexed
      // (index DDL comes only from `unique()`/`indexed()` and composite uniques), and the
      // `["slug","locale"]` composite is leftmost-`slug` so it cannot serve this predicate.
      // The `createdAt` sort of the narrowed set remains — single-column indexes only.
      typeId: indexed(notNull(t.uuid())),
      title: notNull(t.text()),
      // A slug is unique PER LOCALE (`/en/about` + `/cs/about`) — enforced by the entity's
      // composite `unique: [["slug","locale"]]` (below). createPage/updatePage/createTranslation
      // also pre-check so the caller gets a clean 409 before hitting the constraint; the index
      // also speeds slug lookups.
      slug: indexed(notNull(t.text())),
      status: defaultTo(t.text(), "draft"), // draft | published | archived
      locale: defaultTo(t.text(), "en"),
      // Links a page to its translations: all locales of one logical page share this id.
      // Auto-minted for a standalone page; a translation is created with the source's id.
      translationGroupId: generated(t.uuid()),
      fields: t.json(),
      publishedAt: t.text(),
      scheduledAt: t.text(),
      unpublishAt: t.text(),
      // The revision the public content API serves — set on publish. A direct pointer
      // (not "latest by timestamp") so selection is deterministic even when two publishes
      // land in the same instant. `expr.now()` carries milliseconds now, which narrows the
      // window without closing it — a pointer has no window at all.
      currentRevisionId: t.uuid(),
      // Soft delete: the epoch-ISO instant the page was trashed, NULL while it is live.
      // Every read scope AND-merges `deletedAt IS NULL` (see cmsPolicies), so a trashed
      // page disappears from the public API and the editor alike without a single handler
      // remembering to filter. `restorePage` clears it; `purgePage` removes the row.
      deletedAt: indexed(t.text()),
      // SEO
      metaTitle: t.text(),
      metaDescription: t.text(),
      canonicalUrl: t.text(),
      robots: t.text(), // e.g. "noindex, nofollow"
      ogTitle: t.text(),
      ogDescription: t.text(),
      ogImage: t.uuid(), // a cms_media id, resolved to a URL at assemble time
      structuredData: t.json(), // JSON-LD, emitted as-is into <head>
      // Optimistic concurrency — see cms_blocks.version.
      version: defaultTo(t.int(), 1),
      createdAt: defaultTo(t.text(), expr.now()),
      updatedAt: defaultTo(t.text(), expr.now()),
    }),
    (r) => ({
      type: r.belongsTo("cms_content_types", "typeId"),
      placements: r.hasMany("cms_page_blocks", "pageId"),
      // Taxonomy terms, through the explicit junction. `where: { terms: { slug: "news" } }`
      // compiles to a nested subquery, so "pages in this category" is an ordinary query and
      // not a second handler.
      terms: r.manyToMany("cms_terms", { through: "cms_page_terms", sourceColumn: "pageId", targetColumn: "termId" }),
    }),
    { unique: [["slug", "locale"]] }, // a slug is unique per locale (DB-enforced)
  ),

  cms_page_blocks: Entity(
    (t) => ({
      id: primaryKey(generated(t.uuid())),
      pageId: notNull(t.uuid()),
      blockId: notNull(t.uuid()),
      region: notNull(t.text()),
      position: notNull(t.int()),
      isShared: defaultTo(t.bool(), false),
      overrides: t.json(), // per-placement field overrides (merged over the block's fields)
    }),
    (r) => ({
      page: r.belongsTo("cms_pages", "pageId"),
      block: r.belongsTo("cms_blocks", "blockId"),
    }),
  ),

  cms_page_revisions: Entity(
    (t) => ({
      id: primaryKey(generated(t.uuid())),
      pageId: notNull(t.uuid()),
      title: t.text(),
      status: t.text(),
      snapshot: t.json(), // the fully-assembled page + regions at publish time
      note: t.text(),
      actor: t.text(), // the identity.userId that published (null = system/unknown)
      createdAt: defaultTo(t.text(), expr.now()),
    }),
    (r) => ({ page: r.belongsTo("cms_pages", "pageId") }),
  ),

  // Append-only audit trail of workflow transitions (who moved a page between states,
  // when, with an optional note). In the DEFAULT partition — the transition handlers write
  // it synchronously (transactional with the state change, and they hold the actor from
  // ctx.identity); a handler can't write across a partition boundary, so an isolated
  // audit partition isn't reachable from here.
  cms_audit: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    pageId: indexed(t.uuid()),
    action: notNull(t.text()), // submit | approve | reject | publish | unpublish
    fromStatus: t.text(),
    toStatus: t.text(),
    actor: t.text(),
    note: t.text(),
    createdAt: defaultTo(t.text(), expr.now()),
  })),

  // Revision history for COLLECTION rows (`supports: ["revisions"]`). One shared table
  // rather than one per collection: a collection targets an arbitrary app entity, so there
  // is no place to hang a per-entity revisions table and no way to declare a real FK to a
  // target that varies. `collection` + `rowId` identify the subject; `rowId` is TEXT
  // because a collection's PK may be a uuid or a textId.
  //
  // A revision holds the row's state BEFORE the write that created it, projected to the
  // collection's declared fields — so restoring one is a plain reversal, and a snapshot
  // taken before a field was dropped from `fields` cannot resurrect that column (restore
  // replays through the same write whitelist).
  cms_collection_revisions: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    collection: indexed(notNull(t.text())),
    rowId: indexed(notNull(t.text())),
    // A monotonic per-row counter, and the ONLY ordering key. Timestamps cannot do this
    // job even at millisecond resolution: a collection revision is written on EVERY edit,
    // and two writes land in the same millisecond often enough to be reproducible. Ordering
    // then falls to a uuid tiebreak, which is deterministic but NOT insertion order — so
    // "restore the previous version" could pick the wrong snapshot. (`expr.now()` was also
    // second-resolution when this was written, which made the same point louder.)
    //
    // The read-then-increment in `snapshotRow` is serialized by the DO's single writer. On
    // the D1 store it is NOT — `D1Driver.transaction` is a no-op (D1 has no interactive
    // transactions), so two concurrent updates in different isolates can read the same MAX.
    // The composite unique below is what makes that a visible failure instead of a silent
    // duplicate that quietly restores the ordering ambiguity this column exists to remove.
    revision: notNull(t.int()),
    snapshot: t.json(),
    note: t.text(),
    actor: t.text(),
    // NO expr.now() default: `snapshotRow` is the only writer and stamps it. That is now a
    // consistency choice rather than a precision one — `expr.now()` carries milliseconds
    // too — but `revision` above is what actually orders these rows, and a column no
    // writer but `snapshotRow` touches cannot drift from it.
    createdAt: t.text(),
  }), undefined, { unique: [["collection", "rowId", "revision"]] }),

  // --- site furniture: menus, redirects, taxonomies, widget areas ------------------
  //
  // The WordPress-parity furniture every client project reinvents by hand. All four are
  // SITE-level, not page-level: they exist once per deployment and are read by the layout,
  // not by a page's regions.

  // A named navigation menu. `items` is a nested `MenuItem[]` document rather than a rows
  // table, because a menu is edited and read WHOLE — every read is `getMenu("primary")`,
  // and every write is "here is the new tree". Rows would buy per-item queries nobody makes
  // and cost a recursive assemble on the one read that matters. The tree is depth-capped on
  // write (`MAX_MENU_DEPTH`), which is the constraint a rows table would have got for free.
  cms_menus: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    // The key `getMenu(name)` resolves — stable, referenced from layout code, and so NOT
    // renameable through `updateMenu` (the label is what an editor retitles).
    name: unique(notNull(t.text())),
    label: notNull(t.text()),
    items: t.json(), // MenuItem[]
    // Optimistic concurrency, as on cms_pages/cms_blocks. It matters MORE here, not less:
    // `updateMenu` writes the whole `items` document, so two editors on one menu meant the
    // second silently replaced the first's entire tree — where a page edit at least
    // conflicts per field.
    version: defaultTo(t.int(), 1),
    createdAt: defaultTo(t.text(), expr.now()),
    updatedAt: defaultTo(t.text(), expr.now()),
  })),

  // A URL redirect. Needed the moment a slug changes on a live site — which the `slug`
  // field's own docs already flag ("silently rewriting a slug changes a live URL and breaks
  // every link to it").
  //
  // `fromPath`/`toPath`, not `from`/`to`: `from` is a SQL keyword, and while the dialect
  // quotes every identifier, a column named `from` also collides with the `find({ from })`
  // query key — a `where: { from: ... }` reads as a table reference to anyone skimming.
  cms_redirects: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    // Unique because resolution is an exact lookup: two rows for one path is a coin flip
    // over which redirect a visitor gets, and the DB is the only place that can refuse it.
    fromPath: unique(notNull(t.text())),
    toPath: notNull(t.text()),
    // 301 (permanent) or 302 (temporary). INT, and constrained on write — a redirect status
    // is not free-form, and a typo here is a broken response, not a broken page.
    status: defaultTo(t.int(), 301),
    // Off-switch that keeps the row. A redirect is usually disabled to TEST whether it is
    // still needed; deleting it loses the record of what the old URL was.
    enabled: defaultTo(t.bool(), true),
    note: t.text(),
    createdAt: defaultTo(t.text(), expr.now()),
    updatedAt: defaultTo(t.text(), expr.now()),
  })),
  // NOTE: deliberately no hit counter. Counting would make `resolveRedirect` — the one
  // handler anonymous traffic calls on every 404 — a WRITE, which is an unauthenticated
  // row mutation on the hot path and, on the DO, a transaction per miss. Redirect usage
  // belongs in the edge's own logs.

  // A classification vocabulary: `category` (hierarchical) and `tag` (flat) are just two
  // rows here, which is why there is no built-in of either — a deployment declares what it
  // classifies by, the same way it declares its content types.
  cms_taxonomies: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    slug: unique(notNull(t.text())),
    label: notNull(t.text()),
    pluralLabel: t.text(),
    description: t.text(),
    // Hierarchical vocabularies allow `parentId` on their terms; flat ones reject it on
    // write. Enforced in the handler, not the schema — one term table serves both.
    hierarchical: defaultTo(t.bool(), false),
    createdAt: defaultTo(t.text(), expr.now()),
  })),

  cms_terms: Entity(
    (t) => ({
      id: primaryKey(generated(t.uuid())),
      taxonomyId: indexed(notNull(t.uuid())),
      slug: notNull(t.text()),
      label: notNull(t.text()),
      description: t.text(),
      // Self-referential, and a REAL FK: deleting a parent term must not leave children
      // pointing at a row that is gone (the front end would render an orphan branch that
      // no listing can reach). `setNull` promotes them to the top level instead, which is
      // the only non-destructive answer — `cascade` would silently delete a subtree.
      parentId: t.uuid(),
      position: defaultTo(t.int(), 0),
      createdAt: defaultTo(t.text(), expr.now()),
    }),
    (r) => ({
      taxonomy: r.belongsTo("cms_taxonomies", "taxonomyId", { onDelete: "cascade" }),
      parent: r.belongsTo("cms_terms", "parentId", { onDelete: "setNull" }),
      pages: r.hasMany("cms_page_terms", "termId"),
    }),
    // A slug identifies a term WITHIN its vocabulary — `/category/news` and `/tag/news`
    // are two different terms, and both are legitimate.
    { unique: [["taxonomyId", "slug"]] },
  ),

  // The term-assignment junction — an EXPLICIT entity, which is what `manyToMany` means
  // here: `ctx.db.insert("cms_page_terms", …)` links, `delete` unlinks, and `where`
  // traverses it as a nested subquery. No synthetic table, no write API to learn.
  cms_page_terms: Entity(
    (t) => ({
      id: primaryKey(generated(t.uuid())),
      pageId: indexed(notNull(t.uuid())),
      termId: indexed(notNull(t.uuid())),
    }),
    (r) => ({
      page: r.belongsTo("cms_pages", "pageId", { onDelete: "cascade" }),
      term: r.belongsTo("cms_terms", "termId", { onDelete: "cascade" }),
    }),
    // One assignment per (page, term). Without it a double-submit leaves a page tagged
    // twice and every `with: { terms: true }` renders the term twice.
    { unique: [["pageId", "termId"]] },
  ),

  // A named template region an admin fills without touching code — the sidebar, the footer
  // column, the pre-footer strip.
  //
  // Kept as its own entity rather than a page-less `cms_blocks` region, which was the
  // tempting reuse. A block placement is `(pageId, region, position)` with `pageId` NOT
  // NULL: making it nullable to model "belongs to no page" would put a null branch through
  // every placement read, every region assemble and every page-scoped ACL clause, to model
  // something that shares no field with a page (no slug, no status, no revisions, no
  // workflow). A widget area is a small ordered document, and that is what it is stored as.
  cms_widget_areas: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    name: unique(notNull(t.text())),
    label: notNull(t.text()),
    description: t.text(),
    widgets: t.json(), // Widget[]
    // Same argument as cms_menus.version — `updateWidgetArea` replaces the whole list.
    version: defaultTo(t.int(), 1),
    createdAt: defaultTo(t.text(), expr.now()),
    updatedAt: defaultTo(t.text(), expr.now()),
  })),

  // Media: a fileRef column holds only R2 metadata; bytes live in R2, uploaded via
  // ctx.files + the Worker /files/* route. Block `fields` reference a media id.
  cms_media: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    file: t.fileRef(),
    alt: t.text(),
    // Soft delete, as on cms_pages. The R2 OBJECT is deliberately kept while a media row
    // is trashed — deleting the bytes would make restore a lie. `purgeMedia` drops both.
    deletedAt: indexed(t.text()),
    createdAt: defaultTo(t.text(), expr.now()),
  })),
};

/** Block Kit — custom admin pages, described as JSON and rendered by the editor. See
 * `./blockkit`. Re-exported so a host imports `adminPage` beside `collection`. */
export {
  adminPage,
  createAdminPageHandlers,
  normalizeAdminResponse,
  validateAdminPages,
  MAX_ADMIN_BLOCK_DEPTH,
} from "./blockkit";
export type {
  AdminBlock,
  AdminButton,
  AdminElement,
  AdminInput,
  AdminInteractionType,
  AdminPageDef,
  AdminPageHandlerOpts,
  AdminPageInteraction,
  AdminPageMeta,
  AdminPageResponse,
  AdminText,
} from "./blockkit";

/**
 * Columns this package wrote in the pre-ISO space form that the SCHEMA cannot identify.
 *
 * `isoTimestampBackfill()` finds every column whose DEFAULT is `expr.now()` on its own.
 * `cms_pages.publishedAt` has no default at all — `doPublish` stamped it from handler code,
 * in the same space form, to stay comparable with the `updatedAt` written beside it. There
 * is nothing on that column to find, so it is named here.
 *
 * Spread it into the migration if your store was ever written by a build older than this
 * one:
 *
 * ```ts
 * migrations: [isoTimestampBackfill({ extraColumns: CMS_LEGACY_TIMESTAMP_COLUMNS })]
 * ```
 *
 * Costs nothing on a store that was not — the UPDATE matches no rows.
 */
export const CMS_LEGACY_TIMESTAMP_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  cms_pages: ["publishedAt"],
};

// --- field validation --------------------------------------------------------

export interface ValidateOpts {
  /** Enforce `required` fields (reject when missing). Default true. Editor-facing draft
   * writes (addBlock/updateBlock/createPage) pass `false` — a DRAFT block may be incomplete;
   * required is only mandatory when publishing. Type checks always run. */
  requireRequired?: boolean;
  /** The row's CURRENTLY STORED field values. A legacy HTML-string `richtext` value is
   * tolerated only when it is byte-identical to the stored one — i.e. the caller echoed
   * back a pre-Portable-Text value it never authored (the editor autosaves the whole bag).
   * Anything else is rejected.
   *
   * This must NOT be a plain boolean. The `xss` sanitizer is gone, and `normalizeFields`
   * passes a tolerated string through untouched, so a blanket "allow strings" would let
   * any caller store arbitrary unsanitized HTML — which every consumer still on the
   * pre-migration `set:html` contract would then execute. */
  legacyBaseline?: FieldValues;
}

/** Validate a block/page's `fields` payload against a field schema, throwing a 400 on
 * the first violation. Recursive (repeater/group). Lenient on unknown field types. */
/** A calendar date, `YYYY-MM-DD` (what an <input type="date"> emits) — must also parse. */
function isDateString(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
}
/** A URL segment: lowercase a-z/0-9 groups joined by single hyphens, capped like the editor
 * control caps it. Normalization lives in the editor, but the editor is not the only writer —
 * a script or another client posting "Hello World/../x" would otherwise land it in a route. */
function isSlugString(v: string): boolean {
  return v.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
}
/** A date-time: `YYYY-MM-DDTHH:MM[:SS[.sss]][Z|±HH:MM]` (ISO 8601 / datetime-local). */
function isDateTimeString(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(v) && Number.isFinite(Date.parse(v));
}

export function validateFields(schema: FieldDefinition[] | undefined | null, values: unknown, path = "", opts: ValidateOpts = {}): void {
  const requireRequired = opts.requireRequired !== false;
  const defs = Array.isArray(schema) ? schema : [];
  const obj = (values ?? {}) as FieldValues;
  if (typeof obj !== "object" || Array.isArray(obj)) throw new BadRequest(`${path || "fields"} must be an object`);
  for (const def of defs) {
    const at = path ? `${path}.${def.name}` : def.name;
    const v = obj[def.name];
    const missing = v === undefined || v === null || v === "";
    if (missing) {
      if (def.required && requireRequired) throw new BadRequest(`field '${at}' is required`);
      continue;
    }
    switch (def.type) {
      case "text":
      case "textarea":
      case "url":
      case "select":
        if (typeof v !== "string") throw new BadRequest(`field '${at}' must be a string`);
        if (def.type === "select" && def.options && !def.options.includes(v)) {
          throw new BadRequest(`field '${at}' must be one of: ${def.options.join(", ")}`);
        }
        break;
      // A slug is text on the wire; only the editor control differs.
      case "slug":
        if (typeof v !== "string") throw new BadRequest(`field '${at}' must be a string`);
        if (!isSlugString(v)) throw new BadRequest(`field '${at}' must be a slug (lowercase letters, digits and single hyphens)`);
        break;
      case "richtext":
        // A document tree, never a string. A legacy HTML value is REJECTED rather than
        // silently normalized to an empty doc — a 400 names the migration; a blank field
        // would look like the content simply vanished. Except where the bag carries stored
        // data the caller never sent (see `legacyBaseline`).
        if (typeof v === "string") {
          // Tolerated only if it is exactly what is already stored for this field.
          if (opts.legacyBaseline && opts.legacyBaseline[def.name] === v) break;
          throw new BadRequest(`field '${at}' must be a rich-text document, not an HTML string`);
        }
        if (typeof v !== "object" || Array.isArray(v) || (v as unknown as RichTextDoc).type !== "doc") {
          throw new BadRequest(`field '${at}' must be a rich-text document ({ type: "doc", content: [...] })`);
        }
        break;
      case "number":
        if (typeof v !== "number") throw new BadRequest(`field '${at}' must be a number`);
        break;
      case "boolean":
        if (typeof v !== "boolean") throw new BadRequest(`field '${at}' must be a boolean`);
        break;
      case "date":
        if (typeof v !== "string" || !isDateString(v)) throw new BadRequest(`field '${at}' must be a date (YYYY-MM-DD)`);
        break;
      case "datetime":
      // `publish` is a datetime on the wire; only the editor control differs.
      case "publish":
        if (typeof v !== "string" || !isDateTimeString(v)) throw new BadRequest(`field '${at}' must be a date-time (ISO 8601)`);
        break;
      case "media":
        // Media ids are uuids (strings) — reject numbers so the value always resolves
        // (collectMediaIds/resolveMediaFields only handle string ids).
        if (typeof v !== "string") throw new BadRequest(`field '${at}' must be a media id (string)`);
        break;
      // An OPAQUE id: the record may live in another table, or in a system we do not own,
      // so there is nothing to check it against here beyond its shape. The picker's
      // `referenceFrom` handler is the authority on which ids exist, and it runs under the
      // caller's own ACL — so validating against a list fetched here would be both a second
      // round trip and a weaker check than the one the storing handler already makes.
      case "reference":
        if (def.multiple) {
          if (!Array.isArray(v)) throw new BadRequest(`field '${at}' must be a list of ids`);
          if (v.some((id) => typeof id !== "string")) throw new BadRequest(`field '${at}' must be a list of ids (strings)`);
        } else if (typeof v !== "string") {
          throw new BadRequest(`field '${at}' must be an id (string)`);
        }
        break;
      case "group": {
        // The baseline MUST descend. Stopping at the top level meant a pre-migration
        // richtext value nested in a group was rejected on every write that echoed the
        // stored bag back — and placeBlock, which merges the block's OWN stored fields,
        // could not place such a block at all. No editor can fix that: none ever mounted it.
        const nested = opts.legacyBaseline?.[def.name];
        validateFields(def.fields, v, at, {
          requireRequired: opts.requireRequired,
          legacyBaseline: nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as FieldValues) : undefined,
        });
        break;
      }
      case "repeater": {
        if (!Array.isArray(v)) throw new BadRequest(`field '${at}' must be a list`);
        if (def.min != null && v.length < def.min) throw new BadRequest(`field '${at}' needs at least ${def.min} item(s)`);
        if (def.max != null && v.length > def.max) throw new BadRequest(`field '${at}' allows at most ${def.max} item(s)`);
        {
          // Per-item baseline, positionally — a repeater item that kept its slot keeps its
          // stored value, so an untouched legacy value inside one still validates.
          const base = opts.legacyBaseline?.[def.name];
          const baseItems = Array.isArray(base) ? base : [];
          v.forEach((item, i) => {
            const bi = baseItems[i];
            validateFields(def.fields, item, `${at}[${i}]`, {
              requireRequired: opts.requireRequired,
              legacyBaseline: bi && typeof bi === "object" && !Array.isArray(bi) ? (bi as FieldValues) : undefined,
            });
          });
        }
        break;
      }
      default:
        break; // unknown type — don't block
    }
  }
}

// --- validating an AUTHORED field schema -------------------------------------
//
// `validateFields` above checks a VALUE against a schema. This checks the SCHEMA itself.
//
// It did not exist while the only way to create a block type was a developer writing
// `defineBlockType(...)` in the repo, where tsc is the check. Now that the editor authors
// types (GitHub #9), `fieldsSchema` arrives from a browser as free JSON into a `t.json()`
// column — and a malformed one is not caught anywhere downstream: `FieldForm` renders
// `null` for an unknown type, `validateFields` skips it ("lenient on unknown field types"),
// and the block silently loses that field's content on every save. A duplicate `name` is
// worse: two controls write the same key, so one of them can never be saved at all.

/** Every field type the runtime knows. Exported because the editor's type-builder offers
 * exactly this list — one definition, so a type added here appears there without a second
 * edit, and a type removed here cannot be authored. */
export const FIELD_TYPES: readonly FieldDefinition["type"][] = [
  "text", "textarea", "richtext", "url", "number", "boolean", "date", "datetime",
  "publish", "slug", "media", "select", "reference", "repeater", "group",
];

/** Types whose `fields` nest a further schema. */
const NESTING_TYPES: readonly FieldDefinition["type"][] = ["group", "repeater"];

/** How deep an authored field schema may nest. A schema is rendered by a recursive
 * component and validated by a recursive function, so the cap is what keeps both bounded
 * against a hand-posted document; nothing real nests past two or three. */
export const MAX_FIELD_DEPTH = 5;

/** A field NAME is an object key in a `fields` bag and a property name in generated TS
 * (`generateBlockTypes`), so it is held to what can be both. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A REGION name. Looser than a field name by one character, because the two are not the
 * same kind of thing: a field name is emitted as a TS property by `generateBlockTypes`, so
 * it must be an identifier, while a region name is only ever an object key on the assembled
 * page (`regions["main-content"]`). Held to `FIELD_NAME` it rejected hyphenated names that
 * pre-date this validation and are stored today — which would have made every future save
 * of such a content type fail, with the only fix being a rename that orphans its
 * placements. */
const REGION_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Validate and canonicalize an authored `FieldDefinition[]`, throwing a 400 on the first
 * problem. Returns the CLEANED schema — each field rebuilt from the keys its type actually
 * uses, so a `select`'s stale `options` cannot ride along on a field someone switched to
 * `text` and reappear if they switch back.
 */
export function validateFieldSchema(raw: unknown, path = "fieldsSchema", depth = 0): FieldDefinition[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new BadRequest(`${path} must be a list of field definitions`);
  if (depth >= MAX_FIELD_DEPTH) throw new BadRequest(`${path} nests deeper than ${MAX_FIELD_DEPTH} levels`);
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const o = asObj(entry) as Record<string, unknown>;
    const at = `${path}[${i}]`;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!FIELD_NAME.test(name)) {
      throw new BadRequest(`${at}.name must be a field name (a letter or underscore, then letters/digits/underscores), got ${JSON.stringify(o.name)}`);
    }
    // Siblings only — a nested `group` legitimately reuses a name from the outer level,
    // because it writes into its own bag.
    if (seen.has(name)) throw new BadRequest(`${path} declares '${name}' twice — two controls would write the same key and one could never be saved`);
    seen.add(name);
    const type = o.type as FieldDefinition["type"];
    if (!FIELD_TYPES.includes(type)) {
      throw new BadRequest(`${at}.type is '${String(o.type)}', which is not a field type (known: ${FIELD_TYPES.join(", ")})`);
    }
    const f: FieldDefinition = { name, type };
    if (typeof o.label === "string" && o.label.trim() !== "") f.label = o.label.trim();
    if (o.required === true) f.required = true;
    if (o.default !== undefined) f.default = o.default;

    if (NESTING_TYPES.includes(type)) {
      f.fields = validateFieldSchema(o.fields, `${at}.fields`, depth + 1);
      // A `group` with no fields renders an empty box; a `repeater` with none renders rows
      // of nothing and an Add button. Both are the shape of a half-finished edit, and both
      // are silently useless rather than visibly wrong, so they are refused here.
      if (f.fields.length === 0) throw new BadRequest(`${at} is a '${type}' and needs at least one nested field`);
      if (type === "repeater") {
        if (typeof o.min === "number" && Number.isFinite(o.min)) f.min = Math.max(0, Math.trunc(o.min));
        if (typeof o.max === "number" && Number.isFinite(o.max)) f.max = Math.max(1, Math.trunc(o.max));
        if (f.min != null && f.max != null && f.min > f.max) throw new BadRequest(`${at} has min ${f.min} above max ${f.max}`);
      }
    } else if (type === "select") {
      // `optionsFrom` takes precedence at render time, so requiring options alongside it
      // would reject the live-data case the option exists for.
      if (typeof o.optionsFrom === "string" && o.optionsFrom.trim() !== "") {
        f.optionsFrom = assertHandlerName(o.optionsFrom, `${at}.optionsFrom`);
      } else {
        const options = Array.isArray(o.options) ? o.options.map((v) => String(v).trim()).filter((v) => v !== "") : [];
        if (options.length === 0) throw new BadRequest(`${at} is a 'select' and needs either \`options\` or an \`optionsFrom\` handler`);
        if (new Set(options).size !== options.length) throw new BadRequest(`${at} lists the same option twice`);
        f.options = options;
      }
    } else if (type === "slug") {
      // `from` is optional (a slug typed by hand is legitimate), but naming a field that is
      // not there is a control that silently never follows anything.
      if (typeof o.from === "string" && o.from.trim() !== "") f.from = o.from.trim();
    } else if (type === "reference") {
      if (typeof o.referenceFrom !== "string" || o.referenceFrom.trim() === "") {
        throw new BadRequest(`${at} is a 'reference' and needs a \`referenceFrom\` query handler`);
      }
      f.referenceFrom = assertHandlerName(o.referenceFrom, `${at}.referenceFrom`);
      if (o.multiple === true) f.multiple = true;
    }
    return f;
  });
}

/** Resolve `slug` cross-references inside one schema, now that every sibling is known: a
 * `slug` field's `from` must name a field that exists AT THE SAME LEVEL (the editor reads
 * it out of the sibling bag) and holds text. Separate pass because forward references are
 * legitimate — a slug may precede the title it follows. */
export function checkSlugSources(schema: readonly FieldDefinition[], path = "fieldsSchema"): void {
  const byName = new Map(schema.map((f) => [f.name, f]));
  schema.forEach((f, i) => {
    if (f.type === "slug" && f.from) {
      const src = byName.get(f.from);
      if (!src) throw new BadRequest(`${path}[${i}] derives from '${f.from}', which is not a field alongside it`);
      if (!["text", "textarea", "select", "url"].includes(src.type)) {
        throw new BadRequest(`${path}[${i}] derives from '${f.from}', which is a '${src.type}' — a slug can only follow a text field`);
      }
    }
    if (f.fields) checkSlugSources(f.fields, `${path}[${i}].fields`);
  });
}

/** Validate + canonicalize an authored field schema end to end. */
export function normalizeFieldSchema(raw: unknown, path = "fieldsSchema"): FieldDefinition[] {
  const schema = validateFieldSchema(raw, path);
  checkSlugSources(schema, path);
  return schema;
}

/**
 * Validate a content type's `regions`.
 *
 * A region NAME is the key `addBlock({ region })` resolves and the key of the assembled
 * `regions` object a front end reads, so it is held to the same shape as a field name. An
 * `allowedTypes` entry is a block-type SLUG; it is not checked against the block types that
 * exist, on purpose — a content type declaring a region for a block type that has not been
 * created yet is an ordinary order of work, and `assertRegionAllows` is what enforces the
 * list at placement time.
 */
export function normalizeRegions(raw: unknown): RegionDefinition[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequest("at least one region is required");
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const o = asObj(entry) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!REGION_NAME.test(name)) throw new BadRequest(`regions[${i}].name must be a region name (a letter or underscore, then letters/digits/hyphens/underscores), got ${JSON.stringify(o.name)}`);
    if (seen.has(name)) throw new BadRequest(`regions declares '${name}' twice — the assembled page is keyed by region name, so one would overwrite the other`);
    seen.add(name);
    const region: RegionDefinition = { name };
    if (typeof o.label === "string" && o.label.trim() !== "") region.label = o.label.trim();
    // `null` and omitted both mean "any block type"; an empty ARRAY means "none", which is
    // a region nothing can ever be placed in. Almost always a half-finished edit, so it is
    // normalized to "any" rather than stored as a region that silently refuses everything.
    if (Array.isArray(o.allowedTypes)) {
      const allowed = o.allowedTypes.map((v) => String(v).trim()).filter((v) => v !== "");
      region.allowedTypes = allowed.length > 0 ? [...new Set(allowed)] : null;
    } else {
      region.allowedTypes = null;
    }
    return region;
  });
}

/** Validate a content type's `defaultBlocks` against its own regions. A default block that
 * names a region the type does not declare is created into nowhere — `createPage` would
 * place it under a key no renderer reads. */
export function normalizeDefaultBlocks(raw: unknown, regions: readonly RegionDefinition[]): DefaultBlockDefinition[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new BadRequest("defaultBlocks must be a list");
  const names = new Set(regions.map((r) => r.name));
  return raw.map((entry, i) => {
    const o = asObj(entry) as Record<string, unknown>;
    const region = typeof o.region === "string" ? o.region.trim() : "";
    const blockTypeSlug = typeof o.blockTypeSlug === "string" ? o.blockTypeSlug.trim() : "";
    if (!names.has(region)) throw new BadRequest(`defaultBlocks[${i}] targets region '${region}', which this content type does not declare`);
    if (!blockTypeSlug) throw new BadRequest(`defaultBlocks[${i}] needs a blockTypeSlug`);
    const allowed = regions.find((r) => r.name === region)?.allowedTypes;
    if (allowed && !allowed.includes(blockTypeSlug)) {
      throw new BadRequest(`defaultBlocks[${i}] places '${blockTypeSlug}' into region '${region}', which does not allow it`);
    }
    const out: DefaultBlockDefinition = { region, blockTypeSlug };
    if (o.fields !== undefined) out.fields = asObj(o.fields);
    return out;
  });
}

// --- rich text: the structural allow-list (server-side — the real XSS boundary) ---
//
// A `richtext` value is a document TREE, so there is no HTML to scrub — the boundary is
// STRUCTURAL: an unknown node or mark type is dropped, only the attributes declared for a
// type survive, an attribute value must be a JSON primitive, and a `link` href must pass a
// scheme allow-list. Client-side checks are not a boundary — a caller can POST any value
// straight to these handlers — so this runs on write, like the HTML sanitizer it replaces.
//
// Everything here is SYNCHRONOUS and pure. That still matters: normalization runs inside
// the DO's storage.transaction(), where async stream I/O (e.g. HTMLRewriter) deadlocks —
// the same constraint that once ruled out a DOM-based sanitizer.

/** The node/mark vocabulary a `richtext` value may use. A node entry maps a node type to
 * the attribute names kept on it; a mark entry does the same for a mark type. */
export interface RichTextSchema {
  nodes: Record<string, readonly string[]>;
  marks: Record<string, readonly string[]>;
  /** Highest heading level accepted; anything above is CLAMPED to it, not dropped.
   * Defaults to `MAX_HEADING_LEVEL` (3, the shipped editor's StarterKit config). Raise it
   * if your editor is configured for more — this is the widening the docs promise. */
  maxHeadingLevel?: number;
}

/** What the shipped editor can actually produce (TipTap StarterKit + Highlight + TaskList,
 * as configured by @podoba/react's BlockEditor). Pass your own to `normalizeFields` if your
 * editor adds extensions — a node type absent from the schema is dropped on write. */
/** Highest heading level the shipped editor is configured for (StarterKit levels [1,2,3]). */
export const MAX_HEADING_LEVEL = 3;

export const DEFAULT_RICH_TEXT_SCHEMA: RichTextSchema = {
  nodes: {
    // NOTE: no `doc`. normalizeRichText builds the root itself and never looks it up, so
    // an entry here would only ever authorize a NESTED doc — which TipTap cannot render
    // (Document declares no renderHTML), blanking the field in the editor while the site
    // renderers still showed the subtree. The first keystroke then saved the blank over it.
    paragraph: [],
    text: [],
    hardBreak: [],
    horizontalRule: [],
    heading: ["level"],
    blockquote: [],
    codeBlock: ["language"],
    bulletList: [],
    orderedList: ["start"],
    listItem: [],
    taskList: [],
    taskItem: ["checked"],
  },
  marks: {
    bold: [],
    italic: [],
    underline: [],
    strike: [],
    code: [],
    highlight: ["color"],
    link: ["href", "title", "target"],
  },
};

// Re-exported from the leaf module `./href` so `@pramen/cms/react` can import them at
// runtime without dragging this file (and the whole server SDK) into a browser bundle.
export { isSafeHref, normalizeHref } from "./href";

/** Keep only the declared attributes, and only those holding a JSON primitive — an object
 * or array in an attr is never something the editor emits, so it is smuggled payload. */
/** Look a type up in an allow-list WITHOUT walking the prototype chain. A plain-object
 * index resolves `constructor` / `toString` / `valueOf` to inherited members, which are
 * truthy — so `{ type: "constructor" }` passed the gate and was stored, and its "allowed
 * attributes" became the `Object` function (length 1, not iterable), throwing a TypeError
 * inside the DO's storage.transaction(). Both renderers and TipTap then choke on the
 * stored node, which bricks the row. */
function allowedAttrsFor(table: Record<string, readonly string[]>, type: unknown): readonly string[] | undefined {
  if (typeof type !== "string" || !Object.hasOwn(table, type)) return undefined;
  return table[type];
}

function normalizeAttrs(attrs: unknown, allowed: readonly string[], maxHeading: number = MAX_HEADING_LEVEL): Record<string, JsonValue> | undefined {
  if (!allowed.length || !attrs || typeof attrs !== "object" || Array.isArray(attrs)) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const name of allowed) {
    const v = (attrs as Record<string, unknown>)[name];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    // CLAMP, don't drop. Dropping `level` left the node level-less, and TipTap's Heading
    // declares `level: { default: 1 }` — so an imported h4 still opened as h1 and the next
    // autosave still persisted h1, while the renderers fell back to h2. Same silent
    // mutation the narrowing was meant to stop, plus an editor/site mismatch.
    if (name === "level") {
      if (typeof v !== "number" || !Number.isInteger(v)) continue;
      out[name] = Math.min(Math.max(v, 1), maxHeading);
      continue;
    }
    out[name] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Drop unknown marks and any `link` whose href fails the scheme allow-list (dropping the
 * whole mark, not just the href — an anchor with no destination is worse than plain text). */
function normalizeMarks(marks: unknown, schema: RichTextSchema): RichTextMark[] | undefined {
  if (!Array.isArray(marks)) return undefined;
  const out: RichTextMark[] = [];
  for (const raw of marks) {
    if (!raw || typeof raw !== "object") continue;
    const mark = raw as RichTextMark;
    const allowed = allowedAttrsFor(schema.marks, mark.type);
    if (!allowed) continue;
    const attrs = normalizeAttrs(mark.attrs, allowed, schema.maxHeadingLevel);
    if (mark.type === "link") {
      if (!isSafeHref(attrs?.href)) continue;
      // Persist the parser-normalized form, so what was validated is what resolves.
      if (attrs && typeof attrs.href === "string") attrs.href = normalizeHref(attrs.href);
    }
    out.push(attrs ? { type: mark.type, attrs } : { type: mark.type });
  }
  return out.length ? out : undefined;
}

/** How deep a document may nest before the normalizer stops descending. Real editor output
 * is a handful of levels (list > item > paragraph > text); a hand-crafted doc nested tens
 * of thousands deep would otherwise blow the stack INSIDE the DO's storage.transaction().
 * JSON.parse is iterative in V8, so such a payload reaches the normalizer intact. */
export const MAX_RICH_TEXT_DEPTH = 100;

/** Normalize one node, or `null` if its type is not in the schema. */
function normalizeNode(raw: unknown, schema: RichTextSchema, depth = 0): RichTextNode | null {
  if (depth > MAX_RICH_TEXT_DEPTH) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const node = raw as RichTextNode;
  const allowed = allowedAttrsFor(schema.nodes, node.type);
  if (!allowed) return null;

  const out: RichTextNode = { type: node.type };
  if (node.type === "text") {
    // A text node with no string — or an EMPTY one — is not text. ProseMirror forbids an
    // empty text node outright (`schema.text("")` throws "Empty text nodes are not
    // allowed"), and the editor builds its document inside a useState initializer, so a
    // stored `{type:"text",text:""}` would throw during render and take the edit UI down
    // for that row permanently.
    if (typeof node.text !== "string" || node.text === "") return null;
    out.text = node.text;
    const marks = normalizeMarks(node.marks, schema);
    if (marks) out.marks = marks;
  }
  const attrs = normalizeAttrs(node.attrs, allowed, schema.maxHeadingLevel);
  if (attrs) out.attrs = attrs;
  if (Array.isArray(node.content)) {
    const content = normalizeNodes(node.content, schema, depth + 1);
    if (content.length) out.content = content;
  }
  return out;
}

function normalizeNodes(nodes: readonly unknown[], schema: RichTextSchema, depth = 0): RichTextNode[] {
  const out: RichTextNode[] = [];
  for (const n of nodes) {
    const node = normalizeNode(n, schema, depth);
    if (node) out.push(node);
  }
  return out;
}

/** Normalize a rich-text value to a document the renderers can trust. A value that is not
 * a doc at all yields an empty doc — `validateFields` rejects those first, so in handler
 * flow this only ever sees a doc; the fallback is for direct callers. */
export function normalizeRichText(value: unknown, schema: RichTextSchema = DEFAULT_RICH_TEXT_SCHEMA): RichTextDoc {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "doc", content: [] };
  const content = Array.isArray((value as RichTextDoc).content) ? normalizeNodes((value as RichTextDoc).content ?? [], schema) : [];
  return { type: "doc", content };
}

/** The block-level node types that end a line when flattening to plain text. */
const RT_BLOCK_TYPES = new Set(["paragraph", "heading", "listItem", "taskItem", "blockquote", "codeBlock", "horizontalRule"]);

/** Flatten a rich-text document to plain text — for excerpts, meta descriptions, and search
 * indexing, which want the words without the structure. */
export function richTextToPlainText(value: RichTextDoc | null | undefined): string {
  const parts: string[] = [];
  const walk = (nodes: readonly RichTextNode[]): void => {
    for (const node of nodes) {
      if (node.type === "text") parts.push(node.text ?? "");
      else if (node.type === "hardBreak") parts.push("\n");
      if (node.content) walk(node.content);
      if (RT_BLOCK_TYPES.has(node.type)) parts.push("\n");
    }
  };
  walk(value?.content ?? []);
  // A block inside a block (a paragraph in a list item) closes both, so collapse the run:
  // every boundary is worth exactly one line break in a flattened excerpt.
  return parts.join("").replace(/\n{2,}/g, "\n").trim();
}

/** Deep-normalize the richtext fields in a values object against a field schema (recursing
 * into group/repeater). Returns a normalized copy; other field types pass through. */
export function normalizeFields(
  schema: FieldDefinition[] | undefined | null,
  values: FieldValues,
  richTextSchema: RichTextSchema = DEFAULT_RICH_TEXT_SCHEMA,
): FieldValues {
  const defs = Array.isArray(schema) ? schema : [];
  const out: FieldValues = { ...values };
  for (const def of defs) {
    const v = out[def.name];
    if (v == null) continue;
    // A legacy HTML string survives normalization untouched: normalizeRichText would turn
    // it into an EMPTY doc, i.e. silently delete the content. It only reaches here on the
    // `legacyBaseline` paths, where it is the stored value being echoed back.
    if (def.type === "richtext") out[def.name] = typeof v === "string" ? v : normalizeRichText(v, richTextSchema);
    else if (def.type === "group" && typeof v === "object" && !Array.isArray(v)) out[def.name] = normalizeFields(def.fields, v as FieldValues, richTextSchema);
    else if (def.type === "repeater" && Array.isArray(v)) out[def.name] = v.map((it) => (it && typeof it === "object" ? normalizeFields(def.fields, it as FieldValues, richTextSchema) : it));
  }
  return out;
}

// --- assembled-page shape (the content-API result + revision snapshot) --------

export interface RenderedBlock {
  /** The block's optimistic-concurrency token — pass back as `expectedVersion`. */
  version: number;
  /** The placement id (cms_page_blocks) — stable per position; used for reorder/remove. */
  id: string;
  /** The underlying block instance id (cms_blocks) — used to edit the block's content. */
  block_id: string;
  block_type: string;
  title: string | null;
  fields: FieldValues;
  is_shared: boolean;
}

export interface PageTranslation {
  locale: string;
  slug: string;
}

export interface PageSeo {
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robots: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: ResolvedMedia | null;
  structuredData: unknown | null;
}

export interface AssembledPage {
  page: {
    id: string;
    title: string;
    slug: string;
    status: string;
    locale: string;
    /** The page's content-type slug (e.g. "article", "page") — lets a frontend route/render
     * by type. `null` if the type row is missing. */
    contentType: string | null;
    translationGroupId: string | null;
    /** Published sibling locales of this page (for hreflang alternates). */
    translations: PageTranslation[];
    fields: FieldValues | null;
    /** Back-compat: mirrors seo.metaTitle/metaDescription. */
    metaTitle: string | null;
    metaDescription: string | null;
    seo: PageSeo;
    /** Optimistic-concurrency token — pass back as `expectedVersion` on a write. */
    version: number;
  };
  regions: Record<string, RenderedBlock[]>;
  /** True when this is a live draft assembled behind a preview grant, rather than the
   * published snapshot — so a frontend can render a "you are viewing a draft" banner. */
  isPreview?: boolean;
}

// --- media -------------------------------------------------------------------

/** One authored field value inside a block / collection / page `fields` bag. Stored
 * as JSON; a `"media"` field is resolved from its stored id to a `ResolvedMedia` at
 * assemble time, and `group`/`repeater` fields nest further bags. */
export type FieldValue = JsonValue | ResolvedMedia | RichTextDoc | FieldValues | FieldValue[];

/** A block / collection / page `fields` bag — field name -> authored value. */
export interface FieldValues {
  [field: string]: FieldValue;
}

/** A `"media"` block field, resolved from a stored media id to a servable shape at
 * assemble time. `url` is the raw (full-size) serving path; pass `key` to `imageUrl()`
 * for on-the-fly transforms. `null` when the referenced media was deleted. */
export interface ResolvedMedia {
  id: string;
  key: string;
  url: string;
  alt: string | null;
  contentType: string | null;
  filename: string | null;
}

/** The public serving path for a media blob (relative; the client resolves it against
 * its base). Served by the Worker's public `GET /media/<key>` route. */
export function mediaPath(key: string): string {
  return `/media/${key}`;
}

/** Build a URL for a media blob, optionally with Cloudflare Image Resizing transforms
 * (`/cdn-cgi/image/<opts>/…`). With no transform opts it's just `mediaPath` (optionally
 * prefixed by `origin`). Transforms need the deploy's origin to resolve the source path. */
export function imageUrl(
  key: string,
  opts: { origin?: string; width?: number; height?: number; quality?: number; format?: "auto" | "webp" | "avif" } = {},
): string {
  const path = mediaPath(key);
  const origin = opts.origin ?? "";
  const hasTransform = opts.width || opts.height || opts.quality || opts.format;
  if (!hasTransform) return `${origin}${path}`;
  const params: string[] = [];
  if (opts.width) params.push(`width=${opts.width}`);
  if (opts.height) params.push(`height=${opts.height}`);
  if (opts.quality) params.push(`quality=${opts.quality}`);
  params.push(`format=${opts.format ?? "auto"}`);
  return `${origin}/cdn-cgi/image/${params.join(",")}${path}`;
}

/** Collect the media ids referenced by a fields payload, walking group/repeater nesting. */
function collectMediaIds(fields: FieldValues, schema: FieldDefinition[] | undefined, acc: Set<string>): void {
  if (!Array.isArray(schema)) return;
  for (const def of schema) {
    const v = fields[def.name];
    if (v == null) continue;
    if (def.type === "media") {
      if (typeof v === "string") acc.add(v);
    } else if (def.type === "group") {
      collectMediaIds(asObj(v), def.fields, acc);
    } else if (def.type === "repeater" && Array.isArray(v)) {
      for (const item of v) collectMediaIds(asObj(item), def.fields, acc);
    }
  }
}

/** Return a copy of `fields` with every `"media"` field resolved from its id to a
 * `ResolvedMedia` (or null), recursing into group/repeater nesting. */
function resolveMediaFields(
  fields: FieldValues,
  schema: FieldDefinition[] | undefined,
  mediaById: Map<string, ResolvedMedia>,
): FieldValues {
  if (!Array.isArray(schema)) return fields;
  const out: FieldValues = { ...fields };
  for (const def of schema) {
    const v = out[def.name];
    if (v == null) continue;
    if (def.type === "media") {
      if (typeof v === "string") out[def.name] = mediaById.get(v) ?? null;
    } else if (def.type === "group") {
      out[def.name] = resolveMediaFields(asObj(v), def.fields, mediaById);
    } else if (def.type === "repeater" && Array.isArray(v)) {
      out[def.name] = v.map((item) => resolveMediaFields(asObj(item), def.fields, mediaById));
    }
  }
  return out;
}

// --- structural view of the ACL'd Db (this package can't import the app's schema
// type, so it addresses tables by name — same ctx.db at runtime; ACL still applies). --

interface OrderBy {
  column: string;
  dir?: "asc" | "desc";
}
interface CmsDb {
  find(spec: {
    from: string;
    where?: Record<string, unknown>;
    orderBy?: OrderBy | OrderBy[];
    limit?: number;
    offset?: number;
    with?: Record<string, unknown>;
    /** Column projection. Each name is ACL-checked by `Db` (an unreadable or `hidden()`
     * column is a 403), so it is safe to build one from caller input. */
    select?: readonly string[];
  }): Promise<Array<Record<string, unknown>>>;
  insert(table: string, values: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(table: string, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  delete(table: string, id: string): Promise<boolean>;
  exec(sql: string, ...params: unknown[]): Promise<Array<Record<string, unknown>>>;
}
const cdb = (ctx: HandlerContext): CmsDb => ctx.db as unknown as CmsDb;

const notFound = (what: string) => new PramenError(`${what} not found`, 404, "not_found");
const asObj = (v: unknown): FieldValues => (v && typeof v === "object" ? (v as FieldValues) : {});
/**
 * An ISO-8601 UTC instant — the ONE format every timestamp this package writes by hand is
 * in, so it compares correctly against `$now()` and against the `expr.now()` column
 * defaults beside it.
 *
 * There used to be two of these. `expr.now()` emitted the `datetime('now')` space form, so
 * page-workflow stamps (`updatedAt`, `publishedAt`) matched THAT to stay lexically
 * comparable with their own column default, while collection managed timestamps minted ISO
 * to stay comparable with `$now()`. One column could not satisfy both, and the split was
 * the honest way to live with it — a trap documented at length on the `publish` field.
 *
 * `expr.now()` is ISO now, so the two requirements are the same requirement and there is
 * one helper. Existing rows written in the old shape are rewritten by
 * `isoTimestampBackfill()` (see `CMS_LEGACY_TIMESTAMP_COLUMNS`).
 */
const isoStamp = (): string => new Date().toISOString();

/** Alias kept because the page-workflow call sites read as "stamp it now". Same function. */
const nowStamp = isoStamp;

/** Does the caller hold one of these roles?
 *
 * Delegates to `authorizeHandler`, which is what the dispatcher uses to enforce a handler's
 * own `auth` — so "may call this handler" and "counts as an editor here" cannot answer
 * differently. The local copy took `roles` OR `role`, where the framework takes the UNION,
 * so an identity carrying both saw only one of them. */
const isEditor = (ctx: HandlerContext, roles: readonly string[]): boolean =>
  authorizeHandler([...roles], ctx.identity ?? null);

/** Assemble a page LIVE from its placements/blocks/types, grouped by region and ordered
 * by position, merging each shared placement's `overrides` over its block's fields. */
/** Resolve a page's content-type slug from its `typeId` (null when the type row is gone). */
async function contentTypeSlug(db: CmsDb, typeId: unknown): Promise<string | null> {
  if (typeof typeId !== "string" || !typeId) return null;
  const rows = await db.find({ from: "cms_content_types", where: { id: typeId }, limit: 1 });
  return rows[0] ? String(rows[0].slug) : null;
}

async function assembleLive(db: CmsDb, page: Record<string, unknown>): Promise<AssembledPage> {
  const placements = await db.find({
    from: "cms_page_blocks",
    where: { pageId: page.id },
    orderBy: [{ column: "region" }, { column: "position" }],
    with: { block: true },
  });
  const typeIds = [...new Set(placements.map((p) => asObj(p.block).typeId).filter((v): v is string => typeof v === "string"))];
  const types = typeIds.length ? await db.find({ from: "cms_block_types", where: { id: { in: typeIds } } }) : [];
  const typeById = new Map(types.map((t) => [t.id as string, { slug: t.slug as string, fieldsSchema: t.fieldsSchema as FieldDefinition[] | undefined }]));

  // Merge each placement's fields (base + shared overrides), then resolve `"media"`
  // fields (id → ResolvedMedia) in one batched lookup across the whole page.
  const merged = placements.map((p) => {
    const block = asObj(p.block);
    const fields = p.isShared
      ? { ...asObj(block.fields), ...asObj(p.overrides) }
      : { ...asObj(block.fields) };
    return { p, block, fields, schema: typeById.get(String(block.typeId))?.fieldsSchema };
  });
  const mediaIds = new Set<string>();
  for (const m of merged) collectMediaIds(m.fields, m.schema, mediaIds);
  const mediaById = new Map<string, ResolvedMedia>();
  if (mediaIds.size) {
    const rows = await db.find({ from: "cms_media", where: { id: { in: [...mediaIds] } } });
    for (const r of rows) {
      const file = asObj(r.file);
      mediaById.set(String(r.id), {
        id: String(r.id),
        key: String(file.key ?? ""),
        url: mediaPath(String(file.key ?? "")),
        alt: (r.alt as string | null) ?? null,
        contentType: (file.contentType as string | null) ?? null,
        filename: (file.filename as string | null) ?? null,
      });
    }
  }

  const regions: Record<string, RenderedBlock[]> = {};
  for (const m of merged) {
    const region = String(m.p.region);
    (regions[region] ??= []).push({
      id: String(m.p.id),
      block_id: String(m.block.id),
      version: typeof m.block.version === "number" ? m.block.version : 1,
      block_type: typeById.get(String(m.block.typeId))?.slug ?? "unknown",
      title: (m.block.title as string | null) ?? null,
      fields: resolveMediaFields(m.fields, m.schema, mediaById),
      is_shared: Boolean(m.p.isShared),
    });
  }
  const [translations, ogImage, contentType] = await Promise.all([siblingTranslations(db, page), resolveMediaId(db, page.ogImage), contentTypeSlug(db, page.typeId)]);
  return { page: pageMeta(page, translations, ogImage, contentType), regions };
}

/** Resolve a single media id to a ResolvedMedia (for og:image etc.), or null. */
async function resolveMediaId(db: CmsDb, id: unknown): Promise<ResolvedMedia | null> {
  if (typeof id !== "string" || !id) return null;
  const rows = await db.find({ from: "cms_media", where: { id }, limit: 1 });
  if (!rows[0]) return null;
  const file = asObj(rows[0].file);
  return {
    id: String(rows[0].id),
    key: String(file.key ?? ""),
    url: mediaPath(String(file.key ?? "")),
    alt: (rows[0].alt as string | null) ?? null,
    contentType: (file.contentType as string | null) ?? null,
    filename: (file.filename as string | null) ?? null,
  };
}

/** Publish a page: assemble a snapshot, write a revision (recording the actor), and point
 * the page at it. Shared by publishPage, approve, and the scheduled cms:publish task.
 * `clearSchedule` (a MANUAL publish) also clears the pending auto-unpublish token so a
 * stale scheduled unpublish can't later archive the page behind the editor's back; the
 * SCHEDULED cms:publish task passes false so a publish+unpublish pair both still fire. */
async function doPublish(db: CmsDb, page: Record<string, unknown>, actor: string | null, note?: string, clearSchedule = false): Promise<Record<string, unknown> | undefined> {
  const now = nowStamp();
  const snapshot = await assembleLive(db, { ...page, status: "published" });
  snapshot.page.status = "published";
  const rev = await db.insert("cms_page_revisions", { pageId: page.id, title: page.title, status: "published", snapshot, note: note ?? null, actor });
  const patch: Record<string, unknown> = { status: "published", publishedAt: now, scheduledAt: null, currentRevisionId: rev.id, updatedAt: now };
  if (clearSchedule) patch.unpublishAt = null;
  return db.update("cms_pages", String(page.id), patch);
}

/** Published sibling translations of a page (other locales in the same translation group),
 * for hreflang. Excludes the page itself. */
async function siblingTranslations(db: CmsDb, page: Record<string, unknown>): Promise<PageTranslation[]> {
  const group = page.translationGroupId;
  if (!group) return [];
  const rows = await db.find({ from: "cms_pages", where: { translationGroupId: group, status: "published" } });
  return rows
    .filter((r) => String(r.id) !== String(page.id))
    .map((r) => ({ locale: String(r.locale ?? "en"), slug: String(r.slug) }));
}

/** Project a page row to the public AssembledPage.page shape. */
function pageMeta(page: Record<string, unknown>, translations: PageTranslation[] = [], ogImage: ResolvedMedia | null = null, contentType: string | null = null): AssembledPage["page"] {
  const metaTitle = (page.metaTitle as string | null) ?? null;
  const metaDescription = (page.metaDescription as string | null) ?? null;
  return {
    id: String(page.id),
    title: String(page.title),
    slug: String(page.slug),
    status: String(page.status),
    locale: String(page.locale ?? "en"),
    version: typeof page.version === "number" ? page.version : 1,
    contentType,
    translationGroupId: (page.translationGroupId as string | null) ?? null,
    translations,
    fields: (page.fields as FieldValues | null) ?? null,
    metaTitle,
    metaDescription,
    seo: {
      metaTitle,
      metaDescription,
      canonicalUrl: (page.canonicalUrl as string | null) ?? null,
      robots: (page.robots as string | null) ?? null,
      ogTitle: (page.ogTitle as string | null) ?? null,
      ogDescription: (page.ogDescription as string | null) ?? null,
      ogImage,
      structuredData: (page.structuredData as unknown) ?? null,
    },
  };
}

async function nextPosition(db: CmsDb, pageId: string, region: string): Promise<number> {
  const rows = await db.exec(
    "SELECT COALESCE(MAX(position), -1) AS m FROM cms_page_blocks WHERE pageId = ? AND region = ?",
    pageId,
    region,
  );
  return Number(rows[0]?.m ?? -1) + 1;
}

async function loadBlockTypeBySlug(db: CmsDb, slug: string): Promise<Record<string, unknown>> {
  const rows = await db.find({ from: "cms_block_types", where: { slug }, limit: 1 });
  if (!rows[0]) throw new BadRequest(`unknown block type '${slug}'`);
  return rows[0];
}

async function assertRegionAllows(db: CmsDb, page: Record<string, unknown>, region: string, blockTypeSlug: string): Promise<void> {
  const ctRows = await db.find({ from: "cms_content_types", where: { id: page.typeId }, limit: 1 });
  const regions = (ctRows[0]?.regions as RegionDefinition[] | undefined) ?? [];
  const def = regions.find((r) => r.name === region);
  if (!def) throw new BadRequest(`region '${region}' is not defined on this page's content type`);
  // A non-empty allowedTypes restricts; null/undefined OR an empty array means "any type"
  // (matching the editor, which treats `[]` as unrestricted — otherwise the region is unusable).
  if (def.allowedTypes && def.allowedTypes.length && !def.allowedTypes.includes(blockTypeSlug)) {
    throw new BadRequest(`block type '${blockTypeSlug}' is not allowed in region '${region}'`);
  }
}

// --- handlers ----------------------------------------------------------------

// --- page preview links (signed capability urls) -----------------------------
//
// Preview used to be a ROLE check, so previewing a draft required an editor account —
// which excludes the person preview actually exists for: the stakeholder reviewing copy
// before it ships. A preview link is instead a signed, self-expiring CAPABILITY: it names
// ONE page, carries its own expiry, and is verified in the Worker before any read happens.
// Minting stays editor-gated; redeeming needs no account at all.
//
// Same machinery as signed file urls (`signToken`/`verifyToken` from @pramen/server), and
// the same fail-closed rule: without a usable secret we refuse to mint rather than hand out
// forgeable links.

// --- site furniture: normalization + resolution helpers ----------------------
//
// All of this runs on the WRITE path. A menu, a term tree and a widget list are documents
// the client posts whole, so "the editor wouldn't send that" is not a boundary — every one
// of these shapes is reachable with a curl.

const MENU_ITEM_KINDS: readonly MenuItemKind[] = ["custom", "page", "term", "collection"];

/** A stable machine key — the string `getMenu(name)` / `getWidgetArea(name)` resolves, and
 * a taxonomy's URL segment. Same rule as a page slug, and for the same reason: it lands in
 * a route. */
function assertKey(v: unknown, what: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!isSlugString(s)) throw new BadRequest(`${what} must be a key (lowercase letters, digits and single hyphens), got ${JSON.stringify(v)}`);
  return s;
}

/** A REGISTRY key — a block type's slug. Looser than {@link assertKey} by one character:
 * underscores are admitted, because a block-type slug is not a URL segment. It is the key a
 * front end maps to a component (`{ rich_text: RichText }`), and `rich_text` is the
 * convention every existing schema and the shipped example already use. */
function assertRegistryKey(v: unknown, what: string): string {
  const str = typeof v === "string" ? v.trim() : "";
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(str) || str.length > 80) {
    throw new BadRequest(`${what} must be a key (lowercase letters, digits, and single hyphens or underscores), got ${JSON.stringify(v)}`);
  }
  return str;
}

/** Refuse an editor write to a CODE-DEFINED type.
 *
 * `cmsBootstrap` reconciles these rows on every boot, so a save here would return 200 and
 * then be reverted at the next cold start, taking any content authored against the added
 * field with it. A 409 is the honest answer: the row exists, the edit is well-formed, and
 * the conflict is with a definition that lives somewhere this request cannot reach.
 *
 * The editor renders a managed type read-only, so this is the curl / stale-tab half. */
function assertNotManaged(row: Record<string, unknown>, what: string, defineFn: string): void {
  if (!row.managed) return;
  throw new Conflict(
    `${what} '${String(row.slug)}' is defined in code — edit its ${defineFn}(...) declaration and redeploy. ` +
      `A change saved here would be reverted by cmsBootstrap on the next boot.`,
  );
}

/**
 * An RPC handler name, as an authored field schema may name one (`optionsFrom`,
 * `referenceFrom`).
 *
 * Shape-checked rather than merely non-empty, because the editor interpolates it straight
 * into a request path — `fetch(\`${base}/rpc/${name}\`)`. `"../admin/data"` normalizes to
 * `/admin/data`, so a stored string an EDITOR authored became an arbitrary same-origin
 * authenticated POST fired by whoever opened the block — including an admin, whose token
 * passes the `/admin/*` gate the editor role cannot. A handler name is an identifier;
 * nothing that can traverse a path is one.
 */
function assertHandlerName(v: unknown, what: string): string {
  const str = typeof v === "string" ? v.trim() : "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(str) || str.length > 80) {
    throw new BadRequest(`${what} must be a handler name (a letter or underscore, then letters/digits/underscores), got ${JSON.stringify(v)}`);
  }
  return str;
}

/**
 * A menu item's `ref` for a non-`custom` kind.
 *
 * `menuHref` interpolates this into a path, so a ref starting with `/` produced
 * `//evil.example/` — protocol-relative, off-origin, in the site's primary nav on every
 * page — while the sibling `custom` branch three lines away ran the same string through
 * `isSafeHref`. A reference is an id or a slug: no slashes, no scheme, no dots.
 */
function assertRef(v: unknown, label: string, kind: MenuItemKind): string {
  const str = typeof v === "string" ? v.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(str)) {
    throw new BadRequest(`menu item '${label}' is a '${kind}' item, so its \`ref\` must be an id or slug (letters, digits, hyphens, underscores), got ${JSON.stringify(v)}`);
  }
  return str;
}

function assertLabel(v: unknown, what: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new BadRequest(`${what} must not be empty`);
  return s;
}

/**
 * Validate + canonicalize a posted menu tree.
 *
 * Every item is rebuilt field by field rather than spread: `items` is a `t.json()` column,
 * so anything in the posted object would be stored verbatim and handed to a layout that
 * renders it. Rebuilding is what makes the stored document exactly the declared shape.
 */
function normalizeMenuItems(raw: unknown, depth = 0, budget = { left: MAX_MENU_ITEMS }): MenuItem[] {
  if (!Array.isArray(raw)) {
    if (raw == null) return [];
    throw new BadRequest("menu items must be a list");
  }
  if (depth >= MAX_MENU_DEPTH) throw new BadRequest(`menu items may nest at most ${MAX_MENU_DEPTH} levels deep`);
  return raw.map((entry, i) => {
    // Counted across the WHOLE tree, not per level — the budget is threaded through the
    // recursion for that reason.
    if (--budget.left < 0) throw new BadRequest(`a menu may hold at most ${MAX_MENU_ITEMS} items`);
    const o = asObj(entry) as Record<string, unknown>;
    const label = assertLabel(o.label, `menu item [${i}] label`);
    const kind = (typeof o.kind === "string" ? o.kind : "custom") as MenuItemKind;
    if (!MENU_ITEM_KINDS.includes(kind)) {
      throw new BadRequest(`menu item '${label}' has unknown kind '${String(o.kind)}' (known: ${MENU_ITEM_KINDS.join(", ")})`);
    }
    // A stable id per item. Minted here when absent so a client that posts a tree without
    // ids still gets reorderable rows back, rather than a list React can only key by index.
    const item: MenuItem = { id: typeof o.id === "string" && o.id.trim() !== "" ? o.id.trim() : crypto.randomUUID(), label, kind };
    if (kind === "custom") {
      // The SAME allow-list a rich-text link mark goes through. A menu is rendered into an
      // `<a href>` on every page of the site, so `javascript:` here is exactly the hole
      // `isSafeHref` exists to close — and the editor is not the only writer.
      const url = normalizeHref(typeof o.url === "string" ? o.url : "");
      if (!isSafeHref(url)) throw new BadRequest(`menu item '${label}' needs a valid url (http(s), mailto:, tel:, a rooted path, or #anchor)`);
      item.url = url;
    } else {
      item.ref = assertRef(o.ref, label, kind);
    }
    // `target` is written into an anchor; anything but the four browsing-context keywords
    // is a named window, which is a way to reuse a tab the site does not own.
    if (typeof o.target === "string" && o.target !== "") {
      if (!["_self", "_blank", "_parent", "_top"].includes(o.target)) throw new BadRequest(`menu item '${label}' has an unsupported target '${o.target}'`);
      item.target = o.target;
    }
    if (typeof o.titleAttr === "string" && o.titleAttr !== "") item.titleAttr = o.titleAttr;
    if (typeof o.cssClasses === "string" && o.cssClasses !== "") item.cssClasses = o.cssClasses;
    const children = normalizeMenuItems(o.children, depth + 1, budget);
    if (children.length > 0) item.children = children;
    return item;
  });
}

/** Every `page`/`term` ref in a tree, so resolution is two queries rather than one per item. */
function collectMenuRefs(items: readonly MenuItem[], pages: Set<string>, terms: Set<string>): void {
  for (const it of items) {
    if (it.ref) {
      if (it.kind === "page") pages.add(it.ref);
      else if (it.kind === "term") terms.add(it.ref);
    }
    if (it.children) collectMenuRefs(it.children, pages, terms);
  }
}

/** Where a resolved menu item points. Passed to `menuHref` so a deployment can route its
 * own way without the CMS guessing. */
export type MenuHrefTarget =
  | { kind: "page"; slug: string; locale: string }
  | { kind: "term"; taxonomy: string; slug: string }
  | { kind: "collection"; slug: string };

/** A URL redirect's status. 301/308 are permanent (cached by browsers, and by search
 * engines as a canonical move); 302/307 are not. Anything else is not a redirect. */
export const REDIRECT_STATUSES: readonly number[] = [301, 302, 307, 308];

/**
 * The stored form of a redirect's `fromPath`: a rooted, query-less, fragment-less path.
 *
 * Canonicalized rather than merely validated, because matching is an exact string lookup
 * against a UNIQUE column. `"/old"` and `"/old/"` are the same URL to a visitor and two
 * rows here, so the second one is dead the moment the first exists — and which one wins is
 * whichever the editor happened to type. Trailing slash off (except the root), fragment
 * and query dropped, percent-encoding left exactly as written (the parser's, and the
 * request's, canonical form).
 */
export function normalizeRedirectPath(raw: unknown): string {
  const s = typeof raw === "string" ? normalizeHref(raw) : "";
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\")) {
    throw new BadRequest(`redirect path must be a rooted path like /old-url, got ${JSON.stringify(raw)}`);
  }
  const path = s.split("#")[0]!.split("?")[0]!;
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") || "/" : "/";
  // PERCENT-ENCODED, through the same parser the request goes through. A visitor's path
  // reaches `resolveRedirect` as `url.pathname`, which the WHATWG parser has already
  // encoded — so an editor typing `/o-nás` stored a string that the exact-match lookup
  // could never be handed, and the redirect silently never fired. On precisely the
  // non-English sites where slug changes are most common. Idempotent: an already-encoded
  // path parses back to itself.
  try {
    return new URL(trimmed, "https://pramen.invalid").pathname;
  } catch {
    throw new BadRequest(`redirect path is not a usable path: ${JSON.stringify(raw)}`);
  }
}

/**
 * Is this redirect a loop — does its destination resolve back to its own source?
 *
 * Compared through `normalizeRedirectPath` on BOTH sides, which a raw `from === to` did
 * not do: `from: "/old", to: "/old/"` differ as strings, so the guard passed — and then a
 * visitor hitting `/old` was sent to `/old/`, whose 404 handler canonicalizes the trailing
 * slash back to `/old` and matches the same row. An infinite redirect, from the one pair
 * the guard exists to catch. (A test here even asserted this pair was fine, on the reading
 * that a trailing-slash redirect is a normal canonicalization — true in general, and not
 * true when the lookup canonicalizes the slash away again.)
 *
 * An absolute destination is never a loop with a rooted source: it names an origin, and
 * `resolveRedirect` is only ever handed a path.
 */
function isSelfRedirect(fromPath: string, toPath: string): boolean {
  if (/^https?:\/\//i.test(toPath)) return false;
  try {
    return normalizeRedirectPath(toPath) === fromPath;
  } catch {
    return false;
  }
}

/** A redirect's destination: a rooted path or an absolute http(s) url. `mailto:`/`tel:` are
 * refused — they are not somewhere a `Location` header can send a page request. */
function normalizeRedirectTarget(raw: unknown): string {
  const s = typeof raw === "string" ? normalizeHref(raw) : "";
  const ok = /^https?:\/\//i.test(s) || (s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\"));
  if (!ok) throw new BadRequest(`redirect target must be a rooted path or an absolute http(s) url, got ${JSON.stringify(raw)}`);
  return s;
}

/** Assemble a flat term list into a forest, ordered by `position` then `label`.
 *
 * A term whose `parentId` names a row that is not in `rows` is treated as a ROOT rather
 * than dropped. That is the case where a parent was deleted mid-read (the FK sets children
 * to NULL, but a snapshot taken across the two states can see the old value) — and a term
 * that vanishes from a vocabulary listing is a worse answer than one that shows up a level
 * too high.
 */
function buildTermTree(rows: readonly Term[]): Term[] {
  const byId = new Map<string, Term & { children: Term[] }>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: Term[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    // `parent !== node` guards the one cycle a single row can make on its own; deeper
    // cycles are refused on write by `assertTermParent`, which is where a cycle is
    // actually preventable.
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: Term[]): Term[] => {
    list.sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
    for (const t of list) if (t.children) sort(t.children);
    return list;
  };
  return sort(roots);
}

const WIDGET_TYPES: readonly WidgetType[] = ["content", "menu", "component"];

/** A list limit from client input, clamped to what `listPages` already allows. Absent or
 * unusable falls back to the default rather than to "unbounded" — a request with no limit
 * on a store reached over RPC is the shape that made lists hang (GitHub #22). */
function clampLimit(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : PAGE_LIST_LIMIT;
  return Math.max(1, Math.min(n, PAGE_LIST_MAX_LIMIT));
}

/** The most terms one vocabulary (or one page) may carry in a single read.
 *
 * A vocabulary is read WHOLE by `listTerms`/`getTermTree` — a tree cannot be paged without
 * either losing branches or fetching ancestors separately — so the cap is what keeps that
 * read bounded. Tags are the case that grows without anyone deciding to grow it. */
const MAX_TERMS = 1000;

/** A redirect's editable fields, as posted. `requireEnds` is the CREATE case, where both
 * ends must be present; an update patches whichever keys it sends. */
interface RedirectPatch {
  fromPath?: string;
  toPath?: string;
  status?: number;
  enabled?: boolean;
  note?: string | null;
}

function redirectPatch(raw: unknown, requireEnds: boolean): RedirectPatch {
  const o = asObj(raw);
  const out: RedirectPatch = {};
  if (requireEnds || o.fromPath !== undefined) out.fromPath = normalizeRedirectPath(o.fromPath);
  if (requireEnds || o.toPath !== undefined) out.toPath = normalizeRedirectTarget(o.toPath);
  if (o.status !== undefined) {
    const status = typeof o.status === "number" ? Math.trunc(o.status) : NaN;
    if (!REDIRECT_STATUSES.includes(status)) throw new BadRequest(`redirect status must be one of ${REDIRECT_STATUSES.join(", ")}`);
    out.status = status;
  }
  if (o.enabled !== undefined) out.enabled = Boolean(o.enabled);
  if (o.note !== undefined) out.note = typeof o.note === "string" ? o.note : null;
  return out;
}

/** A required row id from client input. */
function requireId(raw: unknown, what = "id"): string {
  const v = (asObj(raw) as Record<string, unknown>)[what];
  if (typeof v !== "string" || v === "") throw new BadRequest(`${what} is required`);
  return v;
}

/** Resolve a taxonomy by its slug. */
async function taxonomyBySlug(db: CmsDb, slug: string): Promise<{ id: string; hierarchical: boolean } | null> {
  const rows = await db.find({ from: "cms_taxonomies", where: { slug }, select: ["id", "hierarchical"], limit: 1 });
  const row = rows[0];
  return row ? { id: String(row.id), hierarchical: Boolean(row.hierarchical) } : null;
}

/**
 * Check a proposed `parentId` for a term: it exists, it is in the SAME vocabulary, the
 * vocabulary is hierarchical, the tree stays inside {@link MAX_TERM_DEPTH}, and — for an
 * update — the new parent is not the term itself or one of its own descendants.
 *
 * The cycle check is the one that matters. `ON DELETE SET NULL` keeps the FK honest but
 * says nothing about shape, so `A.parent = B; B.parent = A` is two perfectly legal writes
 * that together make `buildTermTree` produce a forest missing both, and any recursive
 * renderer loop forever. It is only preventable on write, which is here.
 */
async function assertTermParent(db: CmsDb, tax: { id: string; hierarchical: boolean }, parentId: string | null, termId: string | null): Promise<void> {
  if (parentId === null) return;
  if (!tax.hierarchical) throw new BadRequest("this vocabulary is flat — its terms cannot have a parent");
  if (termId !== null && parentId === termId) throw new BadRequest("a term cannot be its own parent");
  // How many levels the MOVED term itself occupies. A leaf is 1; a term with children takes
  // its subtree with it, and a cap that ignored that admitted a 5-level tree grafted under a
  // 4-level parent. Zero cost on the create path, where there is no subtree yet.
  const moving = termId === null ? 1 : await subtreeHeight(db, tax.id, termId);
  let cursor: string | null = parentId;
  // `depth` counts ANCESTORS walked. The moved term sits at `ancestors + moving` levels, and
  // that is what the cap governs — counting ancestors alone admitted one level too many
  // (a chain of 5 put the new term at level 6 under a cap of 5).
  for (let depth = 0; cursor !== null; depth++) {
    // About to walk ancestor number `depth + 1`. The moved term would then sit at
    // `(depth + 1) + moving` levels, and THAT is what the cap governs.
    if (depth + 1 + moving > MAX_TERM_DEPTH) throw new BadRequest(`terms may nest at most ${MAX_TERM_DEPTH} levels deep`);
    const rows: Array<Record<string, unknown>> = await db.find({ from: "cms_terms", where: { id: cursor }, select: ["id", "taxonomyId", "parentId"], limit: 1 });
    const row = rows[0];
    if (!row) throw new BadRequest("parent term not found");
    if (String(row.taxonomyId) !== tax.id) throw new BadRequest("a term's parent must be in the same vocabulary");
    // Walking UP from the proposed parent: meeting the term being edited means the parent
    // is one of its own descendants, which is the cycle.
    if (termId !== null && String(row.id) === termId) throw new BadRequest("a term cannot be moved under one of its own descendants");
    cursor = row.parentId == null ? null : String(row.parentId);
  }
}

/** How many levels a term's own subtree occupies (a leaf is 1).
 *
 * One query for the whole vocabulary rather than a walk per level: a vocabulary is already
 * read whole by `listTerms`/`getTermTree` and capped at `MAX_TERMS`, so this is the same
 * bounded read those make, not a new unbounded one. */
async function subtreeHeight(db: CmsDb, taxonomyId: string, rootId: string): Promise<number> {
  const rows = await db.find({ from: "cms_terms", where: { taxonomyId }, select: ["id", "parentId"], limit: MAX_TERMS });
  const children = new Map<string, string[]>();
  for (const r of rows) {
    const parent = r.parentId == null ? null : String(r.parentId);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), String(r.id)]);
  }
  // Iterative, and bounded by MAX_TERMS: a cycle already in the store (written before the
  // check that now prevents one) must not spin here.
  let level = 0;
  let frontier = [rootId];
  const seen = new Set<string>();
  while (frontier.length > 0 && level <= MAX_TERM_DEPTH + 1) {
    level++;
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(...(children.get(id) ?? []));
    }
    frontier = next;
  }
  return level;
}

/**
 * Validate + canonicalize a posted widget list.
 *
 * Rebuilt field by field for the same reason a menu tree is: `widgets` is a `t.json()`
 * column handed straight to a layout, so whatever the client posts is what renders.
 * A `content` widget's rich text goes through the SAME `normalizeRichText` allow-list every
 * block field does — this is a second write path into the same renderer, and it must not be
 * a weaker one.
 */
function normalizeWidgets(raw: unknown, rtSchema: RichTextSchema): Widget[] {
  if (!Array.isArray(raw)) {
    if (raw == null) return [];
    throw new BadRequest("widgets must be a list");
  }
  return raw.map((entry, i) => {
    const o = asObj(entry) as Record<string, unknown>;
    const type = (typeof o.type === "string" ? o.type : "") as WidgetType;
    if (!WIDGET_TYPES.includes(type)) throw new BadRequest(`widget [${i}] has unknown type '${String(o.type)}' (known: ${WIDGET_TYPES.join(", ")})`);
    const w: Widget = { id: typeof o.id === "string" && o.id.trim() !== "" ? o.id.trim() : crypto.randomUUID(), type };
    if (typeof o.title === "string" && o.title !== "") w.title = o.title;
    if (type === "content") {
      w.content = normalizeRichText(o.content, rtSchema);
    } else if (type === "menu") {
      w.menuName = assertKey(o.menuName, `widget [${i}] menuName`);
    } else {
      const id = typeof o.componentId === "string" ? o.componentId.trim() : "";
      if (!id) throw new BadRequest(`widget [${i}] is a component widget and needs a componentId`);
      w.componentId = id;
      // Props are opaque to the CMS — the front end's component owns their meaning — but
      // they must be a JSON OBJECT, not a bare array or scalar that a spread would silently
      // turn into indexed props.
      if (o.componentProps !== undefined) {
        if (o.componentProps === null || typeof o.componentProps !== "object" || Array.isArray(o.componentProps)) {
          throw new BadRequest(`widget [${i}] componentProps must be an object`);
        }
        w.componentProps = o.componentProps as FieldValues;
      }
    }
    return w;
  });
}

/** What a preview link authorizes: one page, in one tenant, until `exp`. */
export interface PreviewToken {
  /** tenant */ t: string;
  /** page id — the grant is scoped to this ONE page, never "all drafts" */ p: string;
  /** expiry (epoch seconds) */ exp: number;
}

/** Secret preference order. `PREVIEW_SECRET` lets an operator rotate preview links without
 * invalidating every signed file url, but falling back keeps the common case zero-config. */
export const PREVIEW_SECRET_NAMES = ["PREVIEW_SECRET", "FILES_SECRET", "AUTH_SECRET"] as const;

/** Resolve the preview signing secret, or `undefined` when nothing usable is configured. */
export function previewSecret(env: EnvBag): string | undefined {
  return resolveSecret(env, PREVIEW_SECRET_NAMES);
}

const previewUnconfigured = () =>
  new PramenError("page preview is not configured (set a strong PREVIEW_SECRET, FILES_SECRET or AUTH_SECRET)", 503, "unavailable");

/** The viewer roles for a given handler config — `editorRoles ∪ reviewerRoles`, computed
 * exactly as `createCmsHandlers` computes them.
 *
 * Exported so `cmsRoutes()` cannot drift from `createCmsHandlers()`: pass the SAME options
 * object to both. Configuring the two independently was how the preview route ended up
 * presenting an identity neither the handler gate nor the ACL accepted — and a partial
 * customization still worked, so the failure appeared only for the app that had most
 * carefully renamed its roles. */
export function viewerRolesOf(opts: CmsHandlerOpts = {}): string[] {
  return [...new Set([...(opts.editorRoles ?? ["editor", "admin"]), ...(opts.reviewerRoles ?? ["reviewer", "admin"])])];
}

/** The viewer roles for the DEFAULT handler config. */
export const DEFAULT_VIEWER_ROLES = viewerRolesOf();

/** Where a preview link is redeemed. Spread `cmsRoutes()` into `app.routes` to serve it. */
export const PREVIEW_PATH = "/cms/preview";

/** Default preview-link lifetime: 1 hour. Long enough to share and open, short enough that
 * a link pasted into a public channel stops working the same afternoon. */
export const DEFAULT_PREVIEW_TTL_SECONDS = 3600;

/** `listPages` page size when the caller names none — the historical cap, kept so a client
 * that never learned to paginate sees exactly what it always did. */
export const PAGE_LIST_LIMIT = 100;
/** …and the ceiling on what a caller may ask for. A list screen pages; nobody needs the
 * whole table in one full-row response. */
export const PAGE_LIST_MAX_LIMIT = 500;

export interface CmsHandlerOpts {
  /** Roles permitted to call the editor mutations (also enforced by the ACL). Default
   * `["editor", "admin"]`. */
  editorRoles?: readonly string[];
  /** Max accepted media upload size in bytes (enforced at the Worker). Default 25 MB. */
  mediaMaxSize?: number;
  /** The locales this deployment publishes in, most-preferred first. Default `["en"]`.
   *
   * DECLARED, not inferred. The editor renders its i18n surface — the Translations panel,
   * the Locale field, the per-row locale column — only when there is more than one, and
   * `listCmsCapabilities` is how it finds out. Inferring "is this site multilingual?" from
   * the locales PRESENT IN DATA cannot work: the only way to create a second locale is
   * `createTranslation`, which the editor exposes from inside the very panel that would
   * stay hidden, so a monolingual site could never become multilingual.
   *
   * The first entry is the default stamped on a page created without one, which is why
   * `defaultLocale` is derived from this rather than configured beside it — two options
   * that can disagree about the same fact is how a Czech-only site ends up stamping "en". */
  locales?: readonly string[];
  /** Roles permitted to approve/reject a page in review and publish (the editorial gate).
   * Default `["reviewer", "admin"]`. */
  reviewerRoles?: readonly string[];
  /** Preview-link lifetime in seconds. Default 3600 (1 hour). */
  previewTtlSeconds?: number;
  /** The node/mark vocabulary accepted on write. Defaults to `DEFAULT_RICH_TEXT_SCHEMA`
   * (what the shipped editor produces). Widen it if your editor adds TipTap extensions —
   * a node type absent from the schema is DROPPED on write, not rejected. */
  richTextSchema?: RichTextSchema;
  /** Map a resolved menu reference to a site path. The CMS is headless, so it cannot know
   * how a deployment routes — this is the same seam `sitemapXml`'s `pageUrl` is.
   *
   * Defaults: a page is `/${slug}` on a monolingual deployment and `/${locale}/${slug}`
   * once `locales` declares more than one; a term is `/${taxonomy}/${term}`; a collection
   * is `/${slug}/`. Override it and `getMenu` follows — which is the point of storing a
   * REFERENCE rather than the href an editor typed: change the routing, not the menu. */
  menuHref?: (target: MenuHrefTarget) => string;
}

/** Build the CMS handler map. Spread into your app's handlers. Editor mutations are
 * gated both by `auth` (fast 403 before the body) and by the row ACL (cmsPolicies). */
export function createCmsHandlers(opts: CmsHandlerOpts = {}) {
  const editorRoles = opts.editorRoles ?? ["editor", "admin"];
  const editor = { auth: editorRoles };
  const mediaMaxSize = opts.mediaMaxSize ?? 25_000_000;
  const locales = opts.locales && opts.locales.length > 0 ? [...opts.locales] : ["en"];
  const defaultLocale = locales[0]!;
  const reviewerRoles = opts.reviewerRoles ?? ["reviewer", "admin"];
  const reviewer = { auth: reviewerRoles };
  const previewTtl = opts.previewTtlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS;
  const rtSchema = opts.richTextSchema ?? DEFAULT_RICH_TEXT_SCHEMA;
  const menuHref = opts.menuHref ?? ((target: MenuHrefTarget): string => {
    switch (target.kind) {
      // The locale segment appears only where there is a choice to make. A monolingual site
      // getting `/en/about` is the sitemap default's known wart, and a menu is the one place
      // it would be visible in the site's own chrome.
      case "page": return locales.length > 1 ? `/${target.locale}/${target.slug}` : `/${target.slug}`;
      case "term": return `/${target.taxonomy}/${target.slug}`;
      case "collection": return `/${target.slug}/`;
    }
  });
  // Anyone who edits OR reviews may VIEW content (a reviewer must preview a page + load its
  // content type/blocks before approving). Read/preview handlers use this; writes stay editor.
  const viewerRoles = [...new Set([...editorRoles, ...reviewerRoles])];
  const viewer = { auth: viewerRoles };

  // The caller's identity id (the audit actor), or null for a system/unauthenticated write.
  const actorOf = (ctx: HandlerContext): string | null => (typeof ctx.identity?.userId === "string" ? ctx.identity.userId : null);
  // Append an audit row for a workflow transition (synchronous, in the mutation's txn).
  const writeAudit = (db: CmsDb, e: { pageId: string; action: string; from?: string; to?: string; actor: string | null; note?: string }) =>
    db.insert("cms_audit", { pageId: e.pageId, action: e.action, fromStatus: e.from ?? null, toStatus: e.to ?? null, actor: e.actor, note: e.note ?? null });

  const mediaIdInput = {
    input: (raw: unknown): { id: string } => {
      const o = asObj(raw);
      if (typeof o.id !== "string" || o.id === "") throw new BadRequest("id is required");
      return { id: o.id };
    },
  };

  /** Mark a table changed after a RAW `exec` write.
   *
   * `Db.exec` is the one write path that does not record `touched`, so the DO never
   * broadcasts and every live subscriber keeps showing the pre-write state — a restored
   * page stays missing from an open page list, a purged one stays present. `deletePage`
   * goes through the ORM and DOES broadcast, so the staleness was asymmetric and read
   * like a lost write. */
  const markChanged = (db: CmsDb, ...tables: string[]): void => {
    const touched = (db as unknown as { touched?: Set<string> }).touched;
    if (touched) for (const t of tables) touched.add(t);
  };

  // --- optimistic concurrency ------------------------------------------------
  //
  // On the DO — the default store — a read-then-write inside one mutation is atomic: the
  // Durable Object is a single writer and DoSqliteDriver.exec is synchronous. The EDITORS
  // are not serialized, though: two people on the same page means last save wins, silently,
  // with no signal to the loser. Passing back the `version` you read turns that into a 409.
  //
  // CAVEAT — the D1 store has no interactive transaction (D1Driver.transaction is a
  // pass-through), so two requests in the same millisecond can both read and both write.
  // The guard still catches the human-scale editor race; it is not a hard mutex there.
  //
  // Optional by design: omitting `expectedVersion` keeps last-write-wins, so nothing breaks.
  const nextVersion = (row: Record<string, unknown>, expected: number | undefined, label: string): number => {
    // Do NOT default a missing version to 1. Under a field-restricted read grant that
    // projected the column away, `current` would be 1 forever: a client that legitimately
    // read version 7 gets a permanent unresolvable 409, and an unguarded save then LOWERS
    // the stored version, so a genuinely stale write is accepted later.
    if (typeof row.version !== "number") {
      // Log the actionable detail, return a generic 500 — PramenError's message goes to the
      // caller verbatim, so naming the column would leak the schema and ACL shape.
      console.error(`pramen/cms: ${label} has no readable version — grant read on the \`version\` column`);
      throw new Error("version unavailable");
    }
    const current = row.version;
    if (expected !== undefined && expected !== current) {
      throw new Conflict(`${label} was changed by someone else (you have version ${expected}, current is ${current}) — reload and reapply your edit`);
    }
    return current + 1;
  };
  const versionInput = (o: Record<string, unknown>): void => {
    if (o.expectedVersion === undefined) return;
    if (typeof o.expectedVersion !== "number" || !Number.isInteger(o.expectedVersion)) {
      throw new BadRequest("expectedVersion must be an integer");
    }
  };

  const pageIdInput = {
    input: (raw: unknown): { pageId: string } => {
      const o = asObj(raw);
      if (typeof o.pageId !== "string" || o.pageId === "") throw new BadRequest("pageId is required");
      return { pageId: o.pageId };
    },
  };

  // (slug, locale) uniqueness is enforced here because pramen's unique() is single-column.
  //
  // Slugs are global across content types — the constraint is (slug, locale), NOT
  // (slug, locale, typeId) — so the colliding page is very often one the caller cannot see:
  // the editor lists ONE type per tab, and "already exists" naming only slug + locale leaves
  // them staring at a list that visibly contains no such row. Both messages name the owning
  // type, the way the trash variant already named the trash.
  const assertSlugFree = async (db: CmsDb, slug: string, locale: string, exceptId?: string): Promise<void> => {
    const rows = await db.exec(
      "SELECT id, deletedAt, typeId FROM cms_pages WHERE slug = ? AND locale = ? LIMIT 1",
      slug,
      locale,
    );
    if (rows[0] && String(rows[0].id) !== exceptId) {
      const typeSlug = await contentTypeSlug(db, rows[0].typeId).catch(() => null);
      const under = typeSlug ? ` under content type '${typeSlug}'` : "";
      // A trashed page keeps its slug until purged (the (slug, locale) unique index is a
      // DB constraint, not advisory). Say so, rather than leave the caller hunting for a
      // page they cannot see.
      if (rows[0].deletedAt != null) {
        throw new BadRequest(`slug '${slug}' is held by a page in the trash for locale '${locale}'${under} — restore or purge it first`);
      }
      throw new BadRequest(`slug '${slug}' already exists for locale '${locale}'${under} — slugs are unique across all content types`);
    }
  };

    /**
     * One stored menu row, with its references resolved to hrefs.
     *
     * Shared by `getMenu` and `getWidgetArea` rather than inlined in the first: a `menu`
     * widget embeds a menu, and returning its RAW items there skipped every rule this
     * function exists to apply — a `page` item came back with no `url` at all (the layout
     * renders `href=undefined`) and an UNPUBLISHED page's label and id were served to
     * anonymous callers, which is precisely what the drop below prevents on the other path.
     */
    const resolveMenuRow = async (db: CmsDb, row: Record<string, unknown>): Promise<Menu> => {
      const items = Array.isArray(row.items) ? (row.items as MenuItem[]) : [];

      // Two lookups for the whole tree, not one per item. Both go through `ctx.db`, so the
      // caller's own read scope applies: for an anonymous visitor that is the public policy
      // (published, not trashed), which is precisely the filter a menu needs — a link to a
      // page that has been unpublished must not render.
      const pageIds = new Set<string>();
      const termIds = new Set<string>();
      collectMenuRefs(items, pageIds, termIds);
      const pages = new Map<string, { slug: string; locale: string }>();
      if (pageIds.size > 0) {
        const found = await db.find({ from: "cms_pages", where: { id: { in: [...pageIds] } }, select: ["id", "slug", "locale"], limit: pageIds.size });
        for (const p of found) pages.set(String(p.id), { slug: String(p.slug), locale: String(p.locale ?? defaultLocale) });
      }
      const terms = new Map<string, { slug: string; taxonomy: string }>();
      if (termIds.size > 0) {
        const found = await db.find({ from: "cms_terms", where: { id: { in: [...termIds] } }, select: ["id", "slug", "taxonomyId"], limit: termIds.size });
        const taxIds = [...new Set(found.map((t) => String(t.taxonomyId)))];
        const taxa = taxIds.length > 0 ? await db.find({ from: "cms_taxonomies", where: { id: { in: taxIds } }, select: ["id", "slug"], limit: taxIds.length }) : [];
        const taxSlug = new Map(taxa.map((t) => [String(t.id), String(t.slug)]));
        for (const t of found) {
          const tax = taxSlug.get(String(t.taxonomyId));
          if (tax) terms.set(String(t.id), { slug: String(t.slug), taxonomy: tax });
        }
      }

      // An item whose target no longer resolves is DROPPED, together with its subtree. A
      // nav entry that renders no href is a dead link on every page of the site, and
      // hoisting orphaned children would silently promote a third-level item into the top
      // bar. The editor's own `listMenus` returns the raw tree, so nothing is lost there.
      const resolve = (list: readonly MenuItem[]): MenuItem[] => {
        const out: MenuItem[] = [];
        for (const item of list) {
          let url = item.url;
          if (item.kind === "page") {
            const page = item.ref ? pages.get(item.ref) : undefined;
            if (!page) continue;
            url = menuHref({ kind: "page", slug: page.slug, locale: page.locale });
          } else if (item.kind === "term") {
            const term = item.ref ? terms.get(item.ref) : undefined;
            if (!term) continue;
            url = menuHref({ kind: "term", taxonomy: term.taxonomy, slug: term.slug });
          } else if (item.kind === "collection") {
            if (!item.ref) continue;
            url = menuHref({ kind: "collection", slug: item.ref });
          }
          // The MINTED url goes through the same allow-list the `custom` branch enforces on
          // write. A reference is interpolated into a path (`/${slug}/`), and a `ref` that
          // began with a slash produced `//evil.example/` — protocol-relative, off-origin,
          // in the site's primary nav on every page. `assertRef` refuses that shape on
          // write; this is the second half, because `menuHref` is host-supplied and a
          // deployment's own mapping can build an unsafe href out of a safe ref.
          if (!url || !isSafeHref(url)) continue;
          const children = item.children ? resolve(item.children) : [];
          out.push({ ...item, url, ...(children.length > 0 ? { children } : { children: undefined }) });
        }
        return out;
      };
      return { id: String(row.id), name: String(row.name), label: String(row.label), items: resolve(items) };
    };

  const TASK_PUBLISH = "cms:publish";
  const TASK_UNPUBLISH = "cms:unpublish";

  return {
    // ---- block types & content types (data-driven definitions) ----
    listBlockTypes: query((ctx) => cdb(ctx).find({ from: "cms_block_types", orderBy: { column: "name" } })),

    createBlockType: mutation(async (ctx, input: { name: string; slug: string; fieldsSchema?: FieldDefinition[]; icon?: string; category?: string; description?: string }) => {
      const db = cdb(ctx);
      // A clean 409 before the UNIQUE constraint fires. The editor authors these now, and a
      // raw constraint error reads as "the CMS broke" rather than "that slug is taken".
      const clash = await db.find({ from: "cms_block_types", where: { slug: input.slug }, select: ["id"], limit: 1 });
      if (clash[0]) throw new Conflict(`block type '${input.slug}' already exists`);
      return db.insert("cms_block_types", {
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        fieldsSchema: input.fieldsSchema ?? [],
        icon: input.icon ?? null,
        category: input.category ?? null,
      });
    }, {
      ...editor,
      input: (raw): { name: string; slug: string; fieldsSchema?: FieldDefinition[]; icon?: string; category?: string; description?: string } => {
        const o = asObj(raw);
        if (typeof o.name !== "string" || typeof o.slug !== "string") throw new BadRequest("name and slug are required");
        if (o.name.trim() === "") throw new BadRequest("name must not be empty");
        return {
          name: o.name.trim(),
          // A block type's slug is a registry key: the editor's inserter, `assertRegionAllows`
          // and `@pramen/cms/react`'s component map all resolve it. Held to the same shape as
          // any other key rather than accepted as free text.
          slug: assertRegistryKey(o.slug, "block type slug"),
          description: typeof o.description === "string" ? o.description : undefined,
          icon: typeof o.icon === "string" ? o.icon : undefined,
          category: typeof o.category === "string" ? o.category : undefined,
          fieldsSchema: normalizeFieldSchema(o.fieldsSchema),
        };
      },
    }),

    createContentType: mutation(async (ctx, input: { name: string; slug: string; regions: RegionDefinition[]; fieldsSchema?: FieldDefinition[]; defaultBlocks?: DefaultBlockDefinition[] }) => {
      return cdb(ctx).insert("cms_content_types", {
        name: input.name,
        slug: input.slug,
        regions: input.regions ?? [],
        fieldsSchema: input.fieldsSchema ?? [],
        defaultBlocks: input.defaultBlocks ?? [],
      });
    }, {
      ...editor,
      input: (raw): { name: string; slug: string; regions: RegionDefinition[]; fieldsSchema?: FieldDefinition[]; defaultBlocks?: DefaultBlockDefinition[] } => {
        const o = asObj(raw);
        if (typeof o.name !== "string" || typeof o.slug !== "string") throw new BadRequest("name and slug are required");
        // Non-EMPTY, not merely a string: a content type's slug is a URL segment in the
        // editor (`/types/:slug`) and the key `listPages({ contentType })` resolves. An
        // empty one builds `/types/` — a path the router drops the empty segment from, so
        // the type gets a tab that cannot be reached and a list that cannot be addressed.
        if (o.name.trim() === "") throw new BadRequest("name must not be empty");
        const regions = normalizeRegions(o.regions);
        return {
          name: o.name.trim(),
          // The SAME rule a block-type slug follows. They were split — block types admitted
          // `_`, content types did not — for no reason that survives inspection: both are
          // registry keys, and an underscore is as legal in the `/types/:slug` segment as it
          // is anywhere else in a URL. The example itself ships `seeded_doc`.
          slug: assertRegistryKey(o.slug, "content type slug"),
          regions,
          fieldsSchema: normalizeFieldSchema(o.fieldsSchema),
          defaultBlocks: normalizeDefaultBlocks(o.defaultBlocks, regions),
        };
      },
    }),

    /** Update a block type (found by `id` or `slug`). `slug` is the stable key and is
     * NOT mutable; only the metadata + `fieldsSchema` are patched. Editor-gated. This is
     * what lets a schema evolve (e.g. a field text → date) without recreating the type. */
    updateBlockType: mutation(async (ctx, input: { id?: string; slug?: string; name?: string; fieldsSchema?: FieldDefinition[]; icon?: string | null; category?: string | null; description?: string | null }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_block_types", where: input.id ? { id: input.id } : { slug: input.slug }, limit: 1 });
      const row = rows[0];
      if (!row) throw notFound("block type");
      assertNotManaged(row, "block type", "defineBlockType");
      const patch: Record<string, unknown> = {};
      for (const k of ["name", "fieldsSchema", "icon", "category", "description"] as const) {
        if (k in input) patch[k] = (input as Record<string, unknown>)[k];
      }
      return db.update("cms_block_types", String(row.id), patch);
    }, {
      ...editor,
      input: (raw): { id?: string; slug?: string; name?: string; fieldsSchema?: FieldDefinition[]; icon?: string | null; category?: string | null; description?: string | null } => {
        const o = asObj(raw);
        if (typeof o.id !== "string" && typeof o.slug !== "string") throw new BadRequest("id or slug is required");
        const out = { ...o } as Record<string, unknown>;
        // `name` is the label in the editor's inserter; blanking it leaves an unnamed entry
        // nobody can identify.
        if (o.name !== undefined) out.name = assertLabel(o.name, "block type name");
        if (o.fieldsSchema !== undefined) out.fieldsSchema = normalizeFieldSchema(o.fieldsSchema);
        return out as never;
      },
    }),

    /** Update a content type (found by `id` or `slug`). `slug` is the stable key and is
     * NOT mutable; `name`/`regions`/`fieldsSchema`/`defaultBlocks` are patched. Editor-gated. */
    updateContentType: mutation(async (ctx, input: { id?: string; slug?: string; name?: string; regions?: RegionDefinition[]; fieldsSchema?: FieldDefinition[]; defaultBlocks?: DefaultBlockDefinition[] }) => {
      const db = cdb(ctx);
      if ("regions" in input && (!Array.isArray(input.regions) || input.regions.length === 0)) throw new BadRequest("at least one region is required");
      const rows = await db.find({ from: "cms_content_types", where: input.id ? { id: input.id } : { slug: input.slug }, limit: 1 });
      const row = rows[0];
      if (!row) throw notFound("content type");
      assertNotManaged(row, "content type", "defineContentType");
      const patch: Record<string, unknown> = {};
      for (const k of ["name", "regions", "fieldsSchema", "defaultBlocks"] as const) {
        if (k in input) patch[k] = (input as Record<string, unknown>)[k];
      }
      // A `defaultBlocks` patch that does NOT also send regions is checked here against the
      // STORED ones — the input parser has no row to read, and a default block placed into a
      // region the type does not declare is created into a key no renderer looks at.
      if (patch.defaultBlocks !== undefined && patch.regions === undefined) {
        patch.defaultBlocks = normalizeDefaultBlocks(patch.defaultBlocks, (Array.isArray(row.regions) ? row.regions : []) as RegionDefinition[]);
      }
      return db.update("cms_content_types", String(row.id), patch);
    }, {
      ...editor,
      input: (raw): { id?: string; slug?: string; name?: string; regions?: RegionDefinition[]; fieldsSchema?: FieldDefinition[]; defaultBlocks?: DefaultBlockDefinition[] } => {
        const o = asObj(raw);
        if (typeof o.id !== "string" && typeof o.slug !== "string") throw new BadRequest("id or slug is required");
        const out = { ...o } as Record<string, unknown>;
        // `name` is the editor's tab label; blanking it leaves an unlabelled tab.
        if (o.name !== undefined) out.name = assertLabel(o.name, "content type name");
        if (o.regions !== undefined) out.regions = normalizeRegions(o.regions);
        if (o.fieldsSchema !== undefined) out.fieldsSchema = normalizeFieldSchema(o.fieldsSchema);
        // Checked against the regions being SAVED where the same call sends both — patching
        // only `defaultBlocks` cannot see the stored regions from an input parser, and the
        // handler re-checks below.
        if (out.defaultBlocks !== undefined && out.regions !== undefined) {
          out.defaultBlocks = normalizeDefaultBlocks(out.defaultBlocks, out.regions as RegionDefinition[]);
        }
        return out as never;
      },
    }),

    // ---- site furniture: menus ----------------------------------------------
    //
    // A menu is read WHOLE (`getMenu("primary")` on every page render) and written whole.
    // The public read RESOLVES references — that is what makes a `page` item follow its
    // page's slug instead of freezing the href an editor typed once.

    /** One menu, references resolved to hrefs. PUBLIC — a menu is site chrome.
     *
     * Returns `null` for an unknown name rather than 404ing, because a layout asking for a
     * menu it has not created yet is the normal state of a site being built, and a thrown
     * error there takes down every page instead of rendering no nav. */
    getMenu: query(async (ctx, input: { name: string }): Promise<Menu | null> => {
      const rows = await cdb(ctx).find({ from: "cms_menus", where: { name: input.name }, limit: 1 });
      const row = rows[0];
      if (!row) return null;
      return resolveMenuRow(cdb(ctx), row);
    }, {
      input: (raw): { name: string } => ({ name: assertKey(asObj(raw).name, "menu name") }),
    }),

    /** Every menu, RAW (references unresolved) — the editor's list.
     *
     * Capped like every other list here. A site-furniture table is small by nature, which is
     * an argument for the cap being generous, not for its absence: an unbounded SELECT of a
     * wide row over RPC is the D1 failure shape from GitHub #22, and "small by nature" is
     * not a property the query planner knows about. */
    listMenus: query((ctx) => cdb(ctx).find({ from: "cms_menus", orderBy: { column: "label" }, limit: PAGE_LIST_MAX_LIMIT }), viewer),

    createMenu: mutation(async (ctx, input: { name: string; label: string; items?: MenuItem[] }) => {
      const db = cdb(ctx);
      // A clean 409, as every sibling create handler gives. Without it a taken key surfaced
      // as the UNIQUE constraint's own 500 — and the e2e only asserts "not 200", so it
      // could not tell the two apart.
      const clash = await db.find({ from: "cms_menus", where: { name: input.name }, select: ["id"], limit: 1 });
      if (clash[0]) throw new Conflict(`menu '${input.name}' already exists`);
      return db.insert("cms_menus", { name: input.name, label: input.label, items: input.items ?? [] });
    }, {
      ...editor,
      input: (raw): { name: string; label: string; items?: MenuItem[] } => {
        const o = asObj(raw);
        return { name: assertKey(o.name, "menu name"), label: assertLabel(o.label, "menu label"), items: normalizeMenuItems(o.items) };
      },
    }),

    /** Patch a menu found by `id` or `name`. `name` is the key layout code resolves and is
     * NOT mutable — retitling is what `label` is for. */
    updateMenu: mutation(async (ctx, input: { id?: string; name?: string; label?: string; items?: MenuItem[]; expectedVersion?: number }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_menus", where: input.id ? { id: input.id } : { name: input.name }, limit: 1 });
      const row = rows[0];
      if (!row) throw notFound("menu");
      const patch: Record<string, unknown> = { updatedAt: nowStamp(), version: nextVersion(row, input.expectedVersion, "this menu") };
      if (input.label !== undefined) patch.label = input.label;
      if (input.items !== undefined) patch.items = input.items;
      return db.update("cms_menus", String(row.id), patch);
    }, {
      ...editor,
      input: (raw): { id?: string; name?: string; label?: string; items?: MenuItem[]; expectedVersion?: number } => {
        const o = asObj(raw);
        const out: { id?: string; name?: string; label?: string; items?: MenuItem[]; expectedVersion?: number } = {};
        if (typeof o.id === "string") out.id = o.id;
        else if (typeof o.name === "string") out.name = assertKey(o.name, "menu name");
        else throw new BadRequest("id or name is required");
        if (o.label !== undefined) out.label = assertLabel(o.label, "menu label");
        if (o.items !== undefined) out.items = normalizeMenuItems(o.items);
        if (typeof o.expectedVersion === "number") out.expectedVersion = o.expectedVersion;
        return out;
      },
    }),

    deleteMenu: mutation(async (ctx, input: { id: string }) => {
      const ok = await cdb(ctx).delete("cms_menus", input.id);
      if (!ok) throw notFound("menu");
      return { ok: true as const };
    }, {
      ...editor,
      input: (raw): { id: string } => {
        const id = asObj(raw).id;
        if (typeof id !== "string" || id === "") throw new BadRequest("id is required");
        return { id };
      },
    }),

    // ---- site furniture: redirects -------------------------------------------

    /** Resolve a request path to its redirect, or `null`. PUBLIC and READ-ONLY: this is
     * what a front end calls on a 404, so it is anonymous traffic on the hot path.
     *
     * `enabled` is enforced by the public read POLICY, not by a `where` here, so a disabled
     * redirect is invisible to every anonymous read (this handler, a future listing, a
     * relation traversal) rather than to the one call that remembered to filter. */
    resolveRedirect: query(async (ctx, input: { path: string }): Promise<{ to: string; status: number } | null> => {
      const rows = await cdb(ctx).find({ from: "cms_redirects", where: { fromPath: input.path, enabled: true }, select: ["toPath", "status"], limit: 1 });
      const row = rows[0];
      return row ? { to: String(row.toPath), status: Number(row.status ?? 301) } : null;
    }, {
      input: (raw): { path: string } => ({ path: normalizeRedirectPath(asObj(raw).path) }),
    }),

    listRedirects: query((ctx, input: { limit?: number; offset?: number }) => {
      return cdb(ctx).find({ from: "cms_redirects", orderBy: { column: "fromPath" }, limit: input.limit ?? PAGE_LIST_LIMIT, offset: input.offset ?? 0 });
    }, {
      ...viewer,
      input: (raw): { limit?: number; offset?: number } => {
        const o = asObj(raw);
        return { limit: clampLimit(o.limit), offset: typeof o.offset === "number" && o.offset > 0 ? Math.floor(o.offset) : 0 };
      },
    }),

    createRedirect: mutation(async (ctx, input: RedirectPatch & { fromPath: string; toPath: string }) => {
      // A redirect to itself is an infinite loop the moment it is enabled, and the browser
      // is what discovers it. Cheap to refuse here; impossible to diagnose from the outside.
      if (isSelfRedirect(input.fromPath, input.toPath)) throw new BadRequest("a redirect cannot point at itself");
      const db = cdb(ctx);
      const clash = await db.find({ from: "cms_redirects", where: { fromPath: input.fromPath }, select: ["id"], limit: 1 });
      if (clash[0]) throw new Conflict(`a redirect from '${input.fromPath}' already exists`);
      return db.insert("cms_redirects", {
        fromPath: input.fromPath,
        toPath: input.toPath,
        status: input.status ?? 301,
        enabled: input.enabled ?? true,
        note: input.note ?? null,
      });
    }, {
      ...editor,
      input: (raw): RedirectPatch & { fromPath: string; toPath: string } => redirectPatch(raw, true) as RedirectPatch & { fromPath: string; toPath: string },
    }),

    updateRedirect: mutation(async (ctx, input: RedirectPatch & { id: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_redirects", where: { id: input.id }, limit: 1 });
      const row = rows[0];
      if (!row) throw notFound("redirect");
      const from = input.fromPath ?? String(row.fromPath);
      const to = input.toPath ?? String(row.toPath);
      if (isSelfRedirect(from, to)) throw new BadRequest("a redirect cannot point at itself");
      if (input.fromPath && input.fromPath !== row.fromPath) {
        const clash = await db.find({ from: "cms_redirects", where: { fromPath: input.fromPath }, select: ["id"], limit: 1 });
        if (clash[0]) throw new Conflict(`a redirect from '${input.fromPath}' already exists`);
      }
      const patch: Record<string, unknown> = { updatedAt: nowStamp() };
      for (const k of ["fromPath", "toPath", "status", "enabled", "note"] as const) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      return db.update("cms_redirects", input.id, patch);
    }, {
      ...editor,
      input: (raw): RedirectPatch & { id: string } => ({ id: requireId(raw), ...redirectPatch(raw, false) }),
    }),

    deleteRedirect: mutation(async (ctx, input: { id: string }) => {
      const ok = await cdb(ctx).delete("cms_redirects", input.id);
      if (!ok) throw notFound("redirect");
      return { ok: true as const };
    }, {
      ...editor,
      input: (raw): { id: string } => {
        const id = asObj(raw).id;
        if (typeof id !== "string" || id === "") throw new BadRequest("id is required");
        return { id };
      },
    }),

    // ---- site furniture: taxonomies ------------------------------------------
    //
    // `category` and `tag` are not built in: they are two rows a deployment creates, the
    // same way it creates its content types. A vocabulary that is hierarchical allows
    // `parentId` on its terms; a flat one refuses it rather than storing something no
    // listing renders.

    /** Every vocabulary. PUBLIC — like content types, a taxonomy's slug is structural (it
     * is a URL segment) and a front end routes on it. */
    listTaxonomies: query((ctx) => cdb(ctx).find({ from: "cms_taxonomies", orderBy: { column: "label" }, limit: PAGE_LIST_MAX_LIMIT })),

    createTaxonomy: mutation(async (ctx, input: { slug: string; label: string; pluralLabel?: string; description?: string; hierarchical?: boolean }) => {
      const db = cdb(ctx);
      const clash = await db.find({ from: "cms_taxonomies", where: { slug: input.slug }, select: ["id"], limit: 1 });
      if (clash[0]) throw new Conflict(`taxonomy '${input.slug}' already exists`);
      return db.insert("cms_taxonomies", {
        slug: input.slug,
        label: input.label,
        pluralLabel: input.pluralLabel ?? null,
        description: input.description ?? null,
        hierarchical: input.hierarchical ?? false,
      });
    }, {
      ...editor,
      input: (raw): { slug: string; label: string; pluralLabel?: string; description?: string; hierarchical?: boolean } => {
        const o = asObj(raw);
        return {
          slug: assertKey(o.slug, "taxonomy slug"),
          label: assertLabel(o.label, "taxonomy label"),
          pluralLabel: typeof o.pluralLabel === "string" ? o.pluralLabel : undefined,
          description: typeof o.description === "string" ? o.description : undefined,
          hierarchical: typeof o.hierarchical === "boolean" ? o.hierarchical : undefined,
        };
      },
    }),

    /** Patch a vocabulary. `slug` is a URL segment and the key `listTerms` resolves, so it
     * is not mutable — the same rule content types and block types already follow.
     *
     * Turning `hierarchical` OFF is refused while any term still has a parent. Allowing it
     * would leave a stored hierarchy that no reader renders and no writer can clear, and
     * flattening the terms silently is a destructive edit behind a checkbox. */
    updateTaxonomy: mutation(async (ctx, input: { id: string; label?: string; pluralLabel?: string | null; description?: string | null; hierarchical?: boolean }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_taxonomies", where: { id: input.id }, limit: 1 });
      const row = rows[0];
      if (!row) throw notFound("taxonomy");
      if (input.hierarchical === false && row.hierarchical) {
        const nested = await db.find({ from: "cms_terms", where: { taxonomyId: input.id, parentId: { isNull: false } }, select: ["id"], limit: 1 });
        if (nested[0]) throw new BadRequest("this vocabulary still has nested terms — move them to the top level before making it flat");
      }
      const patch: Record<string, unknown> = {};
      for (const k of ["label", "pluralLabel", "description", "hierarchical"] as const) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      return db.update("cms_taxonomies", input.id, patch);
    }, {
      ...editor,
      input: (raw): { id: string; label?: string; pluralLabel?: string | null; description?: string | null; hierarchical?: boolean } => {
        const o = asObj(raw);
        if (typeof o.id !== "string" || o.id === "") throw new BadRequest("id is required");
        const out: { id: string; label?: string; pluralLabel?: string | null; description?: string | null; hierarchical?: boolean } = { id: o.id };
        if (o.label !== undefined) out.label = assertLabel(o.label, "taxonomy label");
        if (o.pluralLabel !== undefined) out.pluralLabel = typeof o.pluralLabel === "string" ? o.pluralLabel : null;
        if (o.description !== undefined) out.description = typeof o.description === "string" ? o.description : null;
        if (typeof o.hierarchical === "boolean") out.hierarchical = o.hierarchical;
        return out;
      },
    }),

    /** Delete a vocabulary. Its terms go with it, and their page assignments with those —
     * both by real `ON DELETE CASCADE`, so the cleanup is the DB's and cannot be half-done
     * by a handler that threw between two writes. */
    deleteTaxonomy: mutation(async (ctx, input: { id: string }) => {
      const ok = await cdb(ctx).delete("cms_taxonomies", input.id);
      if (!ok) throw notFound("taxonomy");
      return { ok: true as const };
    }, {
      ...editor,
      input: (raw): { id: string } => {
        const id = asObj(raw).id;
        if (typeof id !== "string" || id === "") throw new BadRequest("id is required");
        return { id };
      },
    }),

    /** One vocabulary's terms, flat, ordered. PUBLIC. */
    listTerms: query(async (ctx, input: { taxonomy: string }): Promise<Term[]> => {
      const db = cdb(ctx);
      const tax = await taxonomyBySlug(db, input.taxonomy);
      if (!tax) return [];
      const rows = await db.find({ from: "cms_terms", where: { taxonomyId: tax.id }, orderBy: [{ column: "position" }, { column: "label" }], limit: MAX_TERMS });
      return rows as unknown as Term[];
    }, {
      input: (raw): { taxonomy: string } => ({ taxonomy: assertKey(asObj(raw).taxonomy, "taxonomy slug") }),
    }),

    /** One vocabulary's terms as a TREE. PUBLIC. Assembled here rather than by the caller
     * because a hierarchy is what the nav renders and every consumer would otherwise write
     * the same fold. */
    getTermTree: query(async (ctx, input: { taxonomy: string }): Promise<Term[]> => {
      const db = cdb(ctx);
      const tax = await taxonomyBySlug(db, input.taxonomy);
      if (!tax) return [];
      const rows = await db.find({ from: "cms_terms", where: { taxonomyId: tax.id }, limit: MAX_TERMS });
      return buildTermTree(rows as unknown as Term[]);
    }, {
      input: (raw): { taxonomy: string } => ({ taxonomy: assertKey(asObj(raw).taxonomy, "taxonomy slug") }),
    }),

    createTerm: mutation(async (ctx, input: { taxonomy: string; slug: string; label: string; description?: string; parentId?: string | null; position?: number }) => {
      const db = cdb(ctx);
      const tax = await taxonomyBySlug(db, input.taxonomy);
      if (!tax) throw notFound("taxonomy");
      await assertTermParent(db, tax, input.parentId ?? null, null);
      const clash = await db.find({ from: "cms_terms", where: { taxonomyId: tax.id, slug: input.slug }, select: ["id"], limit: 1 });
      if (clash[0]) throw new Conflict(`term '${input.slug}' already exists in '${input.taxonomy}'`);
      return db.insert("cms_terms", {
        taxonomyId: tax.id,
        slug: input.slug,
        label: input.label,
        description: input.description ?? null,
        parentId: input.parentId ?? null,
        position: input.position ?? 0,
      });
    }, {
      ...editor,
      input: (raw): { taxonomy: string; slug: string; label: string; description?: string; parentId?: string | null; position?: number } => {
        const o = asObj(raw);
        return {
          taxonomy: assertKey(o.taxonomy, "taxonomy slug"),
          slug: assertKey(o.slug, "term slug"),
          label: assertLabel(o.label, "term label"),
          description: typeof o.description === "string" ? o.description : undefined,
          parentId: typeof o.parentId === "string" && o.parentId !== "" ? o.parentId : null,
          position: typeof o.position === "number" ? Math.trunc(o.position) : undefined,
        };
      },
    }),

    updateTerm: mutation(async (ctx, input: { id: string; slug?: string; label?: string; description?: string | null; parentId?: string | null; position?: number }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_terms", where: { id: input.id }, limit: 1 });
      const row = rows[0];
      if (!row) throw notFound("term");
      const taxRows = await db.find({ from: "cms_taxonomies", where: { id: row.taxonomyId }, limit: 1 });
      const tax = taxRows[0];
      if (!tax) throw notFound("taxonomy");
      if (input.parentId !== undefined) {
        await assertTermParent(db, { id: String(tax.id), hierarchical: Boolean(tax.hierarchical) }, input.parentId, input.id);
      }
      // A term's slug IS mutable, unlike a taxonomy's: it is the leaf of a URL, an editor
      // fixing a typo in one is routine, and the uniqueness that matters is enforced below
      // and by the composite index behind it.
      if (input.slug && input.slug !== row.slug) {
        const clash = await db.find({ from: "cms_terms", where: { taxonomyId: row.taxonomyId, slug: input.slug }, select: ["id"], limit: 1 });
        if (clash[0]) throw new Conflict(`term '${input.slug}' already exists in this vocabulary`);
      }
      const patch: Record<string, unknown> = {};
      for (const k of ["slug", "label", "description", "parentId", "position"] as const) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      return db.update("cms_terms", input.id, patch);
    }, {
      ...editor,
      input: (raw): { id: string; slug?: string; label?: string; description?: string | null; parentId?: string | null; position?: number } => {
        const o = asObj(raw);
        if (typeof o.id !== "string" || o.id === "") throw new BadRequest("id is required");
        const out: { id: string; slug?: string; label?: string; description?: string | null; parentId?: string | null; position?: number } = { id: o.id };
        if (o.slug !== undefined) out.slug = assertKey(o.slug, "term slug");
        if (o.label !== undefined) out.label = assertLabel(o.label, "term label");
        if (o.description !== undefined) out.description = typeof o.description === "string" ? o.description : null;
        if (o.parentId !== undefined) out.parentId = typeof o.parentId === "string" && o.parentId !== "" ? o.parentId : null;
        if (typeof o.position === "number") out.position = Math.trunc(o.position);
        return out;
      },
    }),

    /** Delete a term. Children are promoted to the top level (`ON DELETE SET NULL`) and
     * page assignments are removed (`ON DELETE CASCADE`) — see `cms_terms.parentId`. */
    deleteTerm: mutation(async (ctx, input: { id: string }) => {
      const ok = await cdb(ctx).delete("cms_terms", input.id);
      if (!ok) throw notFound("term");
      return { ok: true as const };
    }, {
      ...editor,
      input: (raw): { id: string } => {
        const id = asObj(raw).id;
        if (typeof id !== "string" || id === "") throw new BadRequest("id is required");
        return { id };
      },
    }),

    /** A page's assigned terms. PUBLIC (a published page's classification is public). */
    listPageTerms: query(async (ctx, input: { pageId: string }): Promise<Term[]> => {
      const db = cdb(ctx);
      // Read the PAGE first, through `ctx.db`, so the caller's own page scope decides
      // whether this answers at all. Without it the handler never touched `cms_pages` — and
      // the public grants on the junction and on terms are unscoped `allow()` — so anyone
      // holding a page id could read a draft or trashed page's classification, and the
      // non-empty answer confirmed the page exists. `listPagesByTerm` was already safe for
      // the opposite reason: it traverses `where: { terms: … }`, so the page scope
      // AND-merges. This is the same rule, applied from the other end.
      const page = await db.find({ from: "cms_pages", where: { id: input.pageId }, select: ["id"], limit: 1 });
      if (!page[0]) return [];
      const links = await db.find({ from: "cms_page_terms", where: { pageId: input.pageId }, select: ["termId"], limit: MAX_TERMS });
      const ids = links.map((l) => String(l.termId));
      if (ids.length === 0) return [];
      const rows = await db.find({ from: "cms_terms", where: { id: { in: ids } }, orderBy: [{ column: "position" }, { column: "label" }], limit: ids.length });
      return rows as unknown as Term[];
    }, {
      input: (raw): { pageId: string } => {
        const id = asObj(raw).pageId;
        if (typeof id !== "string" || id === "") throw new BadRequest("pageId is required");
        return { pageId: id };
      },
    }),

    /** Replace a page's term assignments wholesale.
     *
     * Set semantics, not add/remove: the editor's panel holds the whole selection, and two
     * calls that each patch one end of it race into a state neither asked for. Existing
     * links that survive are LEFT ALONE rather than deleted and reinserted, so the junction
     * rows (and any future column on them) are stable across a save that changed nothing. */
    setPageTerms: mutation(async (ctx, input: { pageId: string; termIds: string[] }) => {
      const db = cdb(ctx);
      const pages = await db.find({ from: "cms_pages", where: { id: input.pageId }, select: ["id"], limit: 1 });
      if (!pages[0]) throw notFound("page");
      const wanted = new Set(input.termIds);
      if (wanted.size > 0) {
        // Every id must be a real term. Without this the junction happily stores a dangling
        // uuid — the FK would catch it, but as a driver error with no HTTP status.
        const found = await db.find({ from: "cms_terms", where: { id: { in: [...wanted] } }, select: ["id"], limit: wanted.size });
        if (found.length !== wanted.size) throw new BadRequest("one or more termIds are not terms");
      }
      const existing = await db.find({ from: "cms_page_terms", where: { pageId: input.pageId }, select: ["id", "termId"], limit: MAX_TERMS });
      const have = new Map(existing.map((l) => [String(l.termId), String(l.id)]));
      for (const [termId, linkId] of have) if (!wanted.has(termId)) await db.delete("cms_page_terms", linkId);
      for (const termId of wanted) if (!have.has(termId)) await db.insert("cms_page_terms", { pageId: input.pageId, termId });
      return { ok: true as const, count: wanted.size };
    }, {
      ...editor,
      input: (raw): { pageId: string; termIds: string[] } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string" || o.pageId === "") throw new BadRequest("pageId is required");
        if (!Array.isArray(o.termIds)) throw new BadRequest("termIds must be a list");
        const ids = o.termIds.map((v) => {
          if (typeof v !== "string" || v === "") throw new BadRequest("termIds must be a list of ids");
          return v;
        });
        if (ids.length > MAX_TERMS) throw new BadRequest(`a page may carry at most ${MAX_TERMS} terms`);
        return { pageId: o.pageId, termIds: ids };
      },
    }),

    /** Published pages carrying a term. PUBLIC.
     *
     * A relation traversal (`where: { terms: { id } }`), so the page read scope is
     * AND-merged as it is anywhere else — traversal cannot widen access, and an anonymous
     * caller sees published pages only. */
    listPagesByTerm: query(async (ctx, input: { taxonomy: string; term: string; limit?: number; offset?: number }) => {
      const db = cdb(ctx);
      const tax = await taxonomyBySlug(db, input.taxonomy);
      if (!tax) return [];
      const terms = await db.find({ from: "cms_terms", where: { taxonomyId: tax.id, slug: input.term }, select: ["id"], limit: 1 });
      const term = terms[0];
      if (!term) return [];
      return db.find({
        from: "cms_pages",
        where: { terms: { id: String(term.id) } },
        orderBy: { column: "createdAt", dir: "desc" },
        select: ["id", "typeId", "title", "slug", "locale", "status", "publishedAt"],
        limit: input.limit ?? PAGE_LIST_LIMIT,
        offset: input.offset ?? 0,
      });
    }, {
      input: (raw): { taxonomy: string; term: string; limit?: number; offset?: number } => {
        const o = asObj(raw);
        return {
          taxonomy: assertKey(o.taxonomy, "taxonomy slug"),
          term: assertKey(o.term, "term slug"),
          limit: clampLimit(o.limit),
          offset: typeof o.offset === "number" && o.offset > 0 ? Math.floor(o.offset) : 0,
        };
      },
    }),

    // ---- site furniture: widget areas ----------------------------------------

    /** One widget area, with `menu` widgets resolved to their menus. PUBLIC.
     *
     * `null` for an unknown name, for the same reason `getMenu` returns null: a layout
     * asking for a sidebar nobody has filled in yet is the normal state of a site under
     * construction, and throwing there takes down the page. */
    getWidgetArea: query(async (ctx, input: { name: string }): Promise<WidgetArea | null> => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_widget_areas", where: { name: input.name }, limit: 1 });
      const row = rows[0];
      if (!row) return null;
      const widgets = Array.isArray(row.widgets) ? (row.widgets as Widget[]) : [];
      // Resolved inline so a layout renders a whole sidebar from ONE call. A menu widget
      // that names a menu which no longer exists keeps `menu: null` rather than being
      // dropped — unlike a menu ITEM, an empty widget is a visible hole an editor can see
      // and fix, where a silently missing one is not.
      const names = [...new Set(widgets.filter((w) => w.type === "menu" && w.menuName).map((w) => w.menuName!))];
      const menus = new Map<string, Menu>();
      if (names.length > 0) {
        const found = await db.find({ from: "cms_menus", where: { name: { in: names } }, limit: names.length });
        // RESOLVED, exactly as `getMenu` returns it. Embedding the raw row here served an
        // unpublished page's label and id to anonymous callers and handed the layout an
        // item with no `url` — the two things the resolver exists to prevent, skipped
        // because this path had its own one-line copy of "read the menu".
        for (const m of found) menus.set(String(m.name), await resolveMenuRow(db, m));
      }
      return {
        id: String(row.id),
        name: String(row.name),
        label: String(row.label),
        description: row.description == null ? null : String(row.description),
        widgets: widgets.map((w) => (w.type === "menu" && w.menuName ? { ...w, menu: menus.get(w.menuName) ?? null } : w)),
      };
    }, {
      input: (raw): { name: string } => ({ name: assertKey(asObj(raw).name, "widget area name") }),
    }),

    listWidgetAreas: query((ctx) => cdb(ctx).find({ from: "cms_widget_areas", orderBy: { column: "label" }, limit: PAGE_LIST_MAX_LIMIT }), viewer),

    createWidgetArea: mutation(async (ctx, input: { name: string; label: string; description?: string; widgets?: Widget[] }) => {
      const db = cdb(ctx);
      const clash = await db.find({ from: "cms_widget_areas", where: { name: input.name }, select: ["id"], limit: 1 });
      if (clash[0]) throw new Conflict(`widget area '${input.name}' already exists`);
      return db.insert("cms_widget_areas", {
        name: input.name,
        label: input.label,
        description: input.description ?? null,
        widgets: input.widgets ?? [],
      });
    }, {
      ...editor,
      input: (raw): { name: string; label: string; description?: string; widgets?: Widget[] } => {
        const o = asObj(raw);
        return {
          name: assertKey(o.name, "widget area name"),
          label: assertLabel(o.label, "widget area label"),
          description: typeof o.description === "string" ? o.description : undefined,
          widgets: normalizeWidgets(o.widgets, rtSchema),
        };
      },
    }),

    updateWidgetArea: mutation(async (ctx, input: { id?: string; name?: string; label?: string; description?: string | null; widgets?: Widget[]; expectedVersion?: number }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_widget_areas", where: input.id ? { id: input.id } : { name: input.name }, limit: 1 });
      const row = rows[0];
      if (!row) throw notFound("widget area");
      const patch: Record<string, unknown> = { updatedAt: nowStamp(), version: nextVersion(row, input.expectedVersion, "this widget area") };
      for (const k of ["label", "description", "widgets"] as const) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      return db.update("cms_widget_areas", String(row.id), patch);
    }, {
      ...editor,
      input: (raw): { id?: string; name?: string; label?: string; description?: string | null; widgets?: Widget[]; expectedVersion?: number } => {
        const o = asObj(raw);
        const out: { id?: string; name?: string; label?: string; description?: string | null; widgets?: Widget[]; expectedVersion?: number } = {};
        if (typeof o.id === "string") out.id = o.id;
        else if (typeof o.name === "string") out.name = assertKey(o.name, "widget area name");
        else throw new BadRequest("id or name is required");
        if (o.label !== undefined) out.label = assertLabel(o.label, "widget area label");
        if (o.description !== undefined) out.description = typeof o.description === "string" ? o.description : null;
        if (o.widgets !== undefined) out.widgets = normalizeWidgets(o.widgets, rtSchema);
        if (typeof o.expectedVersion === "number") out.expectedVersion = o.expectedVersion;
        return out;
      },
    }),

    deleteWidgetArea: mutation(async (ctx, input: { id: string }) => {
      const ok = await cdb(ctx).delete("cms_widget_areas", input.id);
      if (!ok) throw notFound("widget area");
      return { ok: true as const };
    }, {
      ...editor,
      input: (raw): { id: string } => {
        const id = asObj(raw).id;
        if (typeof id !== "string" || id === "") throw new BadRequest("id is required");
        return { id };
      },
    }),

    // ---- media library ----
    /** Mint a signed upload URL for a media blob (keyed under the tenant's `media/`
     * prefix so the public /media route can serve it). The client PUTs the bytes to
     * `url`, then calls `createMedia` with the returned `ref`. */
    signMediaUpload: mutation((ctx, input: { contentType: string; filename?: string }) => {
      return ctx.files.signUpload({ contentType: input.contentType, filename: input.filename, prefix: "media", maxSize: mediaMaxSize });
    }, {
      ...editor,
      input: (raw): { contentType: string; filename?: string } => {
        const o = asObj(raw);
        if (typeof o.contentType !== "string") throw new BadRequest("contentType is required");
        return { contentType: o.contentType, filename: typeof o.filename === "string" ? o.filename : undefined };
      },
    }),

    /** Confirm an uploaded blob is really in storage (capturing its true size) and
     * persist a `cms_media` row. Mirrors the notes attach flow. */
    createMedia: mutation(async (ctx, input: { ref: FileRef; alt?: string }) => {
      const head = await ctx.files.head(input.ref.key);
      if (!head) throw new BadRequest("uploaded file not found in storage");
      const file: FileRef = {
        key: input.ref.key,
        size: head.size,
        contentType: head.contentType ?? input.ref.contentType,
        filename: input.ref.filename,
        uploadedAt: Date.now(),
      };
      return cdb(ctx).insert("cms_media", { file, alt: input.alt ?? null });
    }, {
      ...editor,
      input: (raw): { ref: FileRef; alt?: string } => {
        const o = asObj(raw);
        const ref = asObj(o.ref);
        if (typeof ref.key !== "string") throw new BadRequest("ref.key is required");
        return {
          ref: {
            key: ref.key,
            size: typeof ref.size === "number" ? ref.size : 0,
            contentType: typeof ref.contentType === "string" ? ref.contentType : "application/octet-stream",
            filename: typeof ref.filename === "string" ? ref.filename : undefined,
          },
          alt: typeof o.alt === "string" ? o.alt : undefined,
        };
      },
    }),

    listMedia: query((ctx, input: { limit?: number; offset?: number }) => {
      const limit = Math.min(Math.max(Math.trunc(Number(input?.limit ?? 50)) || 50, 1), 200);
      const offset = Math.max(Math.trunc(Number(input?.offset ?? 0)) || 0, 0);
      return cdb(ctx).find({ from: "cms_media", orderBy: { column: "createdAt", dir: "desc" }, limit, offset });
    }, viewer),

    getMedia: query(async (ctx, input: { id: string }) => {
      const rows = await cdb(ctx).find({ from: "cms_media", where: { id: input.id }, limit: 1 });
      return rows[0] ?? null;
    }, {
      ...viewer,
      input: (raw): { id: string } => {
        const o = asObj(raw);
        if (typeof o.id !== "string") throw new BadRequest("id is required");
        return o as never;
      },
    }),

    /** Edit a media asset's metadata (currently just `alt` text). Editor-gated. */
    updateMedia: mutation(async (ctx, input: { id: string; alt: string | null }) => {
      const updated = await cdb(ctx).update("cms_media", input.id, { alt: input.alt ?? null });
      if (!updated) throw notFound("media");
      return updated;
    }, {
      ...editor,
      input: (raw): { id: string; alt: string | null } => {
        const o = asObj(raw);
        if (typeof o.id !== "string") throw new BadRequest("id is required");
        return { id: o.id, alt: typeof o.alt === "string" ? o.alt : null };
      },
    }),

    /** Trash a media row. The R2 OBJECT IS KEPT — deleting the bytes here would make
     * `restoreMedia` a lie, and a block still referencing the id would render a dead url
     * with no way back. `purgeMedia` is what drops both — and `listTrash` is how you find
     * the id again, since every ACL-scoped read hides it from here on.
     *
     * (Automatic orphan sweeping — media no longer referenced by any block — is still
     * future work; refs live inside opaque block JSON.) */
    deleteMedia: mutation(async (ctx, input: { id: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_media", where: { id: input.id }, limit: 1 });
      const media = rows[0];
      if (!media) throw notFound("media");
      await db.update("cms_media", input.id, { deletedAt: new Date().toISOString() });
      return { ok: true };
    }, {
      ...editor,
      input: (raw): { id: string } => {
        const o = asObj(raw);
        if (typeof o.id !== "string") throw new BadRequest("id is required");
        return o as never;
      },
    }),

    restoreMedia: mutation(async (ctx, input: { id: string }) => {
      const db = cdb(ctx);
      const rows = await db.exec("SELECT id FROM cms_media WHERE id = ? AND deletedAt IS NOT NULL LIMIT 1", input.id);
      if (!rows[0]) throw notFound("trashed media");
      await db.exec("UPDATE cms_media SET deletedAt = NULL WHERE id = ?", input.id);
      markChanged(db, "cms_media");
      return { ok: true as const };
    }, { ...editor, ...mediaIdInput }),

    /** Permanently remove trashed media — the row AND the R2 object. Reviewer-gated and
     * irreversible; the blob is gone. */
    purgeMedia: mutation(async (ctx, input: { id: string }) => {
      const db = cdb(ctx);
      const rows = await db.exec("SELECT id, file FROM cms_media WHERE id = ? AND deletedAt IS NOT NULL LIMIT 1", input.id);
      const media = rows[0];
      if (!media) throw notFound("trashed media"); // purging live media is refused — trash it first
      // `file` comes back raw from exec (the object↔JSON codec sits on the ORM path, not
      // this one), so parse it before reaching for the key.
      const file = typeof media.file === "string" ? (JSON.parse(media.file) as { key?: string }) : asObj(media.file);
      const key = String(file.key ?? "");
      await db.exec("DELETE FROM cms_media WHERE id = ?", input.id);
      markChanged(db, "cms_media");
      if (key) await ctx.files.delete(key).catch(() => {});
      return { ok: true as const };
    }, { ...reviewer, ...mediaIdInput }),

    listContentTypes: query((ctx) => cdb(ctx).find({ from: "cms_content_types", orderBy: { column: "name" } }), viewer),

    /** Content-type slugs + names, PUBLIC. The editor-facing `listContentTypes` above is
     * viewer-gated, which a BUILD cannot satisfy: `@pramen/cms-astro`'s `collections: "auto"`
     * runs in `astro:config:setup`, where there is no editor session and shipping a token to
     * CI just to list type names would be the wrong trade.
     *
     * Nothing new is exposed. `cmsPolicies().public` already grants anonymous read of
     * `cms_content_types` ("slugs/names are structural, not sensitive"), and
     * `listPublishedPages` already returns the content-type slug of every published page.
     * The projection is deliberately narrow — slug and name only, never the regions or
     * field schema, which describe the editing surface rather than the published site. */
    listPublicContentTypes: query(async (ctx) => {
      const rows = await cdb(ctx).find({ from: "cms_content_types", orderBy: { column: "name" } });
      return rows.map((r) => ({ slug: String(r.slug), name: String(r.name ?? r.slug) }));
    }),

    getContentType: query(async (ctx, input: { id: string }) => {
      const rows = await cdb(ctx).find({ from: "cms_content_types", where: { id: input.id }, limit: 1 });
      return rows[0] ?? null;
    }, {
      ...viewer,
      input: (raw): { id: string } => {
        const o = asObj(raw);
        if (typeof o.id !== "string") throw new BadRequest("id is required");
        return o as never;
      },
    }),

    // ---- pages ----
    /** List pages, newest first. Viewer-gated: the rows are FULL page records (schedule
     * timestamps, revision pointer, the whole `fields` bag, every SEO column), which is the
     * editing surface, not the published one — `listPublishedPages` is this file's deliberate
     * public projection and stays narrow.
     *
     * `contentType` (a content-type SLUG) narrows the list to one type — what an editor that
     * gives each type its own tab needs, and the only way to stay correct once a deployment
     * has more than `limit` entries in total: filtering the full list client-side would
     * silently drop the tail of every type. Omitted ⇒ all types, the historical behaviour. An
     * unknown slug returns nothing rather than everything, so a typo can never read as "here
     * is the whole CMS" — and neither can an EMPTY one, which is why the check below is
     * `=== undefined` and not a falsy test.
     *
     * `limit`/`offset` page the list. Without them the caller cannot tell a full first page
     * from the whole table, and the editor's header reports the cap as if it were the total.
     * `select` narrows the projection: a list screen needs five columns, not the widest row
     * in the CMS, and on the D1 store every unasked-for column crosses RPC. */
    listPages: query(
      async (ctx, input: { contentType?: string; limit?: number; offset?: number; select?: string[] }) => {
        // ONE query, not two: `where` traverses the `type` belongsTo the schema already
        // declares, so the slug is resolved by a subquery. That also gives the unknown-slug
        // invariant for free (an empty subquery matches nothing) and, unlike a hand-rolled
        // lookup in cms_content_types, does not THROW for a policy set that grants cms_pages
        // but not the types table.
        const where = input?.contentType === undefined ? undefined : { type: { slug: input.contentType } };
        return cdb(ctx).find({
          from: "cms_pages",
          where,
          orderBy: { column: "createdAt", dir: "desc" },
          limit: Math.min(input?.limit ?? PAGE_LIST_LIMIT, PAGE_LIST_MAX_LIMIT),
          offset: input?.offset ?? 0,
          select: input?.select,
        });
      },
      {
        ...viewer,
        // The parsed value is what the ACL sees (`dispatch` hands it to `Db` for `$input()`
        // resolution), so this SPREADS the raw object rather than rebuilding one from the
        // keys it knows: a host scoping cms_pages with `$input("someKey")` had its marker
        // resolving against `{}` — the scope collapsing to nothing — the moment this handler
        // grew a parser.
        input: (raw): { contentType?: string; limit?: number; offset?: number; select?: string[] } => {
          const o = asObj(raw);
          const out: Record<string, unknown> = { ...o };
          if (o.contentType === undefined || o.contentType === null) delete out.contentType;
          else if (typeof o.contentType !== "string") throw new BadRequest("contentType must be a string");
          for (const k of ["limit", "offset"] as const) {
            if (o[k] === undefined || o[k] === null) { delete out[k]; continue; }
            if (typeof o[k] !== "number" || !Number.isInteger(o[k]) || (o[k] as number) < 0) throw new BadRequest(`${k} must be a non-negative integer`);
          }
          if (o.select === undefined || o.select === null) delete out.select;
          else if (!Array.isArray(o.select) || o.select.some((c) => typeof c !== "string")) throw new BadRequest("select must be an array of column names");
          return out as never;
        },
      },
    ),

    /** One page by id, for the editor opening `/pages/:id` directly. Resolving that id
     * against `listPages` instead means a deep link (or a row clicked in a type's own tab)
     * can miss: that list is capped and, since the editor lists per type, is not even the
     * list the row came from. Viewer-gated + row-ACL'd like every other read. */
    getPageById: query(async (ctx, input: { pageId: string }) => {
      const rows = await cdb(ctx).find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      return rows[0] ?? null;
    }, { ...viewer, ...pageIdInput }),

    /** Public: list published pages (slug, locale, updatedAt) for sitemap generation. The
     * anonymous ACL scopes cms_pages reads to status=published, so this is safe to expose.
     *
     * `contentType` / `locale` narrow the list HERE, for the same reason `listPages` does:
     * the result is capped, so a caller filtering it afterwards is filtering an already
     * truncated list and loses the tail of every type. `@pramen/cms-astro`'s `collections:
     * "auto"` builds one collection per content type, each calling this — un-narrowed, all
     * of them fetch the same 5000 rows and everything past the cap vanishes from the built
     * site with a green build. An unknown slug returns nothing, never everything. */
    listPublishedPages: query(async (ctx, input: { contentType?: string; locale?: string }) => {
      const db = cdb(ctx);
      const where: Record<string, unknown> = { status: "published" };
      if (input?.contentType !== undefined) where.type = { slug: input.contentType };
      if (input?.locale !== undefined) where.locale = input.locale;
      const rows = await db.find({ from: "cms_pages", where, orderBy: { column: "updatedAt", dir: "desc" }, limit: 5000 });
      // Join typeId → content-type slug so a frontend can route/filter by type (e.g. articles
      // vs pages) without a second round-trip.
      const typeIds = [...new Set(rows.map((r) => r.typeId).filter((v): v is string => typeof v === "string"))];
      const types = typeIds.length ? await db.find({ from: "cms_content_types", where: { id: { in: typeIds } } }) : [];
      const slugById = new Map(types.map((t) => [String(t.id), String(t.slug)]));
      return rows.map((r) => ({ slug: String(r.slug), locale: String(r.locale ?? "en"), contentType: slugById.get(String(r.typeId)) ?? null, updatedAt: String(r.updatedAt ?? r.createdAt ?? "") }));
    }, {
      // Spreads the raw object for the same reason `listPages` does — the parsed value is
      // what `$input()` policy markers resolve against.
      input: (raw): { contentType?: string; locale?: string } => {
        const o = asObj(raw);
        const out: Record<string, unknown> = { ...o };
        for (const k of ["contentType", "locale"] as const) {
          if (o[k] === undefined || o[k] === null) { delete out[k]; continue; }
          if (typeof o[k] !== "string") throw new BadRequest(`${k} must be a string`);
        }
        return out as never;
      },
    }),

    /** Update a page's SEO fields (meta/canonical/robots/OpenGraph/JSON-LD). Editor-gated. */
    updatePageSeo: mutation(async (ctx, input: { pageId: string; metaTitle?: string | null; metaDescription?: string | null; canonicalUrl?: string | null; robots?: string | null; ogTitle?: string | null; ogDescription?: string | null; ogImage?: string | null; structuredData?: unknown; expectedVersion?: number }) => {
      const db = cdb(ctx);
      // Read first so the version can be compared; this patched blind before.
      const seoRows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      if (!seoRows[0]) throw notFound("page");
      const patch: Record<string, unknown> = { updatedAt: nowStamp(), version: nextVersion(seoRows[0], input.expectedVersion, "this page") };
      for (const k of ["metaTitle", "metaDescription", "canonicalUrl", "robots", "ogTitle", "ogDescription", "ogImage"] as const) {
        if (k in input) patch[k] = (input as Record<string, unknown>)[k];
      }
      if ("structuredData" in input) patch.structuredData = input.structuredData ?? null;
      const updated = await db.update("cms_pages", input.pageId, patch);
      if (!updated) throw notFound("page");
      return { ok: true, page: updated };
    }, {
      ...editor,
      input: (raw): { pageId: string } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string") throw new BadRequest("pageId is required");
        versionInput(o);
        return o as never;
      },
    }),

    /** Edit a page's own attributes — title, slug, locale, and content-type-level `fields`
     * (the structured data of a non-block content type, e.g. a "Lecture" with date/speaker).
     * Blocks are edited via addBlock/updateBlock; SEO via updatePageSeo; this covers the
     * page record itself, which was previously only settable at createPage. A slug/locale
     * change re-checks (slug, locale) uniqueness (excluding this page); `fields` is validated
     * + normalized against the content type's fieldsSchema, exactly like createPage. */
    updatePage: mutation(async (ctx, input: { pageId: string; title?: string; slug?: string; locale?: string; fields?: FieldValues; expectedVersion?: number }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const page = rows[0];
      if (!page) throw notFound("page");
      const patch: Record<string, unknown> = { updatedAt: nowStamp(), version: nextVersion(page, input.expectedVersion, "this page") };
      if (input.title !== undefined) patch.title = input.title;
      if (input.slug !== undefined || input.locale !== undefined) {
        const nextSlug = input.slug ?? String(page.slug);
        const nextLocale = input.locale ?? String(page.locale);
        await assertSlugFree(db, nextSlug, nextLocale, String(page.id));
        if (input.slug !== undefined) patch.slug = input.slug;
        if (input.locale !== undefined) patch.locale = input.locale;
      }
      if (input.fields !== undefined) {
        const ctRows = await db.find({ from: "cms_content_types", where: { id: page.typeId }, limit: 1 });
        const schema = ctRows[0]?.fieldsSchema as FieldDefinition[] | undefined;
        // Same whole-bag autosave as updateBlock — tolerate a stored legacy value.
        validateFields(schema, input.fields, "page.fields", { requireRequired: false, legacyBaseline: asObj(page.fields) as FieldValues });
        patch.fields = normalizeFields(schema, input.fields, rtSchema);
      }
      const updated = await db.update("cms_pages", input.pageId, patch);
      if (!updated) throw notFound("page");
      return { ok: true, page: updated };
    }, {
      ...editor,
      input: (raw): { pageId: string; title?: string; slug?: string; locale?: string; fields?: FieldValues; expectedVersion?: number } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string") throw new BadRequest("pageId is required");
        for (const k of ["title", "slug", "locale"] as const) {
          if (o[k] !== undefined && typeof o[k] !== "string") throw new BadRequest(`${k} must be a string`);
        }
        versionInput(o);
        return o as never;
      },
    }),

    /** Create a page and auto-scaffold its content type's default blocks. */
    createPage: mutation(async (ctx, input: { typeId: string; title: string; slug: string; locale?: string; fields?: FieldValues }) => {
      const db = cdb(ctx);
      const ctRows = await db.find({ from: "cms_content_types", where: { id: input.typeId }, limit: 1 });
      const ct = ctRows[0];
      if (!ct) throw new BadRequest("unknown content type");
      validateFields(ct.fieldsSchema as FieldDefinition[] | undefined, input.fields ?? {}, "page.fields", { requireRequired: false });
      const cleanPageFields = normalizeFields(ct.fieldsSchema as FieldDefinition[] | undefined, input.fields ?? {}, rtSchema);
      const locale = input.locale ?? defaultLocale;
      await assertSlugFree(db, input.slug, locale);

      const page = await db.insert("cms_pages", {
        typeId: input.typeId,
        title: input.title,
        slug: input.slug,
        locale,
        fields: cleanPageFields,
        status: "draft",
      });

      const defaults = (ct.defaultBlocks as DefaultBlockDefinition[] | undefined) ?? [];
      for (const d of defaults) {
        // A default block must pass the SAME guards as addBlock — a known type, an
        // allowed region, and schema-valid fields — or the page would be scaffolded with
        // an invalid/disallowed block that later renders on the published snapshot. A
        // misconfigured default is skipped with a warning rather than aborting the page.
        try {
          const bts = await db.find({ from: "cms_block_types", where: { slug: d.blockTypeSlug }, limit: 1 });
          if (!bts[0]) throw new BadRequest(`unknown block type '${d.blockTypeSlug}'`);
          await assertRegionAllows(db, page, d.region, d.blockTypeSlug);
          validateFields(bts[0].fieldsSchema as FieldDefinition[] | undefined, d.fields ?? {}, "", { requireRequired: false });
          const cleanDefault = normalizeFields(bts[0].fieldsSchema as FieldDefinition[] | undefined, d.fields ?? {}, rtSchema);
          const block = await db.insert("cms_blocks", { typeId: bts[0].id, fields: cleanDefault });
          const position = await nextPosition(db, String(page.id), d.region);
          await db.insert("cms_page_blocks", { pageId: page.id, blockId: block.id, region: d.region, position });
        } catch (e) {
          console.warn(`@pramen/cms: content type '${ct.slug}' default block (${d.blockTypeSlug} → ${d.region}) skipped: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return page;
    }, {
      ...editor,
      input: (raw): { typeId: string; title: string; slug: string; locale?: string; fields?: FieldValues } => {
        const o = asObj(raw);
        if (typeof o.typeId !== "string" || typeof o.title !== "string" || typeof o.slug !== "string") {
          throw new BadRequest("typeId, title and slug are required");
        }
        if (o.locale !== undefined && typeof o.locale !== "string") throw new BadRequest("locale must be a string");
        return o as never;
      },
    }),

    /** Create a translation of an existing page: a new page in `locale` sharing the
     * source's translationGroupId (and content type). Content starts empty — the editor
     * fills in the translated blocks. Slug defaults to the source's (allowed in a new locale). */
    createTranslation: mutation(async (ctx, input: { pageId: string; locale: string; title?: string; slug?: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const src = rows[0];
      if (!src) throw notFound("page");
      if (String(src.locale) === input.locale) throw new BadRequest("page is already in that locale");
      // A legacy page (migrated in before this column existed) has a NULL group — a NULL
      // match would collapse ALL legacy pages together. Backfill the source with its own
      // group first, so this translation joins only it.
      let group = src.translationGroupId;
      if (typeof group !== "string" || !group) {
        group = crypto.randomUUID();
        await db.update("cms_pages", String(src.id), { translationGroupId: group });
      }
      // Raw exec, like assertSlugFree: a check-then-act uniqueness guard must see TRASHED
      // rows too. Through ctx.db the read scope hides them, so trashing a `cs` translation
      // let a second one be created, and restoring the first left two live `cs` pages in
      // one group — two <link rel="alternate" hreflang="cs"> on every sibling.
      const existing = await db.exec(
        "SELECT id, deletedAt FROM cms_pages WHERE translationGroupId = ? AND locale = ? LIMIT 1",
        group,
        input.locale,
      );
      if (existing[0]) {
        throw new BadRequest(
          existing[0].deletedAt != null
            ? `a '${input.locale}' translation exists in the trash — restore or purge it first`
            : `a '${input.locale}' translation already exists`,
        );
      }
      const slug = input.slug ?? String(src.slug);
      await assertSlugFree(db, slug, input.locale);
      return db.insert("cms_pages", {
        typeId: src.typeId,
        title: input.title ?? String(src.title),
        slug,
        locale: input.locale,
        translationGroupId: group,
        fields: {},
        status: "draft",
      });
    }, {
      ...editor,
      input: (raw): { pageId: string; locale: string; title?: string; slug?: string } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string" || typeof o.locale !== "string") throw new BadRequest("pageId and locale are required");
        return o as never;
      },
    }),

    /** List all locales of a page (the translation group), including the page itself. */
    listTranslations: query(async (ctx, input: { pageId: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const self = rows[0];
      if (!self) throw notFound("page");
      const proj = (r: Record<string, unknown>) => ({ id: String(r.id), locale: String(r.locale ?? "en"), slug: String(r.slug), title: String(r.title), status: String(r.status) });
      // A NULL group (legacy page) matches all legacy pages — guard it and return just self.
      if (typeof self.translationGroupId !== "string" || !self.translationGroupId) return [proj(self)];
      const group = await db.find({ from: "cms_pages", where: { translationGroupId: self.translationGroupId } });
      return group.map(proj);
    }, {
      ...viewer,
      input: (raw): { pageId: string } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string") throw new BadRequest("pageId is required");
        return o as never;
      },
    }),

    /** What this deployment supports, for an editor to render against — the pages-side
     * counterpart to `listCollections`' `supports: [...]`.
     *
     * The editor asks the SERVER what exists rather than being told by its own /config.js:
     * a client flag can hide a control but cannot make the data right, and the two drift
     * the moment someone adds a locale. `multilingual` is the derived answer to the only
     * question the UI actually asks, so each surface doesn't re-derive it from the list. */
    /** What this deployment supports. `pagesByType` is the editor's licence to give each
     * content type its own tab and its own list: an OLDER server ignores the `contentType`
     * argument entirely and answers with the pooled list, so an editor that assumed the
     * feature would render N tabs all showing every type's pages under a heading claiming
     * otherwise — and "New page" from any of them would stamp that tab's type. Declared, not
     * inferred: fail closed on the pooled list rather than open on N lying ones. */
    listCmsCapabilities: query((ctx) => ({
      locales,
      defaultLocale,
      multilingual: locales.length > 1,
      pagesByType: true as const,
      // Same kind of declaration as `pagesByType`, for the same reason: an OLDER server has
      // no menu/redirect/taxonomy/widget handlers at all, and a nav section whose every
      // screen 404s is worse than one that is absent. Fails closed by being absent there.
      siteFurniture: true as const,
      // PER-CALLER, unlike everything else here. `viewer` is `editorRoles ∪ reviewerRoles`,
      // so a reviewer-only session reaches this handler and every read handler — but every
      // WRITE is `editorRoles`. Without this the editor renders the authoring surfaces
      // (Types, Menus, Redirects, …) for a reviewer and each one 403s on its first save.
      // The editor cannot work it out for itself: it knows the caller's roles from `me` but
      // not which roles this deployment configured as `editorRoles`.
      canEdit: isEditor(ctx, editorRoles),
    }), viewer),

    /** Distinct locales present across all pages. NOTE: a DATA query — what is in the
     * store — not configuration. `listCmsCapabilities().locales` is what the deployment
     * declares; these two differ while a locale is declared but not yet authored. */
    listLocales: query(async (ctx) => {
      // Raw exec bypasses the ACL, so the trash filter has to be written out by hand —
      // otherwise the editor's locale switcher offers a locale with zero live pages.
      const rows = await cdb(ctx).exec("SELECT DISTINCT locale FROM cms_pages WHERE deletedAt IS NULL ORDER BY locale");
      return rows.map((r) => String(r.locale ?? "en"));
    }, viewer),

    // ---- blocks & placement ----
    /** Create a block instance and place it into a page region in one call (the common
     * editor action). Validates the fields against the block type's schema and the region
     * against the content type's allow-list. */
    addBlock: mutation(async (ctx, input: { pageId: string; blockTypeSlug: string; region: string; fields?: FieldValues; title?: string; position?: number; isReusable?: boolean }) => {
      const db = cdb(ctx);
      const pages = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const page = pages[0];
      if (!page) throw notFound("page");
      const bt = await loadBlockTypeBySlug(db, input.blockTypeSlug);
      await assertRegionAllows(db, page, input.region, input.blockTypeSlug);
      validateFields(bt.fieldsSchema as FieldDefinition[] | undefined, input.fields ?? {}, "", { requireRequired: false });
      const cleanFields = normalizeFields(bt.fieldsSchema as FieldDefinition[] | undefined, input.fields ?? {}, rtSchema);

      const block = await db.insert("cms_blocks", {
        typeId: bt.id,
        title: input.title ?? null,
        fields: cleanFields,
        isReusable: input.isReusable ?? false,
      });
      const position = input.position ?? (await nextPosition(db, input.pageId, input.region));
      const placement = await db.insert("cms_page_blocks", {
        pageId: input.pageId,
        blockId: block.id,
        region: input.region,
        position,
        isShared: input.isReusable ?? false,
      });
      return { block, placement };
    }, {
      ...editor,
      input: (raw): { pageId: string; blockTypeSlug: string; region: string; fields?: FieldValues; title?: string; position?: number; isReusable?: boolean } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string" || typeof o.blockTypeSlug !== "string" || typeof o.region !== "string") {
          throw new BadRequest("pageId, blockTypeSlug and region are required");
        }
        return o as never;
      },
    }),

    /** Place an EXISTING (typically reusable) block into a page region as a SHARED
     * placement, with optional per-placement `overrides` merged over the block's fields at
     * read time. This is the "edit once, appear on many pages" workflow — the same block id
     * can be placed on several pages; editing it updates them all, while `overrides` let one
     * placement diverge. The merged (base + overrides) result is validated against the
     * block type's field schema. */
    placeBlock: mutation(async (ctx, input: { pageId: string; blockId: string; region: string; position?: number; overrides?: FieldValues }) => {
      const db = cdb(ctx);
      const pages = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const page = pages[0];
      if (!page) throw notFound("page");
      const blocks = await db.find({ from: "cms_blocks", where: { id: input.blockId }, limit: 1 });
      const block = blocks[0];
      if (!block) throw notFound("block");
      const bts = await db.find({ from: "cms_block_types", where: { id: block.typeId }, limit: 1 });
      const slug = String(bts[0]?.slug ?? "");
      await assertRegionAllows(db, page, input.region, slug);
      let cleanOverrides: Record<string, unknown> | null = input.overrides ?? null;
      if (input.overrides !== undefined) {
        // The merged bag includes the block's OWN stored fields, which may predate Portable
        // Text. Tolerate a legacy string there so an untouched legacy block can still be
        // placed; the overrides themselves are new input and stay strict below.
        validateFields(bts[0]?.fieldsSchema as FieldDefinition[] | undefined, { ...asObj(block.fields), ...input.overrides }, "", { requireRequired: false, legacyBaseline: asObj(block.fields) as FieldValues });
        validateFields(bts[0]?.fieldsSchema as FieldDefinition[] | undefined, input.overrides, "", { requireRequired: false });
        cleanOverrides = normalizeFields(bts[0]?.fieldsSchema as FieldDefinition[] | undefined, input.overrides, rtSchema);
      }
      const position = input.position ?? (await nextPosition(db, input.pageId, input.region));
      return db.insert("cms_page_blocks", {
        pageId: input.pageId,
        blockId: input.blockId,
        region: input.region,
        position,
        isShared: true,
        overrides: cleanOverrides,
      });
    }, {
      ...editor,
      input: (raw): { pageId: string; blockId: string; region: string; position?: number; overrides?: FieldValues } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string" || typeof o.blockId !== "string" || typeof o.region !== "string") {
          throw new BadRequest("pageId, blockId and region are required");
        }
        return o as never;
      },
    }),

    /** Fetch a block's RAW content (media fields as ids, not resolved) — for editing. */
    getBlock: query(async (ctx, input: { blockId: string }) => {
      const rows = await cdb(ctx).find({ from: "cms_blocks", where: { id: input.blockId }, limit: 1 });
      return rows[0] ?? null;
    }, {
      ...viewer,
      input: (raw): { blockId: string } => {
        const o = asObj(raw);
        if (typeof o.blockId !== "string") throw new BadRequest("blockId is required");
        return o as never;
      },
    }),

    /** Update a block's content (re-validated against its type's field schema). */
    updateBlock: mutation(async (ctx, input: { blockId: string; fields?: FieldValues; title?: string; expectedVersion?: number }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_blocks", where: { id: input.blockId }, limit: 1 });
      const block = rows[0];
      if (!block) throw notFound("block");
      // Conflict first, like updatePage: a stale write carrying invalid fields should say
      // "someone else changed this", not 400 on content the caller is about to discard.
      const blockVersion = nextVersion(block, input.expectedVersion, "this block");
      let cleanFields = input.fields;
      if (input.fields !== undefined) {
        const bt = await db.find({ from: "cms_block_types", where: { id: block.typeId }, limit: 1 });
        // The editor autosaves the WHOLE fields bag ~800ms after any edit, so a legacy
        // richtext value the author never touched rides along with an unrelated change.
        // Rejecting it would 400 on every keystroke and make the block unsaveable.
        validateFields(bt[0]?.fieldsSchema as FieldDefinition[] | undefined, input.fields, "", { requireRequired: false, legacyBaseline: asObj(block.fields) as FieldValues });
        cleanFields = normalizeFields(bt[0]?.fieldsSchema as FieldDefinition[] | undefined, input.fields, rtSchema);
      }
      const patch: Record<string, unknown> = { updatedAt: nowStamp(), version: blockVersion };
      if (cleanFields !== undefined) patch.fields = cleanFields;
      if (input.title !== undefined) patch.title = input.title;
      return db.update("cms_blocks", input.blockId, patch);
    }, {
      ...editor,
      input: (raw): { blockId: string; fields?: FieldValues; title?: string; expectedVersion?: number } => {
        const o = asObj(raw);
        if (typeof o.blockId !== "string") throw new BadRequest("blockId is required");
        versionInput(o);
        return o as never;
      },
    }),

    /** Reorder a region: `order` is the page_block ids in their new order. It must cover
     * EXACTLY the region's current placements (same set, no dups) — otherwise a partial or
     * stale list would leave untouched placements colliding at a shared position. */
    reorderRegion: mutation(async (ctx, input: { pageId: string; region: string; order: string[] }) => {
      const db = cdb(ctx);
      const current = await db.find({ from: "cms_page_blocks", where: { pageId: input.pageId, region: input.region } });
      const currentIds = new Set(current.map((p) => String(p.id)));
      const orderSet = new Set(input.order.map(String));
      if (orderSet.size !== input.order.length) throw new BadRequest("order contains duplicate ids");
      if (orderSet.size !== currentIds.size || ![...orderSet].every((id) => currentIds.has(id))) {
        throw new BadRequest("order must list exactly this region's placements");
      }
      for (let i = 0; i < input.order.length; i++) {
        await db.exec("UPDATE cms_page_blocks SET position = ? WHERE id = ? AND pageId = ? AND region = ?", i, input.order[i], input.pageId, input.region);
      }
      return { ok: true, count: input.order.length };
    }, {
      ...editor,
      input: (raw): { pageId: string; region: string; order: string[] } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string" || typeof o.region !== "string" || !Array.isArray(o.order)) {
          throw new BadRequest("pageId, region and order[] are required");
        }
        if (!o.order.every((id) => typeof id === "string")) throw new BadRequest("order must be string ids");
        return o as never;
      },
    }),

    /** Remove a placement. A reusable/shared block stays in the library (it may be placed
     * elsewhere); a non-reusable block with no remaining placements is deleted too, so
     * add/remove churn doesn't accumulate unreachable block rows. */
    removeBlock: mutation(async (ctx, input: { pageBlockId: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_page_blocks", where: { id: input.pageBlockId }, limit: 1 });
      const placement = rows[0];
      if (!placement) throw notFound("placement");
      await db.delete("cms_page_blocks", input.pageBlockId);
      const blockId = String(placement.blockId);
      const stillUsed = await db.find({ from: "cms_page_blocks", where: { blockId }, limit: 1 });
      if (stillUsed.length === 0) {
        const blk = await db.find({ from: "cms_blocks", where: { id: blockId }, limit: 1 });
        if (blk[0] && !blk[0].isReusable) await db.delete("cms_blocks", blockId);
      }
      return { ok: true };
    }, {
      ...editor,
      input: (raw): { pageBlockId: string } => {
        const o = asObj(raw);
        if (typeof o.pageBlockId !== "string") throw new BadRequest("pageBlockId is required");
        return o as never;
      },
    }),

    // ---- editorial workflow ----
    /** Move a draft (or rejected) page into review. Editor-gated. */
    submitForReview: mutation(async (ctx, input: { pageId: string; note?: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const page = rows[0];
      if (!page) throw notFound("page");
      const from = String(page.status);
      if (from !== "draft" && from !== "rejected") throw new BadRequest(`cannot submit a '${from}' page for review`);
      const updated = await db.update("cms_pages", input.pageId, { status: "review", updatedAt: nowStamp() });
      await writeAudit(db, { pageId: input.pageId, action: "submit", from, to: "review", actor: actorOf(ctx), note: input.note });
      return { ok: true, page: updated };
    }, {
      ...editor,
      input: (raw): { pageId: string; note?: string } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string") throw new BadRequest("pageId is required");
        return o as never;
      },
    }),

    /** Approve a page in review → publish it (snapshot + currentRevisionId). Reviewer-gated. */
    approve: mutation(async (ctx, input: { pageId: string; note?: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const page = rows[0];
      if (!page) throw notFound("page");
      if (String(page.status) !== "review") throw new BadRequest("only a page in review can be approved");
      const updated = await doPublish(db, page, actorOf(ctx), input.note, true); // manual → clear pending auto-unpublish
      await writeAudit(db, { pageId: input.pageId, action: "approve", from: "review", to: "published", actor: actorOf(ctx), note: input.note });
      return { ok: true, page: updated };
    }, {
      ...reviewer,
      input: (raw): { pageId: string; note?: string } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string") throw new BadRequest("pageId is required");
        return o as never;
      },
    }),

    /** Reject a page in review → back to draft. Reviewer-gated. */
    reject: mutation(async (ctx, input: { pageId: string; note?: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const page = rows[0];
      if (!page) throw notFound("page");
      if (String(page.status) !== "review") throw new BadRequest("only a page in review can be rejected");
      const updated = await db.update("cms_pages", input.pageId, { status: "rejected", updatedAt: nowStamp() });
      await writeAudit(db, { pageId: input.pageId, action: "reject", from: "review", to: "rejected", actor: actorOf(ctx), note: input.note });
      return { ok: true, page: updated };
    }, {
      ...reviewer,
      input: (raw): { pageId: string; note?: string } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string") throw new BadRequest("pageId is required");
        return o as never;
      },
    }),

    /** The workflow audit trail for a page (most recent first). Handler-gated to editors;
     * reads the append-only log via `exec` (a plain admin-scoped read of a gated log). */
    listPageAudit: query(async (ctx, input: { pageId: string; limit?: number }) => {
      const limit = Math.min(Math.max(Math.trunc(Number(input?.limit ?? 50)) || 50, 1), 200);
      return cdb(ctx).exec(
        `SELECT "id", "pageId", "action", "fromStatus", "toStatus", "actor", "note", "createdAt" FROM "cms_audit" WHERE "pageId" = ? ORDER BY "createdAt" DESC LIMIT ${limit}`,
        input.pageId,
      );
    }, {
      ...viewer,
      input: (raw): { pageId: string; limit?: number } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string") throw new BadRequest("pageId is required");
        return o as never;
      },
    }),

    // ---- publishing ----
    /** Publish a page directly: snapshot the assembled page into a revision and flip
     * status to `published` (records an audit entry). The public content API serves the
     * snapshot. `approve` is the review-gated path to the same outcome. */
    publishPage: mutation(async (ctx, input: { pageId: string; note?: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const page = rows[0];
      if (!page) throw notFound("page");
      const from = String(page.status);
      const updated = await doPublish(db, page, actorOf(ctx), input.note, true); // manual → clear pending auto-unpublish
      await writeAudit(db, { pageId: input.pageId, action: "publish", from, to: "published", actor: actorOf(ctx), note: input.note });
      return { ok: true, page: updated };
    }, {
      // Reviewer-gated: publishing makes content live, so it requires the same authority as
      // `approve` — an editor can't bypass review by calling publishPage directly. (Editors
      // author + submitForReview; reviewers approve/publish.)
      ...reviewer,
      input: (raw): { pageId: string; note?: string } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string") throw new BadRequest("pageId is required");
        return o as never;
      },
    }),

    unpublishPage: mutation(async (ctx, input: { pageId: string }) => {
      // Clear any pending schedule tokens too: a queued cms:publish/cms:unpublish task
      // validates its token against these at fire time, so nulling them cancels the
      // schedule (the editor is taking manual control).
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const from = rows[0] ? String(rows[0].status) : undefined;
      const updated = await db.update("cms_pages", input.pageId, { status: "draft", scheduledAt: null, unpublishAt: null, updatedAt: nowStamp() });
      if (!updated) throw notFound("page");
      await writeAudit(db, { pageId: input.pageId, action: "unpublish", from, to: "draft", actor: actorOf(ctx) });
      return { ok: true, page: updated };
    }, {
      ...editor,
      input: (raw): { pageId: string } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string") throw new BadRequest("pageId is required");
        return o as never;
      },
    }),

    /** Schedule a page to publish at `publishAt` (epoch ms), and optionally unpublish at
     * `unpublishAt`. Enqueues delayed outbox tasks (atomic with this write).
     *
     * Outbox tasks can't be recalled, so cancellation/rescheduling is handled by INTENT
     * TOKENS: the page stores the scheduled times (`scheduledAt`/`unpublishAt`, ISO), and
     * each task carries the token it was enqueued for. At fire time the task acts ONLY if
     * its token still equals the page's current token — so rescheduling (new token),
     * manual publish/unpublish (token cleared), and duplicate deliveries all make a stale
     * task a no-op. `unpublishAt` must be after `publishAt`. */
    schedulePage: mutation(async (ctx, input: { pageId: string; publishAt: number; unpublishAt?: number }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      if (!rows[0]) throw notFound("page");
      const now = Date.now();
      const publishToken = new Date(input.publishAt).toISOString();
      const unpublishToken = input.unpublishAt !== undefined ? new Date(input.unpublishAt).toISOString() : null;
      await db.update("cms_pages", input.pageId, { scheduledAt: publishToken, unpublishAt: unpublishToken });
      await ctx.tasks.enqueue({ kind: TASK_PUBLISH, payload: { pageId: input.pageId, token: publishToken }, delayMs: Math.max(0, input.publishAt - now) });
      if (input.unpublishAt !== undefined) {
        await ctx.tasks.enqueue({ kind: TASK_UNPUBLISH, payload: { pageId: input.pageId, token: unpublishToken }, delayMs: Math.max(0, input.unpublishAt - now) });
      }
      return { ok: true, publishInMs: Math.max(0, input.publishAt - now) };
    }, {
      // Reviewer-gated like publishPage — a scheduled publish is still a publish.
      ...reviewer,
      input: (raw): { pageId: string; publishAt: number; unpublishAt?: number } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string" || !Number.isFinite(o.publishAt)) throw new BadRequest("pageId and a finite publishAt (epoch ms) are required");
        if (o.unpublishAt !== undefined) {
          if (!Number.isFinite(o.unpublishAt)) throw new BadRequest("unpublishAt must be a finite epoch ms");
          if ((o.unpublishAt as number) <= (o.publishAt as number)) throw new BadRequest("unpublishAt must be after publishAt");
        }
        return o as never;
      },
    }),

    // ---- public content API ----
    /** Mint a signed, self-expiring preview link for one page. Editor-gated to MINT —
     * anyone holding the resulting link can redeem it, which is the point. */
    signPagePreview: query(async (ctx, input: { pageId: string; expiresIn?: number }) => {
      const secret = previewSecret(ctx.env);
      if (!secret) throw previewUnconfigured(); // fail closed — never mint a forgeable link
      // The redeem route always reaches a Durable Object (callPrivileged -> PRAMEN.get); it
      // has no notion of `x-pramen-store`. Minting on the D1 store therefore produces a
      // link that 404s forever while the editor reports success — refuse instead of
      // handing out a token that cannot work.

      const db = cdb(ctx);
      // Read the page through the ACL first: minting a link is granting access to it, so a
      // caller who cannot read the page must not be able to mint a link that can.
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const page = rows[0];
      if (!page) throw notFound("page");

      const ttl = Math.max(60, Math.min(input.expiresIn ?? previewTtl, 30 * 24 * 3600));
      const exp = Math.floor(Date.now() / 1000) + ttl;
      // Server-resolved, never caller-supplied — so the tenant inside the signature
      // cannot be steered by whoever asks for the link.
      const tenant = ctx.tenant;
      const token = await signToken<PreviewToken>({ t: tenant, p: String(page.id), exp }, secret);
      // RELATIVE, like signed file urls — the client resolves it against the CMS origin.
      return { url: `${PREVIEW_PATH}?token=${encodeURIComponent(token)}`, token, expiresAt: exp * 1000 };
    }, {
      ...editor,
      input: (raw): { pageId: string; expiresIn?: number } => {
        const o = asObj(raw);
        // Unvalidated, a non-string pageId reached the query compiler and surfaced as a
        // 500, and a string expiresIn made exp NaN — minting a link that always 403s,
        // with nothing anywhere to explain why.
        if (typeof o.pageId !== "string" || o.pageId === "") throw new BadRequest("pageId is required");
        if (o.expiresIn !== undefined && (typeof o.expiresIn !== "number" || !Number.isFinite(o.expiresIn))) {
          throw new BadRequest("expiresIn must be a number of seconds");
        }
        return o as never;
      },
    }),

    /** Assemble a page's LIVE draft by id. Not the redemption endpoint — that is the public
     * `GET /cms/preview` route, which verifies the token and then calls this privileged.
     * Role-gated so it is not an anonymous back door on the /rpc surface. */
    getPagePreview: query(async (ctx, input: { pageId: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const page = rows[0];
      if (!page) throw notFound("page");
      const assembled = await assembleLive(db, page);
      assembled.isPreview = true;
      return assembled;
    }, {
      ...viewer,
      input: (raw): { pageId: string } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string" || o.pageId === "") throw new BadRequest("pageId is required");
        return { pageId: o.pageId };
      },
    }),

    /** Fetch an assembled page by slug (+ locale). Anonymous callers get the published
     * snapshot (the ACL scopes `cms_pages` reads to `status = published`). Editors may pass
     * `preview: true` to assemble the current DRAFT live from the tables. `locale` defaults
     * to the configured default locale; a slug is unique per locale. */
    // --- trash: soft delete, restore, purge ---------------------------------
    //
    // A page had NO delete handler at all before this: once created it could only be
    // unpublished, never removed. Delete is therefore introduced already soft — the row
    // stays, `deletedAt` is stamped, and the ACL's read scope hides it everywhere.
    //
    // A trashed page KEEPS ITS SLUG. `(slug, locale)` is a DB unique constraint, so the
    // alternatives were mangling the stored slug on delete or dropping the constraint —
    // both worse than telling the caller plainly that the slug is in the trash. Purging
    // frees it.

    deletePage: mutation(async (ctx, input: { pageId: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      if (!rows[0]) throw notFound("page"); // already trashed reads as absent — the scope hides it
      const now = new Date().toISOString();
      // Clear the schedule. The publish/unpublish tasks run on the SYSTEM task context,
      // where the ACL is bypassed entirely — so the `deletedAt IS NULL` read scope does
      // NOT protect them, and a page trashed before its scheduled time was republished,
      // publicly live, with a fresh revision and nobody pressing publish. Clearing the
      // timestamps makes the tasks' existing intent-token check reject both for free.
      await db.update("cms_pages", input.pageId, { deletedAt: now, updatedAt: now, scheduledAt: null, unpublishAt: null });
      await writeAudit(db, { pageId: input.pageId, action: "delete", from: String(rows[0].status ?? ""), to: "trashed", actor: actorOf(ctx) });
      return { ok: true as const, deletedAt: now };
    }, { ...editor, ...pageIdInput }),

    /** What is currently in the trash — pages AND media. Read with `ctx.db.exec` because
     * the ACL read scope hides exactly these rows: that is the scope doing its job, not a
     * hole to patch.
     *
     * Media has to be listed here or it becomes UNREACHABLE the moment it is trashed —
     * `listMedia`/`getMedia` are ACL-scoped, so neither `restoreMedia` nor `purgeMedia`
     * could ever be called with its id again, while `/media/<key>` kept serving the bytes
     * (that route streams from R2 with no DB lookup at all). */
    listTrash: query(async (ctx, input: { limit?: number }) => {
      // Truncate like listMedia/listPageAudit — a fractional LIMIT reaches SQLite and 500s,
      // and any client computing `total / pages` sends one.
      const limit = Math.min(Math.max(Math.trunc(Number(input.limit)) || 50, 1), 200);
      const db = cdb(ctx);
      const pages = await db.exec(
        "SELECT id, title, slug, locale, status, deletedAt FROM cms_pages WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC LIMIT ?",
        limit,
      );
      const rawMedia = await db.exec(
        "SELECT id, alt, file, deletedAt FROM cms_media WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC LIMIT ?",
        limit,
      );
      // The fileRef object<->JSON codec sits on the ORM path, not raw exec — parse here or
      // a trash UI reusing the media card renders `/media/undefined`.
      const media = rawMedia.map((m) => ({ ...m, file: typeof m.file === "string" ? (JSON.parse(m.file) as JsonValue) : m.file }));
      return { pages, media };
    }, { ...viewer, input: (raw): { limit?: number } => {
      const o = asObj(raw);
      if (o.limit !== undefined && typeof o.limit !== "number") throw new BadRequest("limit must be a number");
      return o as never;
    } }),

    restorePage: mutation(async (ctx, input: { pageId: string }) => {
      const db = cdb(ctx);
      const rows = await db.exec("SELECT id, slug, locale, status, scheduledAt, unpublishAt FROM cms_pages WHERE id = ? AND deletedAt IS NOT NULL LIMIT 1", input.pageId);
      const page = rows[0];
      if (!page) throw notFound("trashed page");
      // Defensive: the trashed row still occupies the (slug, locale) unique index, so in
      // practice nothing can have taken the slug. Kept so a future change that DOES free
      // the slug on delete surfaces as a clean 400 rather than a constraint violation.
      await assertSlugFree(db, String(page.slug), String(page.locale), String(page.id));
      await db.exec("UPDATE cms_pages SET deletedAt = NULL, updatedAt = ? WHERE id = ?", new Date().toISOString(), input.pageId);
      markChanged(db, "cms_pages");
      await writeAudit(db, { pageId: input.pageId, action: "restore", from: "trashed", to: String(page.status ?? ""), actor: actorOf(ctx) });
      // deletePage had to clear any schedule (the publish task runs SYSTEM-scoped, outside
      // the read scope). Restore cannot know what it was, so SAY so — otherwise a promo
      // page due to auto-unpublish comes back live forever with nothing in the audit trail.
      return { ok: true as const, scheduleCleared: page.scheduledAt != null || page.unpublishAt != null };
    }, { ...editor, ...pageIdInput }),

    /** Permanently remove a trashed page and everything hanging off it. Reviewer-gated:
     * this is the only irreversible operation in the CMS. */
    purgePage: mutation(async (ctx, input: { pageId: string }) => {
      const db = cdb(ctx);
      const rows = await db.exec("SELECT id FROM cms_pages WHERE id = ? AND deletedAt IS NOT NULL LIMIT 1", input.pageId);
      if (!rows[0]) throw notFound("trashed page"); // purging a LIVE page is refused — trash it first
      // Placements, revisions and audit rows are logical relations (no FK cascade), so
      // clear them explicitly or they outlive the page as orphans.
      //
      // The BLOCKS themselves need the same treatment, and it has to happen before the
      // placements go: a non-reusable block used only by this page becomes unreachable
      // once its last placement is deleted (there is no listBlocks, and removeBlock needs
      // a pageBlockId that no longer exists). Mirrors removeBlock's own GC.
      const doomed = await db.exec(
        `SELECT b.id AS id FROM cms_blocks b
           JOIN cms_page_blocks pb ON pb.blockId = b.id
          WHERE pb.pageId = ? AND b.isReusable = 0
            AND NOT EXISTS (SELECT 1 FROM cms_page_blocks o WHERE o.blockId = b.id AND o.pageId <> ?)`,
        input.pageId,
        input.pageId,
      );
      await db.exec("DELETE FROM cms_page_blocks WHERE pageId = ?", input.pageId);
      for (const row of doomed) await db.exec("DELETE FROM cms_blocks WHERE id = ?", String(row.id));
      await db.exec("DELETE FROM cms_page_revisions WHERE pageId = ?", input.pageId);
      await db.exec("DELETE FROM cms_audit WHERE pageId = ?", input.pageId);
      await db.exec("DELETE FROM cms_pages WHERE id = ?", input.pageId);
      markChanged(db, "cms_pages", "cms_page_blocks", "cms_blocks", "cms_page_revisions", "cms_audit");
      return { ok: true as const };
    }, { ...reviewer, ...pageIdInput }),

    getPage: query(async (ctx, input: { slug: string; locale?: string; preview?: boolean }) => {
      const db = cdb(ctx);
      // Preview is an editor capability — gate it before the lookup so a non-editor gets a
      // clear 403 (rather than a 404 that merely reflects the published-only read scope).
      if (input.preview && !isEditor(ctx, viewerRoles)) throw new Forbidden("preview requires an editor or reviewer role");
      const locale = input.locale ?? defaultLocale;
      const rows = await db.find({ from: "cms_pages", where: { slug: input.slug, locale }, limit: 1 });
      const page = rows[0];
      if (!page) throw notFound("page"); // also the anonymous-vs-draft case: ACL yields no row

      if (input.preview) {
        const live = await assembleLive(db, page);
        live.isPreview = true; // same flag the token route sets, so a banner works either way
        return live;
      }
      // Public path: serve the page's current published revision snapshot (selected by the
      // page's `currentRevisionId` pointer — deterministic, unlike ordering by a
      // second-precision timestamp). We do NOT assemble live here: anonymous has no read
      // grant on the block tables (only pages + revisions), so a page without a current
      // revision returns its meta with empty regions rather than a spurious 403. In
      // practice publish always sets currentRevisionId, so that fallback is defensive.
      if (page.currentRevisionId) {
        const revs = await db.find({ from: "cms_page_revisions", where: { id: page.currentRevisionId }, limit: 1 });
        if (revs[0]?.snapshot) {
          const snap = revs[0].snapshot as unknown as AssembledPage;
          // hreflang alternates are computed LIVE (not from the snapshot): a sibling
          // published AFTER this page won't be in the baked snapshot. Anonymous can read
          // published pages, so this query is in-policy on the public path.
          snap.page.translations = await siblingTranslations(db, page);
          // Back-compat: a snapshot baked before `seo`/`translationGroupId` existed lacks
          // those keys, but AssembledPage now types them as present — backfill from the live
          // page row so a frontend head template never hits `page.seo` === undefined.
          if (!snap.page.seo) snap.page.seo = pageMeta(page).seo;
          // `version` from the LIVE row, never the snapshot: a snapshot is baked at publish
          // time, so a client echoing it would 409 forever after the first draft edit — and
          // a pre-`version` snapshot has none at all, which (typed `number`) silently drops
          // out of the request body and reverts to the last-write-wins this feature removes.
          snap.page.version = typeof page.version === "number" ? page.version : 1;
          if (snap.page.translationGroupId === undefined) snap.page.translationGroupId = (page.translationGroupId as string | null) ?? null;
          return snap;
        }
      }
      return { page: pageMeta(page, await siblingTranslations(db, page), await resolveMediaId(db, page.ogImage)), regions: {} };
    }, {
      input: (raw): { slug: string; locale?: string; preview?: boolean } => {
        const o = asObj(raw);
        if (typeof o.slug !== "string") throw new BadRequest("slug is required");
        if (o.locale !== undefined && typeof o.locale !== "string") throw new BadRequest("locale must be a string");
        return o as never;
      },
    }),
  };
}

/** The default CMS handlers (editor roles `["editor", "admin"]`). */
export const cmsHandlers = createCmsHandlers();

// --- ACL policy fragments ----------------------------------------------------

export interface CmsPolicyOpts {
  /** Prefix for policy names (unique across roles). Default `cms`. */
  prefix?: string;
}

/** ACL fragments. Spread `public` into your anonymous role and `editor` into your
 * editor/admin role:
 *
 *   role("anonymous", [...cmsPolicies().public])
 *   role("editor",    [...cmsPolicies().editor])
 *
 * `public` grants read of PUBLISHED pages + their revision snapshots only (the public
 * content API reads the snapshot, so unpublished block rows are never exposed).
 * `editor` grants full CRUD across every cms_ table. */
export function cmsPolicies(opts: CmsPolicyOpts = {}): { public: Policy[]; editor: Policy[] } {
  const p = opts.prefix ?? "cms";
  // `cms_collection_revisions` is deliberately NOT here: it is append-only, and this loop
  // grants update AND delete. Spreading both fragments (which every wiring in the README
  // does) would otherwise hand every editor the ability to rewrite or purge history through
  // any app handler, silently overriding the read+create grant `collectionPolicies` emits —
  // duplicate policies on the same (role, entity, action) OR-merge, so the wider one wins.
  // The collection half owns that table's grant; see `collectionPolicies`.
  const tables = [
    "cms_content_types", "cms_block_types", "cms_blocks", "cms_pages", "cms_page_blocks", "cms_page_revisions", "cms_media", "cms_audit",
    // Site furniture. Full CRUD for an editor, like every other cms_ table — the per-handler
    // `auth` gate is what separates editor from reviewer; this is the row scope.
    "cms_menus", "cms_redirects", "cms_taxonomies", "cms_terms", "cms_page_terms", "cms_widget_areas",
  ] as const;
  // Soft-deleted rows are filtered in the ACL, not in each handler. A read scope is
  // AND-merged into every `ctx.db` read, so one policy hides a trashed row from the public
  // API, the editor, relation traversals and eager-loads at once — where a per-handler
  // `where` would have to be remembered at ~40 call sites and would be wrong the first
  // time someone forgot. The trash itself is read with `ctx.db.exec` (below), which is the
  // documented raw escape hatch and deliberately outside this scope.
  const notTrashed = { where: { deletedAt: { isNull: true } } };
  const softDeleted: Record<string, true> = { cms_pages: true, cms_media: true };
  const editorPolicies: Policy[] = [];
  for (const table of tables) {
    for (const action of ["read", "create", "update", "delete"] as const) {
      // UPDATE is scoped as well as READ. Handlers that read the row first already 404 on
      // a trashed page, but `updatePageSeo`/`updateMedia` patched blind — so an editor with
      // a stale tab could mutate a page a colleague had just trashed, and the write echo
      // handed back the whole hidden row. Scoping the grant covers every future write
      // handler too, rather than relying on each one remembering to read first.
      const scoped = (action === "read" || action === "update") && softDeleted[table];
      editorPolicies.push(policy(`${p}:editor:${table}:${action}`, table, action, scoped ? notTrashed : allow()));
    }
  }
  return {
    public: [
      // Content-type metadata (slug/name) is public: the content API returns each published
      // page's content-type slug (via listPublishedPages' live typeId→slug join) so a frontend
      // can route/render by type. Slugs/names are structural, not sensitive.
      policy(`${p}:public:content-types:read`, "cms_content_types", "read", allow()),
      // Only published pages are readable; the snapshot carries the content.
      policy(`${p}:public:pages:read`, "cms_pages", "read", { where: { status: "published", deletedAt: { isNull: true } } }),
      // getPage reads the latest revision snapshot. Scope the grant by the revision's
      // PAGE being currently published (a relation-traversal where, compiled to a
      // subquery), so a revision of a later-unpublished/archived page is never publicly
      // readable — least-privilege even for a future revision-listing handler.
      // `deletedAt` as well as `status`: getPage 404s on the page lookup first today, so
      // this is defense in depth — but a revision snapshot is a BAKED copy of the page's
      // content, and a future revision-listing handler reading it directly would otherwise
      // serve a trashed page's body.
      policy(`${p}:public:revisions:read`, "cms_page_revisions", "read", { where: { page: { status: "published", deletedAt: { isNull: true } } } }),
      // Media metadata is public (the bytes are separately gated by signed urls).
      policy(`${p}:public:media:read`, "cms_media", "read", { where: { deletedAt: { isNull: true } } }),
      // --- site furniture ---
      // A menu is site chrome, rendered on every page. `getMenu` resolves its page
      // references THROUGH `ctx.db`, so the public page scope above is what decides whether
      // a link to an unpublished page renders — the menu grant does not widen it.
      policy(`${p}:public:menus:read`, "cms_menus", "read", allow()),
      // Only ENABLED redirects. `resolveRedirect` also filters, but the scope is the real
      // boundary: a disabled redirect is one an editor has deliberately taken out of
      // service, and it must stay invisible to every anonymous read, not just that one.
      policy(`${p}:public:redirects:read`, "cms_redirects", "read", { where: { enabled: true } }),
      // Taxonomies and terms are structural (they are URL segments a front end routes on),
      // exactly like content-type slugs. The junction is granted too, because
      // `where: { terms: … }` on a page compiles to a subquery THROUGH it — without the
      // grant the traversal matches nothing and "pages in this category" is silently empty.
      policy(`${p}:public:taxonomies:read`, "cms_taxonomies", "read", allow()),
      policy(`${p}:public:terms:read`, "cms_terms", "read", allow()),
      policy(`${p}:public:page-terms:read`, "cms_page_terms", "read", allow()),
      policy(`${p}:public:widget-areas:read`, "cms_widget_areas", "read", allow()),
    ],
    editor: editorPolicies,
  };
}

// --- collections: edit arbitrary pramen entities in the CMS editor -----------
//
// The block/page model is one opinionated shape (a routable page with a mandatory slug +
// regions of blocks). A COLLECTION is the generic escape hatch: it points the editor at
// one of YOUR OWN pramen entities (spread into defineSchema alongside cmsSchema) and
// describes how to edit it with the SAME field DSL that blocks use. So "Lectures" is a
// first-class, queryable entity — real columns, relations, cell-ACL — that also gets a
// list + form UI, without being bent into a cms_pages row.
//
// Column-mapped: each scalar FieldDefinition.name is a real column on the entity; a
// repeater/group/richtext field maps to a t.json() column (the object↔JSON codec at the
// Db chokepoint stores it transparently). `richtext` belongs with the latter group — its
// value is a document tree, and a TEXT column would bind the object raw and be rejected. The generic handlers dispatch through a registry
// keyed by `slug`, so `collection`/`entity` can never be spoofed to reach an arbitrary
// table, and writes are whitelisted to declared fields — the client can't set columns the
// collection didn't declare (e.g. a `roles` or `passwordHash` column on the entity).

/** Nav positions for the editor's built-in sections — see `./nav`. Re-exported here so a
 * host writing `app.ts` imports it from the same place as `collection()`. It LIVES in a leaf
 * module because `blockkit.ts` needs it too and must not depend on this one. */
export { NAV_ORDER } from "./nav";


/** Declares that a pramen entity is editable as a collection in the CMS editor. Both
 * halves live here: the runtime facts (entity, idField, validation via `fields`) and the
 * UI facts (labels, list columns, ordering). Mirror of {@link ContentTypeDef}. */
export interface CollectionDef {
  /** The pramen entity (table) this collection edits — one of your own entities, spread
   * into `defineSchema` next to `cmsSchema`. The handler registry keys off `slug`, then
   * reads this; it is never taken from client input. */
  readonly entity: string;
  /** URL + nav key, e.g. `"lectures"`. Unique across collections. */
  readonly slug: string;
  /** Singular UI label, e.g. `"Lecture"`. */
  readonly label: string;
  /** Plural UI label; defaults to `label + "s"`. */
  readonly pluralLabel?: string;
  /** Optional nav icon (emoji or short string). */
  readonly icon?: string;
  /** The edit-form schema — the same DSL as blocks. Each scalar field is a real column
   * on `entity`; repeater/group map to a `t.json()` column. Also the WRITE WHITELIST:
   * only these field names are ever written to the entity. */
  readonly fields: readonly FieldDefinition[];
  /** Columns shown in the list view; defaults to `[titleField]`. */
  readonly list?: readonly string[];
  /** Column that titles a row in the list; defaults to `"title"`. */
  readonly titleField?: string;
  /** Primary-key column used to load/patch a single row; defaults to `"id"`. */
  readonly idField?: string;
  /** Default list ordering; defaults to `{ column: "createdAt", dir: "desc" }`. */
  readonly orderBy?: { column: string; dir?: "asc" | "desc" };
  /** Where this collection sits in the editor's primary nav. Lower comes first; ties keep
   * declaration order. Defaults to `NAV_ORDER.collections`, which is between Pages and
   * Media — where collections have always rendered.
   *
   * The point is not cosmetic. Before this the only extension seam was `extraNav`, which
   * renders dead LAST and (by default, and for good reason) opens a new tab — so a
   * project-specific section could only ever be a separate app bolted onto the end of the
   * admin. A section that belongs beside Pages can now say so. See {@link NAV_ORDER} for
   * the built-in positions to place against. */
  readonly navOrder?: number;
  /** Workflow features this collection opts into — see {@link CollectionFeature}. Each is
   * backed by MANAGED COLUMNS on `entity` that the CMS writes and `fields` may not declare.
   * Validated against your schema at `createCollectionHandlers` time (which is why that call
   * needs `{ schema }` once this is set). Absent = a plain CRUD collection, as before. */
  readonly supports?: readonly CollectionFeature[];
}

/** Declare a collection. Spread the results into `createCollectionHandlers` +
 * `collectionPolicies`:
 *
 *   const lectures = collection("lectures", {
 *     entity: "lectures", label: "Lecture", titleField: "title",
 *     list: ["title", "speaker", "date"],
 *     fields: [
 *       { name: "title", type: "text", required: true },
 *       { name: "speaker", type: "text" },
 *       { name: "date", type: "date" },
 *     ],
 *   }); */
export function collection(slug: string, opts: Omit<CollectionDef, "slug">): CollectionDef {
  return { ...opts, slug };
}

/** The client-facing subset of a collection the editor fetches via `listCollections` to
 * build its nav + generic list/edit views (no per-collection editor code, no rebuild to
 * add one). Excludes the server-only `entity` (the editor addresses a collection by `slug`
 * only, never by table name); `idField` IS included — it's just the PK column name, which
 * the editor needs to read a row's id from a list result. */
export interface CollectionMeta {
  slug: string;
  label: string;
  pluralLabel: string;
  icon?: string;
  /** Nav position — see {@link CollectionDef.navOrder}. Always present in the meta (the
   * default is filled here) so the editor sorts one list of numbers rather than deciding
   * per entry whether a default applies. */
  navOrder: number;
  fields: readonly FieldDefinition[];
  list: readonly string[];
  titleField: string;
  idField: string;
  orderBy?: { column: string; dir?: "asc" | "desc" };
  /** Workflow features enabled — the editor uses this to decide which affordances to show
   * (a Publish button, a schedule picker, a revisions tab). Empty = plain CRUD. */
  supports: readonly CollectionFeature[];
}

/** The public view of a collection def (defaults filled). */
function collectionMeta(c: CollectionDef): CollectionMeta {
  const titleField = c.titleField ?? "title";
  return {
    slug: c.slug,
    label: c.label,
    pluralLabel: c.pluralLabel ?? `${c.label}s`,
    icon: c.icon,
    navOrder: c.navOrder ?? NAV_ORDER.collections,
    fields: c.fields,
    list: c.list ?? [titleField],
    titleField,
    idField: c.idField ?? "id",
    orderBy: c.orderBy,
    supports: c.supports ?? [],
  };
}


// --- collection workflow features (`supports`) -------------------------------
//
// A collection may opt into page-style workflow with `supports: ["drafts", ...]`. Each
// feature is backed by MANAGED COLUMNS on the collection's OWN entity: the app declares the
// columns, the CMS owns their values.
//
// That ownership is the whole difference from the `publish` FIELD type this replaces. A
// `publish` field is an ordinary entry in `fields`, and `fields` is the write whitelist —
// so "is this row live?" was a value the client sent in the `values` bag, and the access
// boundary was whatever the client last wrote. A managed column is never in the whitelist
// (declaring one as a field is a boot error, see `validateCollections`), so only
// `collectionPublish` / `collectionSchedule` / the scheduled tasks can move a row live.
//
// TIMESTAMP FORMAT. Managed timestamps are minted as ISO-8601 UTC with a `Z`
// (`2026-08-20T12:00:00.000Z`), in exactly one place (`isoStamp`). That is the format
// `$now()` produces, and the published-read scope compares against it LEXICOGRAPHICALLY.
//
// It used to be worth saying that this is NOT the shape `expr.now()` writes. It is now:
// `expr.now()` emits the same ISO form, so a managed column and an `expr.now()` default
// beside it are finally comparable, and `nowStamp` is an alias for `isoStamp` rather than a
// second format. What still holds is the reason for minting in one place — the trap
// documented on the `publish` field, where two controls wrote different formats into one
// TEXT column and both passed validation.

/** A workflow feature a collection can opt into.
 *
 * - `drafts` — a managed `status` column (`draft` | `published`) plus `collectionPublish` /
 *   `collectionUnpublish`. Pair with `collectionPublicPolicies` so anonymous reads see
 *   published rows only.
 *
 *   This gates VISIBILITY, not content. A collection is column-mapped — the public reads the
 *   entity's own columns — so there is nowhere to stage an unpublished VERSION of a live
 *   row: an edit (or a revision restore) on a published row is live immediately. That is the
 *   one place collections do not reach page parity, where `getPage` serves a baked revision
 *   snapshot. Unpublish first if an edit needs review.
 * - `scheduling` — managed `publishedAt` / `scheduledAt` / `unpublishAt`, `collectionSchedule`,
 *   and the deferred tasks from `createCollectionTasks`. Needs `drafts`.
 * - `revisions` — a snapshot of the row's prior state on every write, in
 *   `cms_collection_revisions`, with `collectionListRevisions` / `collectionRestoreRevision`.
 * - `preview` — signed, single-row preview links (`signCollectionPreview`), redeemed at
 *   `COLLECTION_PREVIEW_PATH` by the route `cmsRoutes()` serves. Needs `drafts`. It shows
 *   the row's CURRENT state to whoever holds the link, which for a DRAFT is the unpublished
 *   content and for a published row is what the public already sees (see `drafts` above:
 *   there is no separate staged version to show). */
export type CollectionFeature = "drafts" | "scheduling" | "revisions" | "preview";

export const COLLECTION_FEATURES: readonly CollectionFeature[] = ["drafts", "scheduling", "revisions", "preview"];

/** The columns each feature needs on the collection's entity. The app declares them (they
 * are its own entity); the CMS writes them and `fields` may not. */
export const COLLECTION_FEATURE_COLUMNS: Readonly<Record<CollectionFeature, readonly string[]>> = {
  drafts: ["status"],
  scheduling: ["publishedAt", "scheduledAt", "unpublishAt"],
  revisions: [],
  preview: [],
};

/** Features that mean nothing on their own. Scheduling moves a row between draft and
 * published; preview shows the unpublished version — both presuppose `drafts`. */
const COLLECTION_FEATURE_REQUIRES: Readonly<Partial<Record<CollectionFeature, CollectionFeature>>> = {
  scheduling: "drafts",
  preview: "drafts",
};

/** The shared revision table for collections (see `cmsSchema`). */
export const COLLECTION_REVISIONS_TABLE = "cms_collection_revisions";

/** The two `status` values a `drafts` collection uses. */
export const COLLECTION_DRAFT = "draft";
export const COLLECTION_PUBLISHED = "published";

/** `collectionList` page size when the caller names none, and the ceiling it is clamped to.
 * The cap is the point: an unbounded list of a wide entity is the D1-over-RPC failure mode
 * (GitHub #22), and `LIMIT -1` is SQLite for "no limit". */
const DEFAULT_COLLECTION_LIST_LIMIT = 100;
const MAX_COLLECTION_LIST_LIMIT = 500;

/** The epoch-ms range a schedule may name: 1970-01-01 up to (not including) year 10000.
 *
 * `Number.isFinite` is NOT a sufficient bound, in two directions. Above `8.64e15` (the max
 * `Date`) `toISOString()` throws a `RangeError` INSIDE the mutation — an opaque 500 for the
 * common client slip of sending epoch microseconds. And from year 10000 up, `toISOString()`
 * mints an EXPANDED-year string (`"+010000-01-01T00:00:00.000Z"`) whose leading `+` sorts
 * BEFORE every ordinary timestamp — inverting every lexicographic comparison this feature
 * rests on, so a takedown 8000 years out reads as already passed and a publish instant in
 * the far future reads as due. One range check closes both. */
const MIN_SCHEDULE_MS = 0;
const MAX_SCHEDULE_MS = 253402300799999; // 9999-12-31T23:59:59.999Z

const epochInput = (name: string, v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BadRequest(`${name} must be a finite epoch ms`);
  if (!Number.isInteger(v)) throw new BadRequest(`${name} must be a whole number of epoch ms`);
  if (v < MIN_SCHEDULE_MS || v > MAX_SCHEDULE_MS) {
    throw new BadRequest(`${name} must be an epoch ms between ${MIN_SCHEDULE_MS} and ${MAX_SCHEDULE_MS} (1970 … 9999) — got ${v}`);
  }
  return v;
};

/** The column types a declared field can be stored in. A collection field is COLUMN-MAPPED,
 * so the entity's column type has to match what the field writes: a `richtext`/`group`/
 * `repeater` value is a document (`t.json()`), the rest are scalars. Getting this wrong is
 * not a type error anywhere — it surfaces as a raw driver message on the first write
 * ("Binding expected string, TypedArray, …"), which is why it is checked at boot. */
const COLLECTION_FIELD_COLUMN_TYPES: Readonly<Record<FieldDefinition["type"], readonly FieldType[]>> = {
  text: ["text", "uuid"],
  textarea: ["text"],
  richtext: ["json"],
  url: ["text"],
  number: ["integer", "real"],
  boolean: ["boolean", "integer"],
  date: ["text"],
  datetime: ["text"],
  publish: ["text"],
  slug: ["text"],
  media: ["text", "uuid"],
  select: ["text"],
  // A SINGLE reference is one opaque id in a TEXT column. `multiple: true` stores an array
  // and needs `t.json()` — `referenceColumnTypes` below is what actually decides, because
  // this table is keyed by type alone and a reference is the one type whose storage depends
  // on a second flag.
  reference: ["text", "uuid"],
  repeater: ["json"],
  group: ["json"],
};

/** The column types a field can be stored in, including the one case the type alone does
 * not settle (`reference` + `multiple`). */
function fieldColumnTypes(f: FieldDefinition): readonly FieldType[] | undefined {
  if (f.type === "reference" && f.multiple) return ["json"];
  return COLLECTION_FIELD_COLUMN_TYPES[f.type];
}

/** Check a collection registry at BOOT: slugs and entities are unique, features are known
 * and have their prerequisites, every declared field maps to a column that can hold it, and
 * every managed column exists, has the shape the CMS writes, and is not also an editable
 * field.
 *
 * Called by `createCollectionHandlers`. The point is that a misconfiguration surfaces when
 * the Worker starts, naming the collection and the column — not as a 500 the first time an
 * editor presses Publish, months later, on the one collection nobody exercised.
 *
 * `schema` is REQUIRED. Every check here reads the target entity, so a registry validated
 * without one is not validated at all — and the failures it catches (a field name typo, a
 * richtext field over a TEXT column, a non-PK idField) are exactly as fatal on a collection
 * that declares no `supports` as on one that declares all four. */
export function validateCollections(collections: readonly CollectionDef[], schema?: SchemaDef): void {
  const seen = new Set<string>();
  const byEntity = new Map<string, string>();
  for (const c of collections) {
    if (seen.has(c.slug)) throw new Error(`pramen/cms: duplicate collection slug '${c.slug}' — slugs are the handler registry's key`);
    seen.add(c.slug);
    // ONE collection per entity. The ACL keys policies by (role, entity, action) and
    // OR-merges the matches — the policy NAME is not part of the key — so a second
    // collection over the same entity does not add a second, separate view: it WIDENS the
    // first one's read scope. Two `collectionPublicPolicies` grants over one entity collapse
    // to the loosest of the two, which is how a `drafts`-only collection silently removes
    // the `publishedAt <= $now()` and `unpublishAt > $now()` clauses from a `scheduling`
    // sibling — publishing a row a year early and defeating its scheduled takedown.
    const first = byEntity.get(c.entity);
    if (first) {
      throw new Error(
        `pramen/cms: collections '${first}' and '${c.slug}' both target entity '${c.entity}' — the ACL OR-merges policies on the same (role, entity, action), so a second collection widens the first one's read scope instead of adding a separate view. Register one collection per entity.`,
      );
    }
    byEntity.set(c.entity, c.slug);
  }
  if (collections.length === 0) return;
  if (!schema) {
    throw new Error(
      `pramen/cms: createCollectionHandlers needs your schema to check the registry against your entities: createCollectionHandlers(collections, { schema })`,
    );
  }
  for (const c of collections) {
    const features = c.supports ?? [];
    const set = new Set<CollectionFeature>(features);
    for (const f of features) {
      if (!COLLECTION_FEATURES.includes(f)) {
        throw new Error(`pramen/cms: collection '${c.slug}' declares unknown feature '${String(f)}' (known: ${COLLECTION_FEATURES.join(", ")})`);
      }
      const needs = COLLECTION_FEATURE_REQUIRES[f];
      if (needs && !set.has(needs)) {
        throw new Error(`pramen/cms: collection '${c.slug}' declares '${f}', which needs '${needs}' — add it to \`supports\``);
      }
    }
    const entity = schema[c.entity];
    if (!entity) throw new Error(`pramen/cms: collection '${c.slug}' targets entity '${c.entity}', which is not in the schema`);
    const columns = entity.fields as Record<string, FieldDef>;
    // EVERY collection handler dispatches to the default partition's DO: none of them
    // declares a `partition`, and `/rpc` routes by the handler's. An entity parked in
    // another partition therefore boots clean and then 400s on every single call
    // (`assertInPartition`), and a preview link 404s forever — `callPrivileged` has no
    // partition to pass either. Name it here instead.
    const entityPartition = partitionOf(schema, c.entity);
    if (entityPartition !== DEFAULT_PARTITION) {
      throw new Error(
        `pramen/cms: collection '${c.slug}' targets entity '${c.entity}' in partition '${entityPartition}', but the collection handlers are dispatched to the '${DEFAULT_PARTITION}' partition — every call would fail. Keep a collection's entity in the default partition.`,
      );
    }
    const idField = c.idField ?? "id";
    if (!(idField in columns)) {
      throw new Error(`pramen/cms: collection '${c.slug}' has idField '${idField}', which is not a column on '${c.entity}'`);
    }
    // …and it must be the PRIMARY KEY, not merely a column. Reads key on `idField`, but
    // `db.update`/`db.delete` key on the entity's actual PK — so a non-PK idField loads a
    // row fine and then writes nothing, surfacing as a 404 on a row the same handler just
    // read. Exactly the misconfiguration this validator exists to name.
    const pk = Object.entries(columns).find(([, f]) => f.primaryKey)?.[0] ?? "id";
    if (idField !== pk) {
      throw new Error(
        `pramen/cms: collection '${c.slug}' has idField '${idField}', but '${c.entity}' has primary key '${pk}' — writes key on the PK, so they would silently match no row`,
      );
    }
    // Declared fields ARE columns on the entity (that is what "column-mapped" means), so a
    // typo is a write that fails with the driver's own message and no HTTP status, and a
    // document field over a TEXT column is the trap example/app.ts documents in a comment.
    // Both are visible right here, with `columns` in hand.
    for (const f of c.fields) {
      const col = columns[f.name];
      if (!col) {
        throw new Error(
          `pramen/cms: collection '${c.slug}' declares a field '${f.name}', which is not a column on '${c.entity}' — a collection field is column-mapped, so every declared field needs its own column`,
        );
      }
      const allowed = fieldColumnTypes(f);
      if (allowed && !allowed.includes(col.type)) {
        const want = allowed.map((t) => `t.${t === "integer" ? "int" : t === "boolean" ? "bool" : t}()`).join(" or ");
        throw new Error(
          `pramen/cms: collection '${c.slug}' declares '${f.name}' as '${f.type}', which is stored as ${allowed.join("/")}, but '${c.entity}.${f.name}' is ${col.type} — declare it as ${want}`,
        );
      }
      if (col.hidden) {
        throw new Error(
          `pramen/cms: collection '${c.slug}' declares '${f.name}' as an editable field, but '${c.entity}.${f.name}' is hidden() — a hidden column is stripped from every read, so the editor would show it empty and overwrite it on every save`,
        );
      }
    }
    // A declared `orderBy` fails SILENTLY when the column does not exist: the dialect
    // double-quotes the name and SQLite resolves an unknown quoted identifier to a string
    // CONSTANT, so every row sorts equal and the list comes back in arbitrary storage order
    // with no error anywhere.
    if (c.orderBy && !(c.orderBy.column in columns)) {
      throw new Error(
        `pramen/cms: collection '${c.slug}' orders by '${c.orderBy.column}', which is not a column on '${c.entity}' — SQLite would resolve the quoted name to a constant and sort every row equal`,
      );
    }
    const declared = new Set(c.fields.map((f) => f.name));
    for (const f of features) {
      for (const col of COLLECTION_FEATURE_COLUMNS[f]) {
        const column = columns[col];
        if (!column) {
          throw new Error(
            `pramen/cms: collection '${c.slug}' declares '${f}', which manages a \`${col}\` column on '${c.entity}' — add \`${col}: t.text()\` to the entity`,
          );
        }
        // NAME alone is not enough. The CMS writes these columns as TEXT (an ISO-8601
        // instant or a status word) and compares them lexicographically in the public read
        // scope, and every wrong declaration fails SILENTLY rather than loudly:
        //   - `t.json()` stores `"\"published\""` (the Db chokepoint stringifies), so the
        //     policy's `status = 'published'` never matches and the row is invisible
        //     forever while `collectionPublish` echoes success;
        //   - `notNull()` 500s on every create (the managed columns are seeded as NULL);
        //   - `hidden()` strips the column from every read, disabling the spent-takedown
        //     repair and hiding the state from the editor.
        if (column.type !== "text") {
          throw new Error(
            `pramen/cms: collection '${c.slug}' declares '${f}', which manages \`${c.entity}.${col}\` as TEXT, but it is ${column.type} — declare it as \`${col}: t.text()\` (a non-TEXT column compares wrong against $now() and would never match the published scope)`,
          );
        }
        if (column.notNull) {
          throw new Error(
            `pramen/cms: collection '${c.slug}' declares '${f}', which manages \`${c.entity}.${col}\`, but the column is notNull() — the CMS seeds and clears it with NULL, so every write would fail. Drop notNull() (a defaultTo() is fine).`,
          );
        }
        if (column.hidden) {
          throw new Error(
            `pramen/cms: collection '${c.slug}' declares '${f}', which manages \`${c.entity}.${col}\`, but the column is hidden() — the CMS reads it back to decide the row's state, so it must be projectable`,
          );
        }
        // `fields` IS the write whitelist. A `status` entry there would let any editor send
        // `values: { status: "published" }` through collectionUpdate and bypass the publish
        // handler entirely, leaving the gate as decoration over a client-set column.
        if (declared.has(col)) {
          throw new Error(
            `pramen/cms: collection '${c.slug}' declares \`${col}\` as an editable field, but '${f}' manages that column — remove it from \`fields\` (it would be a client-writable publish gate)`,
          );
        }
      }
    }
    if (set.has("revisions")) {
      if (!schema[COLLECTION_REVISIONS_TABLE]) {
        throw new Error(
          `pramen/cms: collection '${c.slug}' declares 'revisions', which needs the \`${COLLECTION_REVISIONS_TABLE}\` table — spread \`cmsSchema\` into defineSchema`,
        );
      }
      // A DO cannot write across a partition boundary, so a collection entity parked in its
      // own partition would 500 on the first snapshot insert (assertInPartition). The
      // default-partition check above already covers this; keep the specific message for
      // the case where `cms_collection_revisions` itself was moved.
      const revPartition = partitionOf(schema, COLLECTION_REVISIONS_TABLE);
      if (entityPartition !== revPartition) {
        throw new Error(
          `pramen/cms: collection '${c.slug}' declares 'revisions', but '${c.entity}' is in partition '${entityPartition}' while \`${COLLECTION_REVISIONS_TABLE}\` is in '${revPartition}' — a write cannot cross partitions, so keep the entity in '${revPartition}'`,
        );
      }
    }
  }
}

/** A signed grant to preview ONE collection row. Mirrors {@link PreviewToken}. */
export interface CollectionPreviewToken {
  /** tenant */ t: string;
  /** collection slug */ c: string;
  /** row id — the grant is scoped to this ONE row, never "all drafts" */ r: string;
  /** expiry (epoch seconds) */ exp: number;
}

/** Where a collection preview link is redeemed. Served by `cmsRoutes()`. */
export const COLLECTION_PREVIEW_PATH = "/cms/preview/collection";

/** Outbox task kinds behind `collectionSchedule`. Register the handlers with
 * `app.tasks = { ...cmsTasks, ...createCollectionTasks(collections) }`. */
export const TASK_COLLECTION_PUBLISH = "cms:collection:publish";
export const TASK_COLLECTION_UNPUBLISH = "cms:collection:unpublish";

/** Options for `createCollectionHandlers`. */
export interface CollectionHandlerOpts extends CmsHandlerOpts {
  /** Your app's schema (the object you pass to `defineSchema`). REQUIRED: the whole registry
   * is checked against it at boot by `validateCollections` — managed columns, declared
   * field ↔ column types, the idField/PK pairing, `orderBy`, the partition — so a
   * misconfiguration is a startup error naming the collection and the column rather than a
   * 500 (or a silent wrong answer) on the first call. */
  schema?: SchemaDef;
}

/** Build generic CRUD handlers over the registered collections. Spread into your app's
 * handlers alongside `cmsHandlers`:
 *
 *   const handlers = { ...cmsHandlers, ...createCollectionHandlers([lectures], { schema }) };
 *
 * Exposes `listCollections` (editor discovery) + `collectionList` / `collectionGet` /
 * `collectionCreate` / `collectionUpdate` / `collectionDelete`, all gated by `editorRoles`
 * (a fast 403 before the body) AND the row ACL (they go through `ctx.db`, so
 * `collectionPolicies` scopes them too). The `collection` param is resolved through the
 * registry — an unknown slug is a 400, never a raw table reference. */
export function createCollectionHandlers(collections: readonly CollectionDef[], opts: CollectionHandlerOpts = {}) {
  // Boot check, before a single handler is built: unknown/incoherent features and missing
  // managed columns throw here rather than 500ing on the first publish.
  validateCollections(collections, opts.schema);
  const collectionRtSchema = opts.richTextSchema ?? DEFAULT_RICH_TEXT_SCHEMA;
  const editor = { auth: opts.editorRoles ?? ["editor", "admin"] };
  // Preview redemption presents editorRoles ∪ reviewerRoles (see `viewerRolesOf`), so the
  // handler the route calls has to accept that set — gating it to `editor` alone would 403
  // every preview link for a reviewer-only identity. Same wiring as `getPagePreview`.
  const viewer = { auth: viewerRolesOf(opts) };
  const previewTtl = opts.previewTtlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS;
  const bySlug = new Map(collections.map((c) => [c.slug, c] as const));
  const metas = collections.map(collectionMeta);
  const def = (slug: unknown): CollectionDef => {
    const c = typeof slug === "string" ? bySlug.get(slug) : undefined;
    if (!c) throw new BadRequest(`unknown collection: ${String(slug)}`);
    return c;
  };
  /** Narrow a stored snapshot to the columns a caller may read on the collection's entity.
   * Used by both the history read and the restore write, so "what you can see" and "what you
   * can put back" are the same set. */
  const projectSnapshot = (snapshot: unknown, readable: ReadonlySet<string>): Record<string, unknown> => {
    const obj = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? (snapshot as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (readable.has(k)) out[k] = v;
    return out;
  };
  const idOf = (c: CollectionDef): string => c.idField ?? "id";
  const has = (c: CollectionDef, f: CollectionFeature): boolean => (c.supports ?? []).includes(f);
  const columnsOf = (c: CollectionDef): Record<string, FieldDef> => ((opts.schema?.[c.entity]?.fields ?? {}) as Record<string, FieldDef>);
  /** The list ordering, resolved ONCE against the entity. The documented default is
   * `createdAt desc`, but that column is not guaranteed to exist — and an ORDER BY over a
   * missing column does not fail: the dialect quotes the name, SQLite resolves the unknown
   * quoted identifier to a string CONSTANT, every row sorts equal, and the list comes back
   * in arbitrary storage order. Fall back to the PK, which always exists, so the order is at
   * least stable and paging is coherent. (A DECLARED `orderBy` over a missing column is a
   * boot error — see `validateCollections`.) */
  const orderByOf = (c: CollectionDef): { column: string; dir: "asc" | "desc" } => {
    if (c.orderBy) return { column: c.orderBy.column, dir: c.orderBy.dir ?? "desc" };
    return { column: "createdAt" in columnsOf(c) ? "createdAt" : idOf(c), dir: "desc" };
  };
  const orderBys = new Map(collections.map((c) => [c.slug, orderByOf(c)] as const));
  /** 400 (not 500) when a caller invokes a workflow handler on a collection that never
   * opted into it — the handlers exist for every collection, the features do not. */
  const needs = (c: CollectionDef, f: CollectionFeature): void => {
    if (!has(c, f)) throw new BadRequest(`collection '${c.slug}' does not support '${f}' (add it to \`supports\`)`);
  };
  const loadRow = async (db: CmsDb, c: CollectionDef, id: string): Promise<Record<string, unknown>> => {
    const rows = await db.find({ from: c.entity, where: { [idOf(c)]: id }, limit: 1 });
    const row = rows[0];
    if (!row) throw notFound(c.label);
    return row;
  };
  /** Read a row's DECLARED FIELD columns unprojected, for the revision snapshot.
   *
   * `ctx.db.exec` is the documented raw escape hatch: it bypasses the row/field ACL, and it
   * also bypasses the `Db` chokepoint's cell codec — so a json-backed column comes back as
   * the stored TEXT and a boolean as 0/1. Both are decoded here from the entity's own column
   * types (checked against the field types at boot), so a snapshot holds exactly what
   * `db.find` would have returned for an unrestricted caller.
   *
   * Falls back to the ACL-projected row if the raw read comes back empty (a substrate quirk
   * or a row deleted concurrently) — a partial snapshot beats no snapshot. */
  const rawFieldValues = async (db: CmsDb, c: CollectionDef, rowId: string, projected: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const columns = columnsOf(c);
    const names = c.fields.map((f) => f.name).filter((n) => n in columns);
    if (names.length === 0) return {};
    const cols = names.map((n) => `"${n}"`).join(", ");
    // Identifiers, not values: `entity`, `idField` and every field name were checked against
    // the schema at boot, so nothing caller-supplied is interpolated here. The id IS bound.
    const rows = (await db.exec(`SELECT ${cols} FROM "${c.entity}" WHERE "${idOf(c)}" = ?`, rowId)) as Array<Record<string, unknown>>;
    const raw = rows[0];
    if (!raw) {
      const fallback: Record<string, unknown> = {};
      for (const f of c.fields) if (f.name in projected) fallback[f.name] = projected[f.name];
      return fallback;
    }
    const values: Record<string, unknown> = {};
    for (const name of names) {
      const v = raw[name];
      const type = columns[name]?.type;
      if (v == null) values[name] = null;
      else if ((type === "json" || type === "fileRef") && typeof v === "string") {
        try {
          values[name] = JSON.parse(v) as unknown;
        } catch {
          values[name] = v; // not JSON after all — keep the literal rather than losing it
        }
      } else if (type === "boolean") values[name] = typeof v === "boolean" ? v : v !== 0 && v !== 0n;
      else values[name] = v;
    }
    return values;
  };
  /** Snapshot a row's CURRENT (pre-write) state into `cms_collection_revisions`, so a
   * revision always reads as "what it was before this edit" and restoring one is a plain
   * reversal. Declared fields only — the snapshot is replayed through the same write
   * whitelist on restore, so it can never carry a column the collection doesn't own.
   * No-op unless the collection supports `revisions`. */
  const snapshotRow = async (db: CmsDb, c: CollectionDef, row: Record<string, unknown>, ctx: HandlerContext, note: string): Promise<void> => {
    if (!has(c, "revisions")) return;
    const rowId = String(row[idOf(c)]);
    // The row handed in came through the ACL, so it is projected to what THIS caller may
    // read — which would make history a function of who happened to make the edit: an
    // editor whose read scope excludes `salary` would silently drop it from the snapshot,
    // and every later "restore to before that edit" would restore an incomplete row.
    // History is an audit record, not a view, so capture the row's REAL pre-state through
    // the raw escape hatch and let the READ path decide who may see which of its fields
    // (`collectionListRevisions` projects it back down).
    const values = await rawFieldValues(db, c, rowId, row);
    // Next in this row's sequence. Serialized by the DO's single writer; on D1 the composite
    // unique on (collection, rowId, revision) is the backstop — see the schema note.
    const [{ next = 1 } = {}] = (await db.exec(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM ${COLLECTION_REVISIONS_TABLE} WHERE collection = ? AND rowId = ?`,
      c.slug,
      rowId,
    )) as Array<{ next?: number }>;
    await db.insert(COLLECTION_REVISIONS_TABLE, {
      collection: c.slug,
      rowId,
      revision: next,
      snapshot: values,
      note,
      actor: typeof ctx.identity?.userId === "string" ? ctx.identity.userId : null,
      // Explicit, ms-precision, and the only writer of this column — see the schema note.
      createdAt: isoStamp(),
    });
  };
  /** Shared input validator for the `{ collection, id }` handlers. */
  const rowInput = (raw: unknown): { collection: string; id: string } => {
    const o = asObj(raw);
    if (typeof o.collection !== "string" || o.collection === "") throw new BadRequest("collection is required");
    return { collection: o.collection, id: idInput(raw) };
  };
  const collectionInput = (raw: unknown): string => {
    const o = asObj(raw);
    if (typeof o.collection !== "string" || o.collection === "") throw new BadRequest("collection is required");
    return o.collection;
  };
  /** `{ collection, values }` — the write handlers. `values` is validated against the field
   * schema downstream (`toColumns`); this only rejects a non-object, so a string or an array
   * cannot reach the field validator as a bag of index keys. */
  const valuesInput = (raw: unknown): { collection: string; values: Record<string, unknown> } => {
    const o = asObj(raw);
    const values = o.values;
    if (values === null || typeof values !== "object" || Array.isArray(values)) throw new BadRequest("values must be an object");
    return { collection: collectionInput(raw), values: values as Record<string, unknown> };
  };
  const rowValuesInput = (raw: unknown): { collection: string; id: string; values: Record<string, unknown> } => ({
    ...rowInput(raw),
    values: valuesInput(raw).values,
  });
  /** `{ collection, limit?, offset? }`, both CLAMPED. `find` binds `limit` straight into
   * `LIMIT ?`, and SQLite reads a negative limit as UNBOUNDED — so `limit: -1` dumps the
   * whole table over RPC — while a fractional value reaches the driver as-is and 500s. */
  const listInput = (raw: unknown): { collection: string; limit?: number; offset?: number } => {
    const o = asObj(raw);
    const num = (name: string, v: unknown): number | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new BadRequest(`${name} must be a number`);
      return Math.floor(v);
    };
    const limit = num("limit", o.limit);
    const offset = num("offset", o.offset);
    return {
      collection: collectionInput(raw),
      limit: limit === undefined ? undefined : Math.max(1, Math.min(limit, MAX_COLLECTION_LIST_LIMIT)),
      offset: offset === undefined ? undefined : Math.max(0, offset),
    };
  };
  // Validate against the field schema, sanitize richtext, then PROJECT to declared field
  // names only — the write whitelist. `requireRequired` is off for updates (partial patch);
  // on for create. Nothing outside `c.fields` can reach the entity.
  const toColumns = (c: CollectionDef, values: unknown, requireRequired: boolean, legacyBaseline?: FieldValues): Record<string, unknown> => {
    const obj = asObj(values);
    validateFields([...c.fields], obj, "", { requireRequired, legacyBaseline });
    const normalized = normalizeFields([...c.fields], obj, collectionRtSchema);
    const out: Record<string, unknown> = {};
    for (const f of c.fields) if (f.name in normalized) out[f.name] = normalized[f.name];
    return out;
  };
  const idInput = (raw: unknown): string => {
    const id = asObj(raw).id;
    if (typeof id !== "string" || id === "") throw new BadRequest("id is required");
    return id;
  };

  return {
    /** The registered collections (defaults filled) — editor discovery. Editor-gated so
     * the collection schemas aren't exposed to anonymous callers. */
    listCollections: query((): CollectionMeta[] => metas, editor),

    collectionList: query((ctx, input: { collection: string; limit?: number; offset?: number }) => {
      const c = def(input.collection);
      return cdb(ctx).find({
        from: c.entity,
        orderBy: orderBys.get(c.slug) ?? orderByOf(c),
        limit: input.limit ?? DEFAULT_COLLECTION_LIST_LIMIT,
        offset: input.offset,
      });
    }, { ...editor, input: listInput }),

    collectionGet: query(async (ctx, input: { collection: string; id: string }) => {
      const c = def(input.collection);
      const rows = await cdb(ctx).find({ from: c.entity, where: { [idOf(c)]: input.id }, limit: 1 });
      return rows[0] ?? null;
    }, { ...editor, input: rowInput }),

    collectionCreate: mutation((ctx, input: { collection: string; values: Record<string, unknown> }) => {
      const c = def(input.collection);
      const values = toColumns(c, input.values, true);
      // Seed the managed columns explicitly rather than leaning on a column default: the
      // entity belongs to the app, which may have declared `status` with no default (or a
      // NOT NULL one). A new row always starts as a draft — publishing is a separate,
      // separately-gated act.
      if (has(c, "drafts")) values.status = COLLECTION_DRAFT;
      if (has(c, "scheduling")) {
        values.publishedAt = null;
        values.scheduledAt = null;
        values.unpublishAt = null;
      }
      return cdb(ctx).insert(c.entity, values);
    }, { ...editor, input: valuesInput }),

    collectionUpdate: mutation(async (ctx, input: { collection: string; id: string; values: Record<string, unknown> }) => {
      const c = def(input.collection);
      const db = cdb(ctx);
      // Read the current row first: the editor autosaves the WHOLE values bag, so a
      // pre-Portable-Text richtext value rides along with an unrelated edit. It is
      // tolerated only when byte-identical to what is stored (see `legacyBaseline`).
      // A policy may grant `update` without `read` on the entity — that worked before this
      // pre-read existed, so it must not start 403ing. No baseline simply means a legacy
      // string is rejected, which is the strict default.
      let current: FieldValues | undefined;
      try {
        current = (await db.find({ from: c.entity, where: { [idOf(c)]: input.id }, limit: 1 }))[0] as FieldValues | undefined;
      } catch {
        current = undefined;
      }
      // Validate + whitelist the patch BEFORE snapshotting. `toColumns` throws on an invalid
      // patch, and on the DO that rollback is free (the mutation is one transaction) — but
      // `D1Driver.transaction` is a no-op, so snapshotting first meant a REJECTED edit still
      // committed a revision on D1: a phantom entry recording no change, and a burnt value
      // in the per-row `revision` counter.
      const patch = toColumns(c, input.values, false, current);
      // `current` is undefined only when the pre-read above was denied (an
      // update-without-read grant), in which case there is nothing to snapshot — the
      // revision is skipped rather than written empty.
      if (current) await snapshotRow(db, c, current as Record<string, unknown>, ctx, "edit");
      const updated = await db.update(c.entity, input.id, patch);
      if (updated === undefined) throw notFound(c.label);
      return updated;
    }, { ...editor, input: rowValuesInput }),

    collectionDelete: mutation(async (ctx, input: { collection: string; id: string }) => {
      const c = def(input.collection);
      const db = cdb(ctx);
      const ok = await db.delete(c.entity, input.id);
      if (!ok) throw notFound(c.label);
      // PURGE the row's revisions. Keeping them looks like free history, but a collection PK
      // can be a caller-chosen textId — recreating a row with the same id would inherit the
      // dead row's history, and `collectionRestoreRevision`'s scope check (collection +
      // rowId) would happily write the deleted row's content over the new one. It also
      // bounds the table: a collection has no trash, so nothing else ever collects these.
      //
      // Atomic with the delete on the DO (the mutation runs in storage.transaction). NOT on
      // the D1 store, where `transaction` is a no-op — a failure in between leaves orphan
      // revisions, which is exactly the inheritance above. Rare, and recoverable by
      // deleting the recreated row, but it is not a guarantee on that substrate.
      if (has(c, "revisions")) {
        await db.exec(`DELETE FROM ${COLLECTION_REVISIONS_TABLE} WHERE collection = ? AND rowId = ?`, c.slug, input.id);
      }
      return { ok: true as const };
    }, { ...editor, input: rowInput }),

    // ---- drafts -------------------------------------------------------------

    /** Move a row live. With `scheduling` this also stamps `publishedAt` (the column the
     * public read scope compares against `$now()`) and clears `scheduledAt` — which makes
     * any pending scheduled-publish task a no-op, since its intent token no longer matches.
     * A pending scheduled UNPUBLISH is deliberately left standing: publishing early does not
     * cancel a planned takedown. */
    collectionPublish: mutation(async (ctx, input: { collection: string; id: string }) => {
      const c = def(input.collection);
      needs(c, "drafts");
      const db = cdb(ctx);
      const row = await loadRow(db, c, input.id);
      // Deliberately NOT snapshotted. A revision records CONTENT, and publishing changes
      // none — the managed columns are excluded from `fields` by design, so a "publish"
      // revision was byte-identical to the edit before it, and restoring it wrote only the
      // declared fields and left the row live. That reads as a broken button; an entry that
      // cannot be restored is worse than no entry.
      const patch: Record<string, unknown> = { status: COLLECTION_PUBLISHED };
      if (has(c, "scheduling")) {
        const now = isoStamp();
        patch.publishedAt = now;
        patch.scheduledAt = null;
        // Clear a takedown instant that has already PASSED. This is an EXPLICIT act by a
        // human holding publish rights, which is why it resolves differently from the
        // scheduled-publish task: that one converges to the state the schedule implies (a
        // passed takedown wins, and the row lands down), while here the editor is saying
        // "live, now" about a takedown that has already been served. A future one stands —
        // publishing early does not cancel a planned removal — but a spent one is not
        // "pending" at all, and since the public scope now enforces
        // `unpublishAt IS NULL OR unpublishAt > $now()`, leaving it would make this very
        // publish a no-op: the editor gets back `status: "published"` and the row stays
        // invisible, with no error to explain it. That state is reachable whenever the
        // unpublish task never ran (tasks unwired, outbox dead-lettered, no D1 cron).
        if (typeof row.unpublishAt === "string" && row.unpublishAt <= now) patch.unpublishAt = null;
      }
      const updated = await db.update(c.entity, input.id, patch);
      if (updated === undefined) throw notFound(c.label);
      return updated;
    }, { ...editor, input: rowInput }),

    /** Take a row back to draft, clearing every schedule. Both tokens are cleared, so a
     * pending publish AND a pending unpublish both become no-ops — unpublishing is an
     * explicit "this is not live and nothing is queued to change that". */
    collectionUnpublish: mutation(async (ctx, input: { collection: string; id: string }) => {
      const c = def(input.collection);
      needs(c, "drafts");
      const db = cdb(ctx);
      await loadRow(db, c, input.id);
      const patch: Record<string, unknown> = { status: COLLECTION_DRAFT }; // not snapshotted — see collectionPublish
      if (has(c, "scheduling")) {
        patch.publishedAt = null;
        patch.scheduledAt = null;
        patch.unpublishAt = null;
      }
      const updated = await db.update(c.entity, input.id, patch);
      if (updated === undefined) throw notFound(c.label);
      return updated;
    }, { ...editor, input: rowInput }),

    // ---- scheduling ---------------------------------------------------------

    /** Schedule a future publish, and optionally a later unpublish. Mirrors `schedulePage`,
     * including the INTENT TOKEN: the row stores the scheduled instants
     * (`scheduledAt`/`unpublishAt`, ISO), the enqueued task carries a copy, and the task
     * runs only if the two still match. A reschedule overwrites the token, a manual
     * publish/unpublish clears it, and a duplicate delivery finds it already cleared — so a
     * superseded or cancelled schedule is a silent no-op rather than a surprise publish.
     *
     * The tasks are enqueued in THIS mutation's transaction (the outbox is transactional),
     * so a rolled-back schedule never leaves a task behind. They only run if you wired
     * `createCollectionTasks` into `app.tasks`. */
    collectionSchedule: mutation(async (ctx, input: { collection: string; id: string; publishAt: number; unpublishAt?: number | null }) => {
      const c = def(input.collection);
      needs(c, "scheduling");
      const db = cdb(ctx);
      const row = await loadRow(db, c, input.id);
      const now = Date.now();
      const publishToken = new Date(input.publishAt).toISOString();
      // Cross-call ordering. The boundary validator compares the two instants WITHIN one
      // call, which is not the invariant that matters: the documented way to move a publish
      // date is `collectionSchedule({ publishAt })` with `unpublishAt` omitted, and an
      // omitted takedown is left standing. Without this check a reschedule could push the
      // publish PAST a pending takedown — the takedown then fires first (clearing itself),
      // the publish fires after it against nothing, and the row is public with no takedown
      // left and no repair path. Compare against the takedown that will actually be in
      // effect: the one being written, or the one already stored.
      const effectiveUnpublish =
        input.unpublishAt !== undefined
          ? typeof input.unpublishAt === "number"
            ? new Date(input.unpublishAt).toISOString()
            : null
          : typeof row.unpublishAt === "string" && row.unpublishAt !== ""
            ? row.unpublishAt
            : null;
      if (effectiveUnpublish !== null && effectiveUnpublish <= publishToken) {
        throw new BadRequest(
          `publishAt (${publishToken}) is at or after the scheduled takedown (${effectiveUnpublish}) — move or cancel the takedown too (pass \`unpublishAt\`, or \`unpublishAt: null\` to cancel it)`,
        );
      }
      // PATCH semantics on the takedown: an ABSENT `unpublishAt` leaves an existing one
      // alone. Writing null unconditionally meant that merely moving the publish date
      // revoked a scheduled removal — and silently, since clearing the column also
      // neutralizes the already-enqueued task through the intent-token check. Pass
      // `unpublishAt: null` to cancel one deliberately.
      const hasUnpublish = input.unpublishAt !== undefined;
      const unpublishToken = typeof input.unpublishAt === "number" ? new Date(input.unpublishAt).toISOString() : null;
      const patch: Record<string, unknown> = { scheduledAt: publishToken };
      if (hasUnpublish) patch.unpublishAt = unpublishToken;
      // `loadRow` above goes through the READ scope; this goes through the UPDATE scope,
      // which can be narrower. Without the check a role that may read but not update the row
      // got `{ ok: true }` and two enqueued tasks over a write that never landed — the tasks
      // then found `scheduledAt` still null, mismatched their intent token, and no-op'd. A
      // confirmed schedule that silently never fires. Every sibling handler checks this.
      const updated = await db.update(c.entity, input.id, patch);
      if (updated === undefined) throw notFound(c.label);
      await ctx.tasks.enqueue({
        kind: TASK_COLLECTION_PUBLISH,
        payload: { collection: c.slug, id: input.id, token: publishToken },
        delayMs: Math.max(0, input.publishAt - now),
      });
      if (typeof input.unpublishAt === "number") {
        await ctx.tasks.enqueue({
          kind: TASK_COLLECTION_UNPUBLISH,
          payload: { collection: c.slug, id: input.id, token: unpublishToken },
          delayMs: Math.max(0, input.unpublishAt - now),
        });
      }
      return { ok: true as const, scheduledAt: publishToken, ...(hasUnpublish ? { unpublishAt: unpublishToken } : {}) };
    }, {
      ...editor,
      input: (raw): { collection: string; id: string; publishAt: number; unpublishAt?: number | null } => {
        const o = asObj(raw);
        const base = rowInput(raw);
        // Range-checked, not merely finite — see `epochInput`. An out-of-range value would
        // otherwise either throw a RangeError inside the transaction (an opaque 500) or
        // mint an expanded-year ISO string that compares backwards forever.
        const publishAt = epochInput("publishAt", o.publishAt);
        // `null` is the explicit "cancel the takedown"; absent leaves it untouched.
        if (o.unpublishAt !== undefined && o.unpublishAt !== null) {
          const unpublishAt = epochInput("unpublishAt", o.unpublishAt);
          if (unpublishAt <= publishAt) throw new BadRequest("unpublishAt must be after publishAt");
          return { ...base, publishAt, unpublishAt };
        }
        // Only `unpublishAt: null` (cancel) and an absent key reach here.
        return "unpublishAt" in o ? { ...base, publishAt, unpublishAt: null } : { ...base, publishAt };
      },
    }),

    // ---- revisions ----------------------------------------------------------

    /** A row's revision history, newest first. */
    collectionListRevisions: query(async (ctx, input: { collection: string; id: string; limit?: number }) => {
      const c = def(input.collection);
      needs(c, "revisions");
      const db = cdb(ctx);
      // Read the ROW through the ACL first. `cms_collection_revisions` is shared across
      // every collection and `collectionPolicies` grants it a flat allow(), so without this
      // a role holding narrower per-entity read policies could list the snapshots of a
      // collection it cannot read through `collectionGet`. `collectionRestoreRevision`
      // already had this via `loadRow`; the list path did not.
      const row = await loadRow(db, c, input.id);
      const revs = await db.find({
        from: COLLECTION_REVISIONS_TABLE,
        where: { collection: c.slug, rowId: input.id },
        // By the monotonic counter, never by a timestamp — see the `revision` column.
        orderBy: { column: "revision", dir: "desc" },
        limit: input.limit ?? 50,
      });
      // Project every snapshot to the fields THIS caller may read on the collection's own
      // entity. The row check above is a ROW-level gate, and `collectionPolicies` grants the
      // shared revisions table a flat allow() — so without this a caller holding a
      // FIELD-restricted read policy (`fields: ["id", "title", "status"]`) reads back the
      // columns that policy withholds, in full, out of the snapshot JSON. History must not
      // be a way around the field scope that governs the row itself.
      //
      // `loadRow` came through the ACL, and reads are column-projected, so its keys ARE the
      // caller's readable columns.
      const readable = new Set(Object.keys(row));
      return revs.map((r) => ({ ...r, snapshot: projectSnapshot(r.snapshot, readable) }));
    }, {
      ...editor,
      input: (raw): { collection: string; id: string; limit?: number } => {
        const o = asObj(raw);
        if (o.limit !== undefined && (typeof o.limit !== "number" || !Number.isFinite(o.limit))) throw new BadRequest("limit must be a number");
        // CLAMPED, not just validated: `find` binds this straight into `LIMIT ?`, and SQLite
        // reads a negative limit as UNBOUNDED — so `limit: -1` would dump a row's entire
        // history. A fractional value would reach the driver as-is.
        const limit = o.limit === undefined ? undefined : Math.max(1, Math.min(Math.floor(o.limit as number), 200));
        return { ...rowInput(raw), limit };
      },
    }),

    /** Restore a row to one of its revisions. The CURRENT state is snapshotted first, so a
     * restore is itself undoable. */
    collectionRestoreRevision: mutation(async (ctx, input: { collection: string; id: string; revisionId: string }) => {
      const c = def(input.collection);
      needs(c, "revisions");
      const db = cdb(ctx);
      const revs = await db.find({ from: COLLECTION_REVISIONS_TABLE, where: { id: input.revisionId }, limit: 1 });
      const rev = revs[0];
      // Scope the revision to THIS collection AND row. A revision id is otherwise a global
      // handle into a table shared by every collection, so an id from another row — or
      // another collection entirely — would write a foreign snapshot over this row.
      if (!rev || String(rev.collection) !== c.slug || String(rev.rowId) !== input.id) throw notFound("revision");
      const current = await loadRow(db, c, input.id);
      // A snapshot is built from an ACL-PROJECTED row, so a caller whose read scope excluded
      // every declared column stored `{}`. `Db.update` returns undefined for a zero-column
      // patch, which would surface below as "not found" for a row loaded two lines earlier —
      // a misleading 404. Say what is actually wrong instead.
      // Restore exactly the fields this caller can READ, for the same reason
      // `collectionListRevisions` projects them: the snapshot is complete (it was captured
      // through the raw path), and the shared revisions table is granted flat, so replaying
      // it whole would let a field-restricted editor write back columns their own read
      // policy withholds — restoring a value they cannot see, out of a version they cannot
      // read. What you can see is what you can put back.
      const visible = projectSnapshot(rev.snapshot, new Set(Object.keys(current)));
      const restore = toColumns(c, visible, false, current as FieldValues);
      if (Object.keys(restore).length === 0) {
        throw new BadRequest(`revision ${input.revisionId} has no restorable fields (none of its columns are readable by this caller)`);
      }
      await snapshotRow(db, c, current, ctx, "restore");
      // Replay through the SAME validate + whitelist as an ordinary write: a snapshot taken
      // before a field was dropped from `fields` must not resurrect that column, and one
      // taken before a field's type changed must not bypass validation.
      const updated = await db.update(c.entity, input.id, restore);
      if (updated === undefined) throw notFound(c.label);
      return updated;
    }, {
      ...editor,
      input: (raw): { collection: string; id: string; revisionId: string } => {
        const o = asObj(raw);
        if (typeof o.revisionId !== "string" || o.revisionId === "") throw new BadRequest("revisionId is required");
        return { ...rowInput(raw), revisionId: o.revisionId };
      },
    }),

    // ---- preview ------------------------------------------------------------

    /** Mint a signed link that shows ONE row's unpublished state, to whoever holds it.
     * Mirrors `signPagePreview` — same secret, same TTL clamp, same D1 refusal, and the
     * same rule that the row is read through the ACL FIRST: minting a link is granting
     * access to the row, so a caller who cannot read it must not be able to mint one. */
    signCollectionPreview: query(async (ctx, input: { collection: string; id: string; expiresIn?: number }) => {
      const c = def(input.collection);
      needs(c, "preview");
      const secret = previewSecret(ctx.env);
      if (!secret) throw previewUnconfigured(); // fail closed — never mint a forgeable link
      const row = await loadRow(cdb(ctx), c, input.id);
      const ttl = Math.max(60, Math.min(input.expiresIn ?? previewTtl, 30 * 24 * 3600));
      const exp = Math.floor(Date.now() / 1000) + ttl;
      // Server-resolved, never caller-supplied, so the tenant inside the signature cannot
      // be steered by whoever asks for the link.
      const token = await signToken<CollectionPreviewToken>({ t: ctx.tenant, c: c.slug, r: String(row[idOf(c)]), exp }, secret);
      // RELATIVE, like signed file urls — the client resolves it against the CMS origin.
      return { url: `${COLLECTION_PREVIEW_PATH}?token=${encodeURIComponent(token)}`, token, expiresAt: exp * 1000 };
    }, {
      ...editor,
      input: (raw): { collection: string; id: string; expiresIn?: number } => {
        const o = asObj(raw);
        if (o.expiresIn !== undefined && (typeof o.expiresIn !== "number" || !Number.isFinite(o.expiresIn))) {
          throw new BadRequest("expiresIn must be a number of seconds");
        }
        return { ...rowInput(raw), expiresIn: o.expiresIn as number | undefined };
      },
    }),

    /** Read one row's live (possibly unpublished) state. Not the redemption endpoint — that
     * is the public `GET /cms/preview/collection` route, which verifies the token and then
     * calls this privileged. Role-gated so it is not an anonymous back door on /rpc. */
    getCollectionPreview: query(async (ctx, input: { collection: string; id: string }) => {
      const c = def(input.collection);
      needs(c, "preview");
      const row = await loadRow(cdb(ctx), c, input.id);
      const values: Record<string, unknown> = { [idOf(c)]: row[idOf(c)] };
      for (const f of c.fields) if (f.name in row) values[f.name] = row[f.name];
      if (has(c, "drafts")) values.status = row.status;
      return { collection: c.slug, id: String(row[idOf(c)]), values };
    }, { ...viewer, input: rowInput }),
  };
}

/** ACL fragments granting the editor role full CRUD over each collection's entity. Spread
 * into your editor role next to `cmsPolicies().editor`:
 *
 *   role("editor", [...cmsPolicies().editor, ...collectionPolicies([lectures])])
 *
 * The generic collection handlers go through `ctx.db`, so without these the row ACL denies
 * them. Your app may already declare its own policies over the entity (e.g. a public read
 * scope) — these only ADD the editor grant the CMS UI needs. */
export function collectionPolicies(collections: readonly CollectionDef[], opts: CmsPolicyOpts = {}): Policy[] {
  const p = opts.prefix ?? "cms";
  const out: Policy[] = [];
  for (const c of collections) {
    for (const action of ["read", "create", "update", "delete"] as const) {
      out.push(policy(`${p}:editor:collection:${c.entity}:${action}`, c.entity, action, allow()));
    }
  }
  // The revision table is SHARED across collections, so it is not covered by the per-entity
  // grants above. Granting it here — rather than leaning on `cmsPolicies().editor` — keeps
  // `revisions` self-contained: an app that registers collections without using the
  // block/page half still gets a working feature instead of a 403 on every write. Read +
  // create only; a revision is append-only, and nothing exposes editing or purging one.
  if (collections.some((c) => (c.supports ?? []).includes("revisions"))) {
    for (const action of ["read", "create"] as const) {
      out.push(policy(`${p}:editor:${COLLECTION_REVISIONS_TABLE}:${action}`, COLLECTION_REVISIONS_TABLE, action, allow()));
    }
  }
  return out;
}

/** ACL fragments granting ANONYMOUS read of the PUBLISHED rows of every collection that
 * supports `drafts`. Spread into your public role next to `cmsPolicies().public`:
 *
 *   role("anonymous", [...cmsPolicies().public, ...collectionPublicPolicies(collections)])
 *
 * This is the access boundary, not a UI filter — it is AND-merged into every `ctx.db` read
 * of the entity, so an unpublished row is invisible to the public API, to relation
 * traversals and to eager-loads alike, without a single query remembering to filter.
 *
 * With `scheduling`, the scope also requires `publishedAt <= $now()`. `status` alone would
 * not be enough the moment anything writes a future `publishedAt`, and `{ publishedAt:
 * { isNull: false } }` — the obvious-looking alternative — matches a FUTURE timestamp too,
 * so a row scheduled for next week would be anonymously readable the moment it was saved.
 * The comparison is lexicographic over TEXT, which is why every managed timestamp is minted
 * as ISO-8601 UTC (`isoStamp`), the same shape `$now()` produces.
 *
 * Collections WITHOUT `drafts` get nothing here: they have no publish state, so their
 * public exposure is entirely your app's own policy to write. */
export function collectionPublicPolicies(collections: readonly CollectionDef[], opts: CmsPolicyOpts = {}): Policy[] {
  const p = opts.prefix ?? "cms";
  const out: Policy[] = [];
  for (const c of collections) {
    const features = c.supports ?? [];
    if (!features.includes("drafts")) continue;
    const name = `${p}:public:collection:${c.entity}:read`;
    // The PUBLIC surface is exactly what the collection declares as editable, plus its id
    // and the two columns a public page legitimately reads: `status` (constant `published`
    // for every visible row) and, with `scheduling`, `publishedAt`.
    //
    // Granting the whole row instead would quietly publish every future column: an
    // `internalNote` or `reviewerEmail` added to the entity — deliberately NOT a field —
    // would go world-readable the moment a row was published, with nothing at boot or in
    // review to catch it. But excluding `publishedAt` went too far the other way: the
    // single most obvious public query, "newest published first", 403s for anonymous while
    // working for an editor, because a caller may not order by a column it cannot read.
    // A publication date is public by construction — it is printed on the page. The
    // FORWARD-looking columns stay private: `scheduledAt` and `unpublishAt` would leak
    // "this comes down on Friday" to everyone.
    const fields = [c.idField ?? "id", ...c.fields.map((f) => f.name), "status", ...(features.includes("scheduling") ? ["publishedAt"] : [])];
    out.push(
      features.includes("scheduling")
        ? policy(name, c.entity, "read", {
            fields,
            where: {
              status: COLLECTION_PUBLISHED,
              // Both time clauses are OR-groups, so they go in an explicit `AND: [...]` —
              // two `OR` keys in one object literal would be the same property, and the
              // second would silently REPLACE the first.
              AND: [
                {
                  // `publishedAt <= $now()` alone silently hides every published row with
                  // no stamp — a `cmsBootstrap` seed, an import, a row published while the
                  // collection was still `supports: ["drafts"]` — and does it EN MASSE the
                  // moment `scheduling` is added to an existing collection, because
                  // `NULL <= '2026-…'` is NULL, not true. NULL here means "published,
                  // instant unknown", never "scheduled for later": `publishedAt` is a
                  // managed column (never in the write whitelist) that only ever takes
                  // `isoStamp()` or null, and a row awaiting a scheduled publish is
                  // `status: 'draft'` with the instant in `scheduledAt`. So a missing stamp
                  // cannot be a future one, and treating it as "already published" is both
                  // safe and what the editor already shows.
                  OR: [{ publishedAt: { isNull: true } }, { publishedAt: { lte: $now() } }],
                },
                {
                  // A scheduled TAKEDOWN has to be enforced HERE, not only by the task. The
                  // publish side is belt-and-braces (policy + task), but without this clause
                  // an unpublish depends entirely on `createCollectionTasks` being wired and
                  // the outbox draining — if either fails, a row an editor scheduled to come
                  // down stays world-readable indefinitely, with no signal. That is the
                  // wrong way round for a takedown, the direction that matters legally.
                  OR: [{ unpublishAt: { isNull: true } }, { unpublishAt: { gt: $now() } }],
                },
              ],
            },
          })
        : policy(name, c.entity, "read", { fields, where: { status: COLLECTION_PUBLISHED } }),
    );
  }
  return out;
}

/** Task handlers backing `collectionSchedule`. Register alongside `cmsTasks`:
 *
 *   const app = { tasks: { ...cmsTasks, ...createCollectionTasks(collections) } };
 *
 * WITHOUT THIS WIRING A SCHEDULE NEVER FIRES: `collectionSchedule` still stores the
 * instants and enqueues the tasks, but the drain finds no handler for their kind, so the
 * row silently stays a draft. (`cmsTasks` has the same requirement for page scheduling.)
 *
 * They run with a privileged, system-scoped ctx off the write path, and each validates its
 * INTENT TOKEN against the row's current `scheduledAt`/`unpublishAt` before acting — see
 * `collectionSchedule`. */
export function createCollectionTasks(collections: readonly CollectionDef[]) {
  const bySlug = new Map(collections.map((c) => [c.slug, c] as const));
  const run = async (
    ctx: HandlerContext,
    payload: unknown,
    tokenColumn: "scheduledAt" | "unpublishAt",
    buildPatch: (row: Record<string, unknown>, now: string) => Record<string, unknown>,
  ): Promise<void> => {
    const { collection, id, token } = asObj(payload) as { collection?: string; id?: string; token?: string };
    if (typeof collection !== "string" || typeof id !== "string") return;
    // Resolved through the REGISTRY, exactly as the handlers do — the payload's `collection`
    // is never used as a table name.
    const c = bySlug.get(collection);
    // A slug the handlers accept but this registry does not know is a WIRING mistake:
    // `createCollectionHandlers(collections)` and `createCollectionTasks(otherList)` built
    // from different arrays. Returning quietly made the drain report `{ succeeded: 1 }`
    // while the row stayed a draft forever — strictly worse than not registering the tasks
    // at all, which dead-letters loudly. Throw so the outbox retries and then dead-letters
    // with the slug in the message.
    if (!c) throw new Error(`pramen/cms: no collection '${collection}' in createCollectionTasks' registry — pass the SAME collections array to createCollectionHandlers and createCollectionTasks`);
    const db = cdb(ctx);
    const rows = await db.find({ from: c.entity, where: { [c.idField ?? "id"]: id }, limit: 1 });
    const row = rows[0];
    if (!row) return;
    // Intent check: act only if this task is still the row's active schedule. A reschedule
    // (new token), a manual publish/unpublish (token cleared) or a duplicate delivery after
    // this task already ran all make it a no-op.
    //
    // Require a NON-EMPTY token on both sides. Comparing the coalesced strings alone treats
    // "no token in the payload" and "no schedule on the row" as a MATCH — so a payload
    // without a token (a hand-drained or replayed outbox row) against a row whose
    // `scheduledAt` is null, the normal state right after an unpublish, would publish it
    // unconditionally. The guard should fail closed, not open.
    const stored = typeof row[tokenColumn] === "string" ? (row[tokenColumn] as string) : "";
    if (!token || !stored || stored !== token) return;
    await db.update(c.entity, id, buildPatch(row, isoStamp()));
  };
  return {
    [TASK_COLLECTION_PUBLISH]: (ctx: HandlerContext, payload: unknown) =>
      run(ctx, payload, "scheduledAt", (row, now) => {
        // CONVERGE to the state the schedule implies AT `now`, rather than blindly applying
        // the step this task was enqueued for. A drain can lag arbitrarily (D1 cron
        // granularity, outbox backoff, a stalled DO alarm), and the two tasks can arrive in
        // either order, so "publish" has to mean "publish IF the takedown has not come yet".
        //
        // The previous behavior — publish anyway, and null the passed `unpublishAt` to keep
        // the row visible — destroyed a scheduled takedown outright: the token the unpublish
        // task compares against was gone, so it no-op'd, and the read scope's
        // `unpublishAt IS NULL OR unpublishAt > $now()` backstop had nothing left to enforce.
        // A row scheduled to come down at noon stayed world-readable forever, silently.
        // A takedown that failing OPEN cannot be recovered from is the wrong way round.
        if (typeof row.unpublishAt === "string" && row.unpublishAt !== "" && row.unpublishAt <= now) {
          // Both instants are in the past: the row's whole scheduled life has elapsed.
          // Land on the END state (down), and spend both tokens so neither task can fire
          // against this schedule again.
          return { status: COLLECTION_DRAFT, publishedAt: null, scheduledAt: null, unpublishAt: null };
        }
        // The ordinary case: publish now, keep a still-future takedown standing.
        return { status: COLLECTION_PUBLISHED, publishedAt: now, scheduledAt: null };
      }),
    [TASK_COLLECTION_UNPUBLISH]: (ctx: HandlerContext, payload: unknown) =>
      // Clear `scheduledAt` too — the third column `collectionUnpublish` clears and this
      // task used to leave behind. A pending publish token that survived a takedown is a
      // live re-publish: if the publish task drains after this one (either order is
      // possible) or is retried after a throw, it finds its token still matching and puts
      // the row back up — with `unpublishAt` now null, permanently and with no repair path.
      // A schedule always orders publish BEFORE takedown (`collectionSchedule` enforces it
      // against the stored value as well as the submitted one), so any `scheduledAt` still
      // standing at the takedown is spent by definition.
      run(ctx, payload, "unpublishAt", () => ({ status: COLLECTION_DRAFT, publishedAt: null, scheduledAt: null, unpublishAt: null })),
  };
}

// --- deferred tasks (scheduled publish/unpublish) ----------------------------

/** Task handlers backing `schedulePage`. Register via `app.tasks = { ...cmsTasks }`.
 * They run with a privileged, system-scoped ctx off the write path (the outbox drain).
 *
 * Each task validates its INTENT TOKEN against the page's current `scheduledAt`/`unpublishAt`
 * (set by `schedulePage`, cleared/overwritten by a manual publish/unpublish or a reschedule).
 * A task whose token no longer matches is a no-op — that's how a superseded/cancelled
 * schedule, and an at-least-once duplicate delivery, are neutralized (outbox tasks can't be
 * recalled). NOTE on atomicity: unlike the interactive `publishPage` (one mutation
 * transaction), the drain runs a handler WITHOUT a surrounding transaction, so a crash
 * between the revision insert and the page update leaves the page unpublished with an orphan
 * revision until the next at-least-once redelivery re-runs (the token still matches, so it
 * completes). Acceptable for a scheduled job; the interactive path is atomic. */
export const cmsTasks = {
  "cms:publish": async (ctx: HandlerContext, payload: unknown) => {
    const { pageId, token } = asObj(payload) as { pageId?: string; token?: string };
    if (!pageId) return;
    const db = cdb(ctx);
    const rows = await db.find({ from: "cms_pages", where: { id: pageId }, limit: 1 });
    const page = rows[0];
    if (!page) return;
    // Intent check: only publish if this task is still the page's active schedule. A
    // reschedule (new token), a manual publish/unpublish (token cleared), or a duplicate
    // delivery after this task already ran (token cleared below) all make this a no-op.
    if (String(page.scheduledAt ?? "") !== String(token ?? "")) return;
    const from = String(page.status);
    await doPublish(db, page, null, "scheduled publish"); // actor null = system
    await db.insert("cms_audit", { pageId, action: "publish", fromStatus: from, toStatus: "published", actor: null, note: "scheduled" });
  },
  "cms:unpublish": async (ctx: HandlerContext, payload: unknown) => {
    const { pageId, token } = asObj(payload) as { pageId?: string; token?: string };
    if (!pageId) return;
    const db = cdb(ctx);
    const rows = await db.find({ from: "cms_pages", where: { id: pageId }, limit: 1 });
    const page = rows[0];
    if (!page) return;
    if (String(page.unpublishAt ?? "") !== String(token ?? "")) return; // superseded/cancelled
    const from = String(page.status);
    await db.update("cms_pages", pageId, { status: "archived", unpublishAt: null, updatedAt: nowStamp() });
    await db.insert("cms_audit", { pageId, action: "unpublish", fromStatus: from, toStatus: "archived", actor: null, note: "scheduled" });
  },
};

// --- SEO: sitemap.xml / robots.txt --------------------------------------------

export interface SitemapEntry {
  slug: string;
  locale: string;
  updatedAt?: string;
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export interface SitemapOpts {
  origin: string;
  /** Map an entry → its absolute URL. Default `${origin}/${locale}/${slug}`. */
  pageUrl?: (e: SitemapEntry, origin: string) => string;
}

/** Build a sitemap.xml body from published-page entries. */
export function sitemapXml(entries: SitemapEntry[], opts: SitemapOpts): string {
  const toUrl = opts.pageUrl ?? ((e, origin) => `${origin}/${e.locale}/${e.slug}`);
  const urls = entries
    .map((e) => {
      const loc = xmlEscape(toUrl(e, opts.origin));
      const lastmod = e.updatedAt ? `<lastmod>${xmlEscape(e.updatedAt.slice(0, 10))}</lastmod>` : "";
      return `  <url><loc>${loc}</loc>${lastmod}</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** Build a robots.txt body pointing at the sitemap. */
export function robotsTxt(opts: { origin: string; disallow?: string[] }): string {
  const dis = (opts.disallow ?? []).map((p) => `Disallow: ${p}`).join("\n");
  return `User-agent: *\n${dis ? dis + "\n" : "Allow: /\n"}Sitemap: ${opts.origin}/sitemap.xml\n`;
}

// Minimal shape of a pramen public route (see @pramen/server/worker app.routes).
interface RouteCtx {
  callPrivileged: (opts: { name: string; input?: JsonValue; tenant?: string; roles?: string[] }) => Promise<Response>;
}
interface CmsRoute {
  method: string;
  path: string;
  handler: (request: Request, env: EnvBag, ctx: RouteCtx) => Promise<Response>;
}

const previewJson = (status: number, code: string, message: string): Response =>
  // `{ ok, error, code }` — the shape every other pramen error uses (runtime/errors.ts).
  new Response(JSON.stringify({ ok: false, error: message, code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
/** One response for a missing, malformed, forged, or expired token — and for a page that
 * is not there. Distinguishing them would let a caller probe for valid page ids. */
const previewDenied = (status = 403, message = "invalid or expired preview link"): Response =>
  previewJson(status, status === 404 ? "not_found" : "forbidden", message);
const preview503 = (): Response =>
  previewJson(503, "unavailable", "page preview is not configured (set a strong PREVIEW_SECRET, FILES_SECRET or AUTH_SECRET)");

/** Turnkey public routes for `GET /sitemap.xml`, `GET /cms/preview` and `GET /robots.txt`. Spread into
 * `app.routes`. The sitemap pulls published pages via `callPrivileged(listPublishedPages)`.
 * `origin` defaults to the request's origin; `pageUrl` customizes the URL shape. */
export function cmsRoutes(
  opts: {
    origin?: string;
    tenant?: string;
    pageUrl?: SitemapOpts["pageUrl"];
    disallow?: string[];
    /** The SAME options you passed to `createCmsHandlers`. The route derives its identity
     * from them with `viewerRolesOf`, so the two cannot drift. (`viewerRoles` overrides it
     * outright if you need to.) */
    handlers?: CmsHandlerOpts;
    /** The SAME options you passed to `createCollectionHandlers`, if they differ from
     * `handlers`. The COLLECTION preview route has its own gate — `getCollectionPreview` is
     * built by `createCollectionHandlers`, so an app that passes different `editorRoles` /
     * `reviewerRoles` to the two factories would have the route present the page half's
     * roles to a handler gated on the collection half's, and every collection preview link
     * would 404 uniformly (the response is deliberately indistinguishable from "not
     * found"). Defaults to `handlers`, which is right whenever both got the same options. */
    collectionHandlers?: CmsHandlerOpts;
    /** Explicit override for the roles the preview routes present to the DO. */
    viewerRoles?: readonly string[];
  } = {},
): CmsRoute[] {
  const tenant = opts.tenant ?? "main";
  const previewRoles = opts.viewerRoles ?? viewerRolesOf(opts.handlers);
  const collectionPreviewRoles = opts.viewerRoles ?? viewerRolesOf(opts.collectionHandlers ?? opts.handlers);
  return [
    {
      method: "GET",
      path: "/sitemap.xml",
      handler: async (request, _env, ctx) => {
        const origin = opts.origin ?? new URL(request.url).origin;
        const res = await ctx.callPrivileged({ name: "listPublishedPages", tenant, roles: ["admin"] });
        const body = (await res.json().catch(() => ({}))) as { result?: SitemapEntry[] };
        const xml = sitemapXml(body.result ?? [], { origin, pageUrl: opts.pageUrl });
        return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
      },
    },
    {
      // Redeem a preview link. PUBLIC and pre-auth by design — the signature IS the
      // authorization, so a reviewer with no account can open it. The token is verified
      // BEFORE any read, and it names one page, so a valid signature never widens into
      // "see all drafts". Only then do we reach the DO, privileged.
      method: "GET",
      path: PREVIEW_PATH,
      handler: async (request, env, ctx) => {
        const secret = previewSecret(env);
        // Fail closed: with no usable secret every signature would verify against a weak
        // key, so refuse to verify at all rather than accept forged links.
        if (!secret) return preview503();
        const raw = new URL(request.url).searchParams.get("token");
        if (!raw) return previewDenied();
        const payload = await verifyToken<PreviewToken>(raw, secret);
        if (!payload || typeof payload.p !== "string" || typeof payload.t !== "string") return previewDenied();

        // The synthetic identity has to satisfy BOTH gates the DO applies: the handler's
        // `auth` (viewerRoles) and the row ACL (whatever role the app granted cmsPolicies
        // to). Hardcoding ["admin"] satisfied neither under the wiring this package's own
        // README documents — `role("anonymous", …)` + `role("editor", …)`, no admin role
        // at all — so every preview link 404'd. The e2e only passed because example/app.ts
        // happens to define an admin role. Send the configured viewer roles instead.
        const res = await ctx.callPrivileged({
          name: "getPagePreview",
          input: { pageId: payload.p },
          tenant: payload.t, // from the SIGNED payload, never from the query string
          roles: [...previewRoles],
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: JsonValue; error?: string; code?: string };
        if (body.ok !== true) {
          // The client-visible response stays uniform (probe resistance), but LOG the real
          // reason: a role misconfiguration previously surfaced as an indistinguishable
          // "page not found" that could only be diagnosed by reading source.
          console.error(`pramen/cms: preview redemption failed (${res.status} ${body.code ?? "?"}: ${body.error ?? "no detail"})`);
          return previewDenied(404, "page not found");
        }
        // Never cache a draft, anywhere.
        return new Response(JSON.stringify(body.result), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
        });
      },
    },
    {
      // Redeem a COLLECTION preview link. Same contract as the page preview route above:
      // public and pre-auth by design (the signature IS the authorization, so a reviewer
      // with no account can open it), verified BEFORE any read, and scoped by the signed
      // payload to one row of one collection — a valid signature never widens into "see
      // every draft".
      method: "GET",
      path: COLLECTION_PREVIEW_PATH,
      handler: async (request, env, ctx) => {
        const secret = previewSecret(env);
        // Fail closed: with no usable secret every signature would verify against a weak
        // key, so refuse to verify at all rather than accept forged links.
        if (!secret) return preview503();
        const raw = new URL(request.url).searchParams.get("token");
        if (!raw) return previewDenied();
        const payload = await verifyToken<CollectionPreviewToken>(raw, secret);
        if (!payload || typeof payload.c !== "string" || typeof payload.r !== "string" || typeof payload.t !== "string") return previewDenied();
        const res = await ctx.callPrivileged({
          name: "getCollectionPreview",
          input: { collection: payload.c, id: payload.r },
          tenant: payload.t, // from the SIGNED payload, never from the query string
          roles: [...collectionPreviewRoles], // the COLLECTION handlers' gate — see `collectionHandlers`
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: JsonValue; error?: string; code?: string };
        if (body.ok !== true) {
          // Uniform client-visible response (probe resistance), but LOG the real reason —
          // a role or wiring mistake here is otherwise indistinguishable from "not found".
          console.error(`pramen/cms: collection preview redemption failed (${res.status} ${body.code ?? "?"}: ${body.error ?? "no detail"})`);
          return previewDenied(404, "not found");
        }
        // Never cache a draft, anywhere.
        return new Response(JSON.stringify(body.result), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
        });
      },
    },
    {
      method: "GET",
      path: "/robots.txt",
      handler: async (request) => {
        const origin = opts.origin ?? new URL(request.url).origin;
        return new Response(robotsTxt({ origin, disallow: opts.disallow }), { headers: { "content-type": "text/plain; charset=utf-8" } });
      },
    },
  ];
}
