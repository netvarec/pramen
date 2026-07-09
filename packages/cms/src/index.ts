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
  defaultTo,
  expr,
  policy,
  allow,
  BadRequest,
  Forbidden,
  PramenError,
} from "@pramen/server";
import type { HandlerContext, Policy } from "@pramen/server";

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
      slug: unique(notNull(t.text())),
      status: defaultTo(t.text(), "draft"), // draft | published | archived
      locale: defaultTo(t.text(), "en"),
      fields: t.json(),
      publishedAt: t.text(),
      scheduledAt: t.text(),
      unpublishAt: t.text(),
      // The revision the public content API serves — set on publish. A direct pointer
      // (not "latest by timestamp") so selection is deterministic even when two publishes
      // land in the same second (expr.now() is second-precision).
      currentRevisionId: t.uuid(),
      metaTitle: t.text(),
      metaDescription: t.text(),
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
      createdAt: defaultTo(t.text(), expr.now()),
    }),
    (r) => ({ page: r.belongsTo("cms_pages", "pageId") }),
  ),

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

export interface AssembledPage {
  page: {
    id: string;
    title: string;
    slug: string;
    status: string;
    locale: string;
    fields: Record<string, unknown> | null;
    metaTitle: string | null;
    metaDescription: string | null;
  };
  regions: Record<string, RenderedBlock[]>;
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
  const slugByTypeId = new Map(types.map((t) => [t.id as string, t.slug as string]));

  const regions: Record<string, RenderedBlock[]> = {};
  for (const p of placements) {
    const block = asObj(p.block);
    const region = String(p.region);
    const merged = { ...asObj(block.fields), ...(p.isShared ? asObj(p.overrides) : {}) };
    (regions[region] ??= []).push({
      id: String(p.id),
      block_type: slugByTypeId.get(String(block.typeId)) ?? "unknown",
      title: (block.title as string | null) ?? null,
      fields: merged,
      is_shared: Boolean(p.isShared),
    });
  }
  return { page: pageMeta(page), regions };
}

/** Project a page row to the public AssembledPage.page shape. */
function pageMeta(page: Record<string, unknown>): AssembledPage["page"] {
  return {
    id: String(page.id),
    title: String(page.title),
    slug: String(page.slug),
    status: String(page.status),
    locale: String(page.locale ?? "en"),
    fields: (page.fields as Record<string, unknown> | null) ?? null,
    metaTitle: (page.metaTitle as string | null) ?? null,
    metaDescription: (page.metaDescription as string | null) ?? null,
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
}

/** Build the CMS handler map. Spread into your app's handlers. Editor mutations are
 * gated both by `auth` (fast 403 before the body) and by the row ACL (cmsPolicies). */
export function createCmsHandlers(opts: CmsHandlerOpts = {}) {
  const editorRoles = opts.editorRoles ?? ["editor", "admin"];
  const editor = { auth: editorRoles };

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

    // ---- pages ----
    listPages: query((ctx) => cdb(ctx).find({ from: "cms_pages", orderBy: { column: "createdAt", dir: "desc" }, limit: 100 })),

    /** Create a page and auto-scaffold its content type's default blocks. */
    createPage: mutation(async (ctx, input: { typeId: string; title: string; slug: string; fields?: Record<string, unknown> }) => {
      const db = cdb(ctx);
      const ctRows = await db.find({ from: "cms_content_types", where: { id: input.typeId }, limit: 1 });
      const ct = ctRows[0];
      if (!ct) throw new BadRequest("unknown content type");
      validateFields(ct.fieldsSchema as FieldDefinition[] | undefined, input.fields ?? {}, "page.fields");

      const page = await db.insert("cms_pages", {
        typeId: input.typeId,
        title: input.title,
        slug: input.slug,
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
      input: (raw): { typeId: string; title: string; slug: string; fields?: Record<string, unknown> } => {
        const o = asObj(raw);
        if (typeof o.typeId !== "string" || typeof o.title !== "string" || typeof o.slug !== "string") {
          throw new BadRequest("typeId, title and slug are required");
        }
        return o as never;
      },
    }),

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

    // ---- publishing ----
    /** Publish a page: snapshot the fully-assembled page into a revision and flip status
     * to `published`. The public content API serves the snapshot. */
    publishPage: mutation(async (ctx, input: { pageId: string; note?: string }) => {
      const db = cdb(ctx);
      const rows = await db.find({ from: "cms_pages", where: { id: input.pageId }, limit: 1 });
      const page = rows[0];
      if (!page) throw notFound("page");
      const now = nowStamp();
      const snapshot = await assembleLive(db, { ...page, status: "published" });
      snapshot.page.status = "published";
      const rev = await db.insert("cms_page_revisions", { pageId: input.pageId, title: page.title, status: "published", snapshot, note: input.note ?? null });
      const updated = await db.update("cms_pages", input.pageId, {
        status: "published",
        publishedAt: now,
        scheduledAt: null,
        currentRevisionId: rev.id,
        updatedAt: now,
      });
      return { ok: true, page: updated };
    }, {
      ...editor,
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
      const updated = await cdb(ctx).update("cms_pages", input.pageId, { status: "draft", scheduledAt: null, unpublishAt: null, updatedAt: nowStamp() });
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
      ...editor,
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
    /** Fetch an assembled page by slug. Anonymous callers get the published snapshot
     * (the ACL scopes `cms_pages` reads to `status = published`). Editors may pass
     * `preview: true` to assemble the current DRAFT live from the tables. */
    getPage: query(async (ctx, input: { slug: string; preview?: boolean }) => {
      const db = cdb(ctx);
      // Preview is an editor capability — gate it before the lookup so a non-editor gets a
      // clear 403 (rather than a 404 that merely reflects the published-only read scope).
      if (input.preview && !isEditor(ctx, editorRoles)) throw new Forbidden("preview requires an editor role");
      const rows = await db.find({ from: "cms_pages", where: { slug: input.slug }, limit: 1 });
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
        if (revs[0]?.snapshot) return revs[0].snapshot as unknown as AssembledPage;
      }
      return { page: pageMeta(page), regions: {} };
    }, {
      input: (raw): { slug: string; preview?: boolean } => {
        const o = asObj(raw);
        if (typeof o.slug !== "string") throw new BadRequest("slug is required");
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
  const tables = ["cms_content_types", "cms_block_types", "cms_blocks", "cms_pages", "cms_page_blocks", "cms_page_revisions", "cms_media"] as const;
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
    const now = nowStamp();
    const snapshot = await assembleLive(db, { ...page, status: "published" });
    snapshot.page.status = "published";
    const rev = await db.insert("cms_page_revisions", { pageId, title: page.title, status: "published", snapshot, note: "scheduled publish" });
    // Clear scheduledAt so a duplicate delivery of THIS task no-ops on the token check.
    await db.update("cms_pages", pageId, { status: "published", publishedAt: now, scheduledAt: null, currentRevisionId: rev.id, updatedAt: now });
  },
  "cms:unpublish": async (ctx: HandlerContext, payload: unknown) => {
    const { pageId, token } = asObj(payload) as { pageId?: string; token?: string };
    if (!pageId) return;
    const db = cdb(ctx);
    const rows = await db.find({ from: "cms_pages", where: { id: pageId }, limit: 1 });
    const page = rows[0];
    if (!page) return;
    if (String(page.unpublishAt ?? "") !== String(token ?? "")) return; // superseded/cancelled
    await db.update("cms_pages", pageId, { status: "archived", unpublishAt: null, updatedAt: nowStamp() });
  },
};
