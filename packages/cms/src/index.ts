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
  BadRequest,
  Forbidden,
  PramenError,
} from "@pramen/server";
import type { HandlerContext, Policy, FileRef } from "@pramen/server";

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
  fields?: Record<string, unknown>;
}

// --- hybrid typed blocks: compile-time inference over a const FieldDefinition[] --------
//
// The data-driven half stores block field schemas as JSON rows (webmasters add types with
// no deploy). For DEVELOPER-authored blocks, `defineBlockType(slug, fields as const)` gives
// compile-time field typing with NO build step — a rendered block's `fields` is inferred from
// the schema, exactly like `typeof app.handlers` types the RPC client. (A `pramen cms codegen`
// command that emits these types from DB-stored schemas is future work.)

/** A rich-text value — a serialized editor document (or a plain string). */
export type RichText = string | { type: string; content?: unknown[] };

/** Map one FieldDefinition (as a const literal) to the TS type of its RENDERED value.
 * Media resolves to `ResolvedMedia` (the assemble-time shape a component receives). */
export type FieldTsType<D extends FieldDefinition> = D["type"] extends "text" | "textarea" | "url" | "select"
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
const tsFieldLine = (f: FieldDefinition): string => `${JSON.stringify(f.name)}${f.required ? "" : "?"}: ${tsTypeOf(f)};`;

/** Emit a `.ts` module of per-slug field interfaces + a `BlockFieldsBySlug` registry from
 * DB-stored block types (`{ slug, fieldsSchema }` rows). The runtime counterpart to the
 * compile-time `InferBlockFields`, for webmaster-authored (data-driven) block types. */
export function generateBlockTypes(blockTypes: Array<{ slug: string; fieldsSchema?: FieldDefinition[] | null }>): string {
  const interfaces = blockTypes
    .map((bt) => {
      const fields = Array.isArray(bt.fieldsSchema) ? bt.fieldsSchema : [];
      const body = fields.map((f) => `  ${tsFieldLine(f)}`).join("\n");
      return `export interface ${pascal(bt.slug)}Fields {\n${body}\n}`;
    })
    .join("\n\n");
  const registry = blockTypes.map((bt) => `  ${JSON.stringify(bt.slug)}: ${pascal(bt.slug)}Fields;`).join("\n");
  return (
    `// AUTO-GENERATED by @pramen/cms — do not edit.\n` +
    `import type { ResolvedMedia, RichText } from "@pramen/cms";\n\n` +
    `${interfaces}\n\nexport interface BlockFieldsBySlug {\n${registry}\n}\n`
  );
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
      // NOT globally unique — a slug is unique PER LOCALE (`/en/about` + `/cs/about`).
      // pramen's unique() is single-column only, so (slug, locale) uniqueness is enforced
      // in createPage/createTranslation; this index just speeds the lookup.
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
      // SEO
      metaTitle: t.text(),
      metaDescription: t.text(),
      canonicalUrl: t.text(),
      robots: t.text(), // e.g. "noindex, nofollow"
      ogTitle: t.text(),
      ogDescription: t.text(),
      ogImage: t.uuid(), // a cms_media id, resolved to a URL at assemble time
      structuredData: t.json(), // JSON-LD, emitted as-is into <head>
      createdAt: defaultTo(t.text(), expr.now()),
      updatedAt: defaultTo(t.text(), expr.now()),
    }),
    (r) => ({
      type: r.belongsTo("cms_content_types", "typeId"),
      placements: r.hasMany("cms_page_blocks", "pageId"),
    }),
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

  // Media: a fileRef column holds only R2 metadata; bytes live in R2, uploaded via
  // ctx.files + the Worker /files/* route. Block `fields` reference a media id.
  cms_media: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    file: t.fileRef(),
    alt: t.text(),
    createdAt: defaultTo(t.text(), expr.now()),
  })),
};

// --- field validation --------------------------------------------------------

/** Validate a block/page's `fields` payload against a field schema, throwing a 400 on
 * the first violation. Recursive (repeater/group). Lenient on unknown field types. */
export function validateFields(schema: FieldDefinition[] | undefined | null, values: unknown, path = ""): void {
  const defs = Array.isArray(schema) ? schema : [];
  const obj = (values ?? {}) as Record<string, unknown>;
  if (typeof obj !== "object" || Array.isArray(obj)) throw new BadRequest(`${path || "fields"} must be an object`);
  for (const def of defs) {
    const at = path ? `${path}.${def.name}` : def.name;
    const v = obj[def.name];
    const missing = v === undefined || v === null || v === "";
    if (missing) {
      if (def.required) throw new BadRequest(`field '${at}' is required`);
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
      case "richtext":
        if (typeof v !== "string" && typeof v !== "object") throw new BadRequest(`field '${at}' must be rich text`);
        break;
      case "number":
        if (typeof v !== "number") throw new BadRequest(`field '${at}' must be a number`);
        break;
      case "boolean":
        if (typeof v !== "boolean") throw new BadRequest(`field '${at}' must be a boolean`);
        break;
      case "media":
        if (typeof v !== "string" && typeof v !== "number") throw new BadRequest(`field '${at}' must be a media id`);
        break;
      case "group":
        validateFields(def.fields, v, at);
        break;
      case "repeater": {
        if (!Array.isArray(v)) throw new BadRequest(`field '${at}' must be a list`);
        if (def.min != null && v.length < def.min) throw new BadRequest(`field '${at}' needs at least ${def.min} item(s)`);
        if (def.max != null && v.length > def.max) throw new BadRequest(`field '${at}' allows at most ${def.max} item(s)`);
        v.forEach((item, i) => validateFields(def.fields, item, `${at}[${i}]`));
        break;
      }
      default:
        break; // unknown type — don't block
    }
  }
}

// --- assembled-page shape (the content-API result + revision snapshot) --------

export interface RenderedBlock {
  id: string;
  block_type: string;
  title: string | null;
  fields: Record<string, unknown>;
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
    translationGroupId: string | null;
    /** Published sibling locales of this page (for hreflang alternates). */
    translations: PageTranslation[];
    fields: Record<string, unknown> | null;
    /** Back-compat: mirrors seo.metaTitle/metaDescription. */
    metaTitle: string | null;
    metaDescription: string | null;
    seo: PageSeo;
  };
  regions: Record<string, RenderedBlock[]>;
}

// --- media -------------------------------------------------------------------

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
function collectMediaIds(fields: Record<string, unknown>, schema: FieldDefinition[] | undefined, acc: Set<string>): void {
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
  fields: Record<string, unknown>,
  schema: FieldDefinition[] | undefined,
  mediaById: Map<string, ResolvedMedia>,
): Record<string, unknown> {
  if (!Array.isArray(schema)) return fields;
  const out: Record<string, unknown> = { ...fields };
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
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
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
    const fields = { ...asObj(block.fields), ...(p.isShared ? asObj(p.overrides) : {}) };
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
      block_type: typeById.get(String(m.block.typeId))?.slug ?? "unknown",
      title: (m.block.title as string | null) ?? null,
      fields: resolveMediaFields(m.fields, m.schema, mediaById),
      is_shared: Boolean(m.p.isShared),
    });
  }
  return { page: pageMeta(page, await siblingTranslations(db, page), await resolveMediaId(db, page.ogImage)), regions };
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
 * the page at it. Shared by publishPage, approve, and the scheduled cms:publish task. */
async function doPublish(db: CmsDb, page: Record<string, unknown>, actor: string | null, note?: string): Promise<Record<string, unknown> | undefined> {
  const now = nowStamp();
  const snapshot = await assembleLive(db, { ...page, status: "published" });
  snapshot.page.status = "published";
  const rev = await db.insert("cms_page_revisions", { pageId: page.id, title: page.title, status: "published", snapshot, note: note ?? null, actor });
  return db.update("cms_pages", String(page.id), { status: "published", publishedAt: now, scheduledAt: null, currentRevisionId: rev.id, updatedAt: now });
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
function pageMeta(page: Record<string, unknown>, translations: PageTranslation[] = [], ogImage: ResolvedMedia | null = null): AssembledPage["page"] {
  const metaTitle = (page.metaTitle as string | null) ?? null;
  const metaDescription = (page.metaDescription as string | null) ?? null;
  return {
    id: String(page.id),
    title: String(page.title),
    slug: String(page.slug),
    status: String(page.status),
    locale: String(page.locale ?? "en"),
    translationGroupId: (page.translationGroupId as string | null) ?? null,
    translations,
    fields: (page.fields as Record<string, unknown> | null) ?? null,
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
  if (def.allowedTypes && !def.allowedTypes.includes(blockTypeSlug)) {
    throw new BadRequest(`block type '${blockTypeSlug}' is not allowed in region '${region}'`);
  }
}

// --- handlers ----------------------------------------------------------------

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

  // The caller's identity id (the audit actor), or null for a system/unauthenticated write.
  const actorOf = (ctx: HandlerContext): string | null => (typeof ctx.identity?.userId === "string" ? ctx.identity.userId : null);
  // Append an audit row for a workflow transition (synchronous, in the mutation's txn).
  const writeAudit = (db: CmsDb, e: { pageId: string; action: string; from?: string; to?: string; actor: string | null; note?: string }) =>
    db.insert("cms_audit", { pageId: e.pageId, action: e.action, fromStatus: e.from ?? null, toStatus: e.to ?? null, actor: e.actor, note: e.note ?? null });

  // (slug, locale) uniqueness is enforced here because pramen's unique() is single-column.
  const assertSlugFree = async (db: CmsDb, slug: string, locale: string, exceptId?: string): Promise<void> => {
    const rows = await db.exec(
      "SELECT id FROM cms_pages WHERE slug = ? AND locale = ? LIMIT 1",
      slug,
      locale,
    );
    if (rows[0] && String(rows[0].id) !== exceptId) throw new BadRequest(`slug '${slug}' already exists for locale '${locale}'`);
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
    }, editor),

    getMedia: query(async (ctx, input: { id: string }) => {
      const rows = await cdb(ctx).find({ from: "cms_media", where: { id: input.id }, limit: 1 });
      return rows[0] ?? null;
    }, {
      ...editor,
      input: (raw): { id: string } => {
        const o = asObj(raw);
        if (typeof o.id !== "string") throw new BadRequest("id is required");
        return o as never;
      },
    }),

    /** Delete a media row AND its R2 blob. (Automatic orphan sweeping — media no longer
     * referenced by any block — is future work; refs live inside opaque block JSON.) */
    deleteMedia: mutation(async (ctx, input: { id: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_media", where: { id: input.id }, limit: 1 });
      const media = rows[0];
      if (!media) throw notFound("media");
      const key = String(asObj(media.file).key ?? "");
      await db.delete("cms_media", input.id);
      if (key) await ctx.files.delete(key).catch(() => {});
      return { ok: true };
    }, {
      ...editor,
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
      const rows = await cdb(ctx).find({ from: "cms_pages", where: { status: "published" }, orderBy: { column: "updatedAt", dir: "desc" }, limit: 5000 });
      return rows.map((r) => ({ slug: String(r.slug), locale: String(r.locale ?? "en"), updatedAt: String(r.updatedAt ?? r.createdAt ?? "") }));
    }),

    /** Update a page's SEO fields (meta/canonical/robots/OpenGraph/JSON-LD). Editor-gated. */
    updatePageSeo: mutation(async (ctx, input: { pageId: string; metaTitle?: string | null; metaDescription?: string | null; canonicalUrl?: string | null; robots?: string | null; ogTitle?: string | null; ogDescription?: string | null; ogImage?: string | null; structuredData?: unknown }) => {
      const db = cdb(ctx);
      const patch: Record<string, unknown> = { updatedAt: nowStamp() };
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
        return o as never;
      },
    }),

    /** Create a page and auto-scaffold its content type's default blocks. */
    createPage: mutation(async (ctx, input: { typeId: string; title: string; slug: string; locale?: string; fields?: Record<string, unknown> }) => {
      const db = cdb(ctx);
      const ctRows = await db.find({ from: "cms_content_types", where: { id: input.typeId }, limit: 1 });
      const ct = ctRows[0];
      if (!ct) throw new BadRequest("unknown content type");
      validateFields(ct.fieldsSchema as FieldDefinition[] | undefined, input.fields ?? {}, "page.fields");
      const locale = input.locale ?? defaultLocale;
      await assertSlugFree(db, input.slug, locale);

      const page = await db.insert("cms_pages", {
        typeId: input.typeId,
        title: input.title,
        slug: input.slug,
        locale,
        fields: input.fields ?? {},
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
          validateFields(bts[0].fieldsSchema as FieldDefinition[] | undefined, d.fields ?? {});
          const block = await db.insert("cms_blocks", { typeId: bts[0].id, fields: d.fields ?? {} });
          const position = await nextPosition(db, String(page.id), d.region);
          await db.insert("cms_page_blocks", { pageId: page.id, blockId: block.id, region: d.region, position });
        } catch (e) {
          console.warn(`@pramen/cms: content type '${ct.slug}' default block (${d.blockTypeSlug} → ${d.region}) skipped: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return page;
    }, {
      ...editor,
      input: (raw): { typeId: string; title: string; slug: string; locale?: string; fields?: Record<string, unknown> } => {
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
      const existing = await db.find({ from: "cms_pages", where: { translationGroupId: src.translationGroupId, locale: input.locale }, limit: 1 });
      if (existing[0]) throw new BadRequest(`a '${input.locale}' translation already exists`);
      const slug = input.slug ?? String(src.slug);
      await assertSlugFree(db, slug, input.locale);
      return db.insert("cms_pages", {
        typeId: src.typeId,
        title: input.title ?? String(src.title),
        slug,
        locale: input.locale,
        translationGroupId: src.translationGroupId,
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
      if (!rows[0]) throw notFound("page");
      const group = await db.find({ from: "cms_pages", where: { translationGroupId: rows[0].translationGroupId } });
      return group.map((r) => ({ id: String(r.id), locale: String(r.locale ?? "en"), slug: String(r.slug), title: String(r.title), status: String(r.status) }));
    }, {
      ...editor,
      input: (raw): { pageId: string } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string") throw new BadRequest("pageId is required");
        return o as never;
      },
    }),

    /** Distinct locales present across all pages. */
    listLocales: query(async (ctx) => {
      const rows = await cdb(ctx).exec("SELECT DISTINCT locale FROM cms_pages ORDER BY locale");
      return rows.map((r) => String(r.locale ?? "en"));
    }, editor),

    // ---- blocks & placement ----
    /** Create a block instance and place it into a page region in one call (the common
     * editor action). Validates the fields against the block type's schema and the region
     * against the content type's allow-list. */
    addBlock: mutation(async (ctx, input: { pageId: string; blockTypeSlug: string; region: string; fields?: Record<string, unknown>; title?: string; position?: number; isReusable?: boolean }) => {
      const db = cdb(ctx);
      const pages = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const page = pages[0];
      if (!page) throw notFound("page");
      const bt = await loadBlockTypeBySlug(db, input.blockTypeSlug);
      await assertRegionAllows(db, page, input.region, input.blockTypeSlug);
      validateFields(bt.fieldsSchema as FieldDefinition[] | undefined, input.fields ?? {});

      const block = await db.insert("cms_blocks", {
        typeId: bt.id,
        title: input.title ?? null,
        fields: input.fields ?? {},
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
      input: (raw): { pageId: string; blockTypeSlug: string; region: string; fields?: Record<string, unknown>; title?: string; position?: number; isReusable?: boolean } => {
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
    placeBlock: mutation(async (ctx, input: { pageId: string; blockId: string; region: string; position?: number; overrides?: Record<string, unknown> }) => {
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
      if (input.overrides !== undefined) {
        validateFields(bts[0]?.fieldsSchema as FieldDefinition[] | undefined, { ...asObj(block.fields), ...input.overrides });
      }
      const position = input.position ?? (await nextPosition(db, input.pageId, input.region));
      return db.insert("cms_page_blocks", {
        pageId: input.pageId,
        blockId: input.blockId,
        region: input.region,
        position,
        isShared: true,
        overrides: input.overrides ?? null,
      });
    }, {
      ...editor,
      input: (raw): { pageId: string; blockId: string; region: string; position?: number; overrides?: Record<string, unknown> } => {
        const o = asObj(raw);
        if (typeof o.pageId !== "string" || typeof o.blockId !== "string" || typeof o.region !== "string") {
          throw new BadRequest("pageId, blockId and region are required");
        }
        return o as never;
      },
    }),

    /** Update a block's content (re-validated against its type's field schema). */
    updateBlock: mutation(async (ctx, input: { blockId: string; fields?: Record<string, unknown>; title?: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_blocks", where: { id: input.blockId }, limit: 1 });
      const block = rows[0];
      if (!block) throw notFound("block");
      if (input.fields !== undefined) {
        const bt = await db.find({ from: "cms_block_types", where: { id: block.typeId }, limit: 1 });
        validateFields(bt[0]?.fieldsSchema as FieldDefinition[] | undefined, input.fields);
      }
      const patch: Record<string, unknown> = { updatedAt: nowStamp() };
      if (input.fields !== undefined) patch.fields = input.fields;
      if (input.title !== undefined) patch.title = input.title;
      return db.update("cms_blocks", input.blockId, patch);
    }, {
      ...editor,
      input: (raw): { blockId: string; fields?: Record<string, unknown>; title?: string } => {
        const o = asObj(raw);
        if (typeof o.blockId !== "string") throw new BadRequest("blockId is required");
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
      const updated = await doPublish(db, page, actorOf(ctx), input.note);
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
      ...editor,
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
      const updated = await doPublish(db, page, actorOf(ctx), input.note);
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
    /** Fetch an assembled page by slug (+ locale). Anonymous callers get the published
     * snapshot (the ACL scopes `cms_pages` reads to `status = published`). Editors may pass
     * `preview: true` to assemble the current DRAFT live from the tables. `locale` defaults
     * to the configured default locale; a slug is unique per locale. */
    getPage: query(async (ctx, input: { slug: string; locale?: string; preview?: boolean }) => {
      const db = cdb(ctx);
      // Preview is an editor capability — gate it before the lookup so a non-editor gets a
      // clear 403 (rather than a 404 that merely reflects the published-only read scope).
      if (input.preview && !isEditor(ctx, editorRoles)) throw new Forbidden("preview requires an editor role");
      const locale = input.locale ?? defaultLocale;
      const rows = await db.find({ from: "cms_pages", where: { slug: input.slug, locale }, limit: 1 });
      const page = rows[0];
      if (!page) throw notFound("page"); // also the anonymous-vs-draft case: ACL yields no row

      if (input.preview) return assembleLive(db, page);
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
  const tables = ["cms_content_types", "cms_block_types", "cms_blocks", "cms_pages", "cms_page_blocks", "cms_page_revisions", "cms_media", "cms_audit"] as const;
  const editorPolicies: Policy[] = [];
  for (const table of tables) {
    for (const action of ["read", "create", "update", "delete"] as const) {
      editorPolicies.push(policy(`${p}:editor:${table}:${action}`, table, action, allow()));
    }
  }
  return {
    public: [
      // Only published pages are readable; the snapshot carries the content.
      policy(`${p}:public:pages:read`, "cms_pages", "read", { where: { status: "published" } }),
      // getPage reads the latest revision snapshot. Scope the grant by the revision's
      // PAGE being currently published (a relation-traversal where, compiled to a
      // subquery), so a revision of a later-unpublished/archived page is never publicly
      // readable — least-privilege even for a future revision-listing handler.
      policy(`${p}:public:revisions:read`, "cms_page_revisions", "read", { where: { page: { status: "published" } } }),
      // Media metadata is public (the bytes are separately gated by signed urls).
      policy(`${p}:public:media:read`, "cms_media", "read", allow()),
    ],
    editor: editorPolicies,
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
  callPrivileged: (opts: { name: string; input?: unknown; tenant?: string; roles?: string[] }) => Promise<Response>;
}
interface CmsRoute {
  method: string;
  path: string;
  handler: (request: Request, env: Readonly<Record<string, unknown>>, ctx: RouteCtx) => Promise<Response>;
}

/** Turnkey public routes for `GET /sitemap.xml` and `GET /robots.txt`. Spread into
 * `app.routes`. The sitemap pulls published pages via `callPrivileged(listPublishedPages)`.
 * `origin` defaults to the request's origin; `pageUrl` customizes the URL shape. */
export function cmsRoutes(opts: { origin?: string; tenant?: string; pageUrl?: SitemapOpts["pageUrl"]; disallow?: string[] } = {}): CmsRoute[] {
  const tenant = opts.tenant ?? "main";
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
      method: "GET",
      path: "/robots.txt",
      handler: async (request) => {
        const origin = opts.origin ?? new URL(request.url).origin;
        return new Response(robotsTxt({ origin, disallow: opts.disallow }), { headers: { "content-type": "text/plain; charset=utf-8" } });
      },
    },
  ];
}
