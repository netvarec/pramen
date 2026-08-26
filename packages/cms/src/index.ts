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
  BadRequest,
  Forbidden,
  PramenError,
  Conflict,
  signToken,
  verifyToken,
  resolveSecret,
} from "@pramen/server";
import type { HandlerContext, Policy, FileRef, BootstrapFn, JsonValue, SchemaDef } from "@pramen/server";
import type { EnvBag } from "@pramen/server";
import { isSafeHref, normalizeHref } from "./href";

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
  return { slug, name: opts.name ?? slug, fieldsSchema: fields, description: opts.description, icon: opts.icon, category: opts.category };
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
  return { slug, name: opts.name ?? slug, description: opts.description, fields: opts.fields, regions: opts.regions, defaultBlocks: opts.defaultBlocks };
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

/** Build a pramen `bootstrap` reconciler that upserts code-defined block + content types by
 * `slug` on each boot. Idempotent: inserts a missing type, updates a drifted one, leaves an
 * identical one untouched. Register it on your app:
 *
 *   export const app = { schema, handlers, acl, tasks,
 *     bootstrap: [ cmsBootstrap({ blockTypes: [...], contentTypes: [...] }) ] };
 *
 * Runs with a privileged system Db, so a fresh/reprovisioned database converges to the
 * code-declared types with no manual createContentType/createBlockType call. */
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
      });
    }
    for (const ct of defs.contentTypes ?? []) {
      await upsertBySlug(sys, "cms_content_types", ct.slug, {
        name: ct.name,
        slug: ct.slug,
        description: ct.description ?? null,
        fieldsSchema: ct.fields ?? [],
        regions: ct.regions ?? [],
        defaultBlocks: ct.defaultBlocks ?? [],
      });
    }
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
export const cmsSchema = {
  cms_content_types: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    name: notNull(t.text()),
    slug: unique(notNull(t.text())),
    description: t.text(),
    fieldsSchema: t.json(), // FieldDefinition[] for page-level fields
    regions: t.json(), // RegionDefinition[]
    defaultBlocks: t.json(), // DefaultBlockDefinition[]
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
      typeId: notNull(t.uuid()),
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
      // land in the same second (expr.now() is second-precision).
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
    snapshot: t.json(),
    note: t.text(),
    actor: t.text(),
    createdAt: defaultTo(t.text(), expr.now()),
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
  }): Promise<Array<Record<string, unknown>>>;
  insert(table: string, values: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(table: string, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  delete(table: string, id: string): Promise<boolean>;
  exec(sql: string, ...params: unknown[]): Promise<Array<Record<string, unknown>>>;
}
const cdb = (ctx: HandlerContext): CmsDb => ctx.db as unknown as CmsDb;

const notFound = (what: string) => new PramenError(`${what} not found`, 404, "not_found");
const asObj = (v: unknown): FieldValues => (v && typeof v === "object" ? (v as FieldValues) : {});
// Timestamps in the SAME shape as the `expr.now()` column default (`datetime('now')`:
// "YYYY-MM-DD HH:MM:SS", UTC, second precision) so a column's insert-default and its
// handler-written updates stay lexically comparable (an ISO `T`/`Z` string sorts wrong).
const nowStamp = (): string => new Date().toISOString().slice(0, 19).replace("T", " ");
const isEditor = (ctx: HandlerContext, roles: readonly string[]): boolean => {
  const held = ctx.identity?.roles ?? (ctx.identity?.role ? [ctx.identity.role] : []);
  return (held as string[]).some((r) => roles.includes(r));
};

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

export interface CmsHandlerOpts {
  /** Roles permitted to call the editor mutations (also enforced by the ACL). Default
   * `["editor", "admin"]`. */
  editorRoles?: readonly string[];
  /** Max accepted media upload size in bytes (enforced at the Worker). Default 25 MB. */
  mediaMaxSize?: number;
  /** Default locale used when `getPage`/`createPage` omit one. Default `"en"`. */
  defaultLocale?: string;
  /** Roles permitted to approve/reject a page in review and publish (the editorial gate).
   * Default `["reviewer", "admin"]`. */
  reviewerRoles?: readonly string[];
  /** Preview-link lifetime in seconds. Default 3600 (1 hour). */
  previewTtlSeconds?: number;
  /** The node/mark vocabulary accepted on write. Defaults to `DEFAULT_RICH_TEXT_SCHEMA`
   * (what the shipped editor produces). Widen it if your editor adds TipTap extensions —
   * a node type absent from the schema is DROPPED on write, not rejected. */
  richTextSchema?: RichTextSchema;
}

/** Build the CMS handler map. Spread into your app's handlers. Editor mutations are
 * gated both by `auth` (fast 403 before the body) and by the row ACL (cmsPolicies). */
export function createCmsHandlers(opts: CmsHandlerOpts = {}) {
  const editorRoles = opts.editorRoles ?? ["editor", "admin"];
  const editor = { auth: editorRoles };
  const mediaMaxSize = opts.mediaMaxSize ?? 25_000_000;
  const defaultLocale = opts.defaultLocale ?? "en";
  const reviewerRoles = opts.reviewerRoles ?? ["reviewer", "admin"];
  const reviewer = { auth: reviewerRoles };
  const previewTtl = opts.previewTtlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS;
  const rtSchema = opts.richTextSchema ?? DEFAULT_RICH_TEXT_SCHEMA;
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
  const assertSlugFree = async (db: CmsDb, slug: string, locale: string, exceptId?: string): Promise<void> => {
    const rows = await db.exec(
      "SELECT id, deletedAt FROM cms_pages WHERE slug = ? AND locale = ? LIMIT 1",
      slug,
      locale,
    );
    if (rows[0] && String(rows[0].id) !== exceptId) {
      // A trashed page keeps its slug until purged (the (slug, locale) unique index is a
      // DB constraint, not advisory). Say so, rather than leave the caller hunting for a
      // page they cannot see.
      if (rows[0].deletedAt != null) {
        throw new BadRequest(`slug '${slug}' is held by a page in the trash for locale '${locale}' — restore or purge it first`);
      }
      throw new BadRequest(`slug '${slug}' already exists for locale '${locale}'`);
    }
  };

  const TASK_PUBLISH = "cms:publish";
  const TASK_UNPUBLISH = "cms:unpublish";

  return {
    // ---- block types & content types (data-driven definitions) ----
    listBlockTypes: query((ctx) => cdb(ctx).find({ from: "cms_block_types", orderBy: { column: "name" } })),

    createBlockType: mutation(async (ctx, input: { name: string; slug: string; fieldsSchema?: FieldDefinition[]; icon?: string; category?: string; description?: string }) => {
      return cdb(ctx).insert("cms_block_types", {
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
        return o as never;
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
        if (!Array.isArray(o.regions) || o.regions.length === 0) throw new BadRequest("at least one region is required");
        return o as never;
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
        return o as never;
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
      const patch: Record<string, unknown> = {};
      for (const k of ["name", "regions", "fieldsSchema", "defaultBlocks"] as const) {
        if (k in input) patch[k] = (input as Record<string, unknown>)[k];
      }
      return db.update("cms_content_types", String(row.id), patch);
    }, {
      ...editor,
      input: (raw): { id?: string; slug?: string; name?: string; regions?: RegionDefinition[]; fieldsSchema?: FieldDefinition[]; defaultBlocks?: DefaultBlockDefinition[] } => {
        const o = asObj(raw);
        if (typeof o.id !== "string" && typeof o.slug !== "string") throw new BadRequest("id or slug is required");
        return o as never;
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
    listPages: query((ctx) => cdb(ctx).find({ from: "cms_pages", orderBy: { column: "createdAt", dir: "desc" }, limit: 100 })),

    /** Public: list published pages (slug, locale, updatedAt) for sitemap generation. The
     * anonymous ACL scopes cms_pages reads to status=published, so this is safe to expose. */
    listPublishedPages: query(async (ctx) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { status: "published" }, orderBy: { column: "updatedAt", dir: "desc" }, limit: 5000 });
      // Join typeId → content-type slug so a frontend can route/filter by type (e.g. articles
      // vs pages) without a second round-trip.
      const typeIds = [...new Set(rows.map((r) => r.typeId).filter((v): v is string => typeof v === "string"))];
      const types = typeIds.length ? await db.find({ from: "cms_content_types", where: { id: { in: typeIds } } }) : [];
      const slugById = new Map(types.map((t) => [String(t.id), String(t.slug)]));
      return rows.map((r) => ({ slug: String(r.slug), locale: String(r.locale ?? "en"), contentType: slugById.get(String(r.typeId)) ?? null, updatedAt: String(r.updatedAt ?? r.createdAt ?? "") }));
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

    /** Distinct locales present across all pages. */
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
      if (ctx.store === "d1") throw new PramenError("page preview is not available on the D1 store (redemption requires the Durable Object)", 503, "unavailable");
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
  const tables = ["cms_content_types", "cms_block_types", "cms_blocks", "cms_pages", "cms_page_blocks", "cms_page_revisions", "cms_media", "cms_audit", "cms_collection_revisions"] as const;
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
// It is deliberately NOT `nowStamp()` (`expr.now()`'s "YYYY-MM-DD HH:MM:SS"), which sorts
// against the ISO form as if hours apart. Minting in one place is what closes the trap
// documented on the `publish` field: there, `publish` and `datetime` wrote different
// formats into the same TEXT column and both passed validation.

/** A workflow feature a collection can opt into.
 *
 * - `drafts` — a managed `status` column (`draft` | `published`) plus `collectionPublish` /
 *   `collectionUnpublish`. Pair with `collectionPublicPolicies` so anonymous reads see
 *   published rows only.
 * - `scheduling` — managed `publishedAt` / `scheduledAt` / `unpublishAt`, `collectionSchedule`,
 *   and the deferred tasks from `createCollectionTasks`. Needs `drafts`.
 * - `revisions` — a snapshot of the row's prior state on every write, in
 *   `cms_collection_revisions`, with `collectionListRevisions` / `collectionRestoreRevision`.
 * - `preview` — signed, single-row preview links (`signCollectionPreview`), redeemed at
 *   `COLLECTION_PREVIEW_PATH` by the route `cmsRoutes()` serves. Needs `drafts`. */
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

/** An ISO-8601 UTC instant — the one format every managed collection timestamp is written
 * in, so it compares correctly against `$now()`. See the note above on why this is not
 * `nowStamp()`. */
const isoStamp = (): string => new Date().toISOString();

/** Check a collection registry at BOOT: slugs are unique, features are known and have
 * their prerequisites, and every managed column actually exists on the target entity and
 * is not also an editable field.
 *
 * Called by `createCollectionHandlers`. The point is that a misconfiguration surfaces when
 * the Worker starts, naming the collection and the missing column — not as a 500 the first
 * time an editor presses Publish, months later, on the one collection nobody exercised.
 *
 * `schema` is REQUIRED as soon as any collection declares `supports`: without it the column
 * checks cannot run, and silently skipping them would defeat the purpose. */
export function validateCollections(collections: readonly CollectionDef[], schema?: SchemaDef): void {
  const seen = new Set<string>();
  for (const c of collections) {
    if (seen.has(c.slug)) throw new Error(`pramen/cms: duplicate collection slug '${c.slug}' — slugs are the handler registry's key`);
    seen.add(c.slug);
  }
  const withFeatures = collections.filter((c) => (c.supports?.length ?? 0) > 0);
  if (withFeatures.length === 0) return;
  if (!schema) {
    const names = withFeatures.map((c) => `'${c.slug}'`).join(", ");
    throw new Error(
      `pramen/cms: collection(s) ${names} declare \`supports\`, so createCollectionHandlers needs the schema to check their managed columns: createCollectionHandlers(collections, { schema })`,
    );
  }
  for (const c of withFeatures) {
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
    const columns = entity.fields as Record<string, unknown>;
    const idField = c.idField ?? "id";
    if (!(idField in columns)) {
      throw new Error(`pramen/cms: collection '${c.slug}' has idField '${idField}', which is not a column on '${c.entity}'`);
    }
    const declared = new Set(c.fields.map((f) => f.name));
    for (const f of features) {
      for (const col of COLLECTION_FEATURE_COLUMNS[f]) {
        if (!(col in columns)) {
          throw new Error(
            `pramen/cms: collection '${c.slug}' declares '${f}', which manages a \`${col}\` column on '${c.entity}' — add \`${col}: t.text()\` to the entity`,
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
    if (set.has("revisions") && !schema[COLLECTION_REVISIONS_TABLE]) {
      throw new Error(
        `pramen/cms: collection '${c.slug}' declares 'revisions', which needs the \`${COLLECTION_REVISIONS_TABLE}\` table — spread \`cmsSchema\` into defineSchema`,
      );
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
  /** Your app's schema (the object you pass to `defineSchema`). REQUIRED once any
   * collection declares `supports`: the managed columns are checked against it at boot by
   * `validateCollections`, so a missing `status` column is a startup error naming the
   * collection rather than a 500 on the first publish. */
  schema?: SchemaDef;
}

/** Build generic CRUD handlers over the registered collections. Spread into your app's
 * handlers alongside `cmsHandlers`:
 *
 *   const handlers = { ...cmsHandlers, ...createCollectionHandlers([lectures]) };
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
  const idOf = (c: CollectionDef): string => c.idField ?? "id";
  const has = (c: CollectionDef, f: CollectionFeature): boolean => (c.supports ?? []).includes(f);
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
  /** Snapshot a row's CURRENT (pre-write) state into `cms_collection_revisions`, so a
   * revision always reads as "what it was before this edit" and restoring one is a plain
   * reversal. Declared fields only — the snapshot is replayed through the same write
   * whitelist on restore, so it can never carry a column the collection doesn't own.
   * No-op unless the collection supports `revisions`. */
  const snapshotRow = async (db: CmsDb, c: CollectionDef, row: Record<string, unknown>, ctx: HandlerContext, note: string): Promise<void> => {
    if (!has(c, "revisions")) return;
    const values: Record<string, unknown> = {};
    for (const f of c.fields) if (f.name in row) values[f.name] = row[f.name];
    await db.insert(COLLECTION_REVISIONS_TABLE, {
      collection: c.slug,
      rowId: String(row[idOf(c)]),
      snapshot: values,
      note,
      actor: typeof ctx.identity?.userId === "string" ? ctx.identity.userId : null,
    });
  };
  /** Shared input validator for the `{ collection, id }` workflow handlers. */
  const rowInput = (raw: unknown): { collection: string; id: string } => {
    const o = asObj(raw);
    if (typeof o.collection !== "string" || o.collection === "") throw new BadRequest("collection is required");
    return { collection: o.collection, id: idInput(raw) };
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
      const limit = typeof input.limit === "number" ? input.limit : 100;
      const offset = typeof input.offset === "number" ? input.offset : undefined;
      return cdb(ctx).find({ from: c.entity, orderBy: c.orderBy ?? { column: "createdAt", dir: "desc" }, limit, offset });
    }, editor),

    collectionGet: query(async (ctx, input: { collection: string; id: string }) => {
      const c = def(input.collection);
      const rows = await cdb(ctx).find({ from: c.entity, where: { [idOf(c)]: input.id }, limit: 1 });
      return rows[0] ?? null;
    }, editor),

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
    }, editor),

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
      // Snapshot BEFORE the write. `current` is undefined only when the pre-read above was
      // denied (update-without-read grant), in which case there is nothing to snapshot —
      // the revision is skipped rather than written empty.
      if (current) await snapshotRow(db, c, current as Record<string, unknown>, ctx, "edit");
      const updated = await db.update(c.entity, input.id, toColumns(c, input.values, false, current));
      if (updated === undefined) throw notFound(c.label);
      return updated;
    }, editor),

    collectionDelete: mutation(async (ctx, input: { collection: string; id: string }) => {
      const c = def(input.collection);
      const db = cdb(ctx);
      // Snapshot first when the collection keeps revisions: a delete is the one write whose
      // prior state is otherwise unrecoverable. (A collection has no trash — that is
      // `cms_pages`' soft delete, not this.)
      if (has(c, "revisions")) {
        const rows = await db.find({ from: c.entity, where: { [idOf(c)]: input.id }, limit: 1 });
        if (rows[0]) await snapshotRow(db, c, rows[0], ctx, "delete");
      }
      const ok = await db.delete(c.entity, input.id);
      if (!ok) throw notFound(c.label);
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
      await snapshotRow(db, c, row, ctx, "publish");
      const patch: Record<string, unknown> = { status: COLLECTION_PUBLISHED };
      if (has(c, "scheduling")) {
        patch.publishedAt = isoStamp();
        patch.scheduledAt = null;
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
      const row = await loadRow(db, c, input.id);
      await snapshotRow(db, c, row, ctx, "unpublish");
      const patch: Record<string, unknown> = { status: COLLECTION_DRAFT };
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
    collectionSchedule: mutation(async (ctx, input: { collection: string; id: string; publishAt: number; unpublishAt?: number }) => {
      const c = def(input.collection);
      needs(c, "scheduling");
      const db = cdb(ctx);
      await loadRow(db, c, input.id);
      const now = Date.now();
      const publishToken = new Date(input.publishAt).toISOString();
      const unpublishToken = input.unpublishAt !== undefined ? new Date(input.unpublishAt).toISOString() : null;
      await db.update(c.entity, input.id, { scheduledAt: publishToken, unpublishAt: unpublishToken });
      await ctx.tasks.enqueue({
        kind: TASK_COLLECTION_PUBLISH,
        payload: { collection: c.slug, id: input.id, token: publishToken },
        delayMs: Math.max(0, input.publishAt - now),
      });
      if (input.unpublishAt !== undefined) {
        await ctx.tasks.enqueue({
          kind: TASK_COLLECTION_UNPUBLISH,
          payload: { collection: c.slug, id: input.id, token: unpublishToken },
          delayMs: Math.max(0, input.unpublishAt - now),
        });
      }
      return { ok: true as const, scheduledAt: publishToken, unpublishAt: unpublishToken };
    }, {
      ...editor,
      input: (raw): { collection: string; id: string; publishAt: number; unpublishAt?: number } => {
        const o = asObj(raw);
        const base = rowInput(raw);
        // Unvalidated, a non-finite publishAt makes `new Date(x).toISOString()` throw a
        // RangeError inside the transaction — a 500 with no indication of which input was
        // wrong.
        if (typeof o.publishAt !== "number" || !Number.isFinite(o.publishAt)) throw new BadRequest("publishAt must be a finite epoch ms");
        if (o.unpublishAt !== undefined) {
          if (typeof o.unpublishAt !== "number" || !Number.isFinite(o.unpublishAt)) throw new BadRequest("unpublishAt must be a finite epoch ms");
          if (o.unpublishAt <= o.publishAt) throw new BadRequest("unpublishAt must be after publishAt");
        }
        return { ...base, publishAt: o.publishAt, unpublishAt: o.unpublishAt as number | undefined };
      },
    }),

    // ---- revisions ----------------------------------------------------------

    /** A row's revision history, newest first. */
    collectionListRevisions: query(async (ctx, input: { collection: string; id: string; limit?: number }) => {
      const c = def(input.collection);
      needs(c, "revisions");
      return cdb(ctx).find({
        from: COLLECTION_REVISIONS_TABLE,
        where: { collection: c.slug, rowId: input.id },
        orderBy: { column: "createdAt", dir: "desc" },
        limit: input.limit ?? 50,
      });
    }, {
      ...editor,
      input: (raw): { collection: string; id: string; limit?: number } => {
        const o = asObj(raw);
        if (o.limit !== undefined && (typeof o.limit !== "number" || !Number.isFinite(o.limit))) throw new BadRequest("limit must be a number");
        return { ...rowInput(raw), limit: o.limit as number | undefined };
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
      await snapshotRow(db, c, current, ctx, "restore");
      // Replay through the SAME validate + whitelist as an ordinary write: a snapshot taken
      // before a field was dropped from `fields` must not resurrect that column, and one
      // taken before a field's type changed must not bypass validation.
      const updated = await db.update(c.entity, input.id, toColumns(c, rev.snapshot, false, current as FieldValues));
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
      // Redemption always reaches a Durable Object (callPrivileged -> PRAMEN.get) and has no
      // notion of `x-pramen-store`, so a link minted on D1 would 404 forever while the
      // editor reported success.
      if (ctx.store === "d1") {
        throw new PramenError("collection preview is not available on the D1 store (redemption requires the Durable Object)", 503, "unavailable");
      }
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
    out.push(
      features.includes("scheduling")
        ? policy(name, c.entity, "read", { where: { status: COLLECTION_PUBLISHED, publishedAt: { lte: $now() } } })
        : policy(name, c.entity, "read", { where: { status: COLLECTION_PUBLISHED } }),
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
    patch: Record<string, unknown>,
  ): Promise<void> => {
    const { collection, id, token } = asObj(payload) as { collection?: string; id?: string; token?: string };
    if (typeof collection !== "string" || typeof id !== "string") return;
    // Resolved through the REGISTRY, exactly as the handlers do — the payload's `collection`
    // is never used as a table name. A task naming a collection that has since been removed
    // from the registry is dropped, not executed against a guessed table.
    const c = bySlug.get(collection);
    if (!c) return;
    const db = cdb(ctx);
    const rows = await db.find({ from: c.entity, where: { [c.idField ?? "id"]: id }, limit: 1 });
    const row = rows[0];
    if (!row) return;
    // Intent check: act only if this task is still the row's active schedule. A reschedule
    // (new token), a manual publish/unpublish (token cleared) or a duplicate delivery after
    // this task already ran all make it a no-op.
    if (String(row[tokenColumn] ?? "") !== String(token ?? "")) return;
    await db.update(c.entity, id, patch);
  };
  return {
    [TASK_COLLECTION_PUBLISH]: (ctx: HandlerContext, payload: unknown) =>
      run(ctx, payload, "scheduledAt", { status: COLLECTION_PUBLISHED, publishedAt: isoStamp(), scheduledAt: null }),
    [TASK_COLLECTION_UNPUBLISH]: (ctx: HandlerContext, payload: unknown) =>
      run(ctx, payload, "unpublishAt", { status: COLLECTION_DRAFT, publishedAt: null, unpublishAt: null }),
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
    /** Explicit override for the roles the preview route presents to the DO. */
    viewerRoles?: readonly string[];
  } = {},
): CmsRoute[] {
  const tenant = opts.tenant ?? "main";
  const previewRoles = opts.viewerRoles ?? viewerRolesOf(opts.handlers);
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
          roles: [...previewRoles],
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
