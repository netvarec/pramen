// Local mirror of the @pramen/cms shapes the editor needs. Kept local (not imported from
// @pramen/cms) so the editor stays a self-contained browser app with no server-package
// dependency — it speaks to the CMS purely over HTTP.

/** Any JSON value — the wire form of everything the CMS stores. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A rich-text document — the editor's structured JSON. Mirrors `RichTextDoc` in
 * @pramen/cms; a `richtext` field is this tree, never an HTML string. */
export interface RichTextDoc {
  type: "doc";
  content?: RichTextNode[];
}

/** One node in a {@link RichTextDoc}. */
export interface RichTextNode {
  type: string;
  content?: RichTextNode[];
  text?: string;
  marks?: RichTextMark[];
  attrs?: Record<string, JsonValue>;
}

/** An inline mark on a text node. */
export interface RichTextMark {
  type: string;
  attrs?: Record<string, JsonValue>;
}

/** One authored field value. Mirrors `FieldValue` in @pramen/cms: a `"media"` field
 * arrives resolved to a `Media`, a `"richtext"` field is a `RichTextDoc`, and
 * `group`/`repeater` fields nest further bags. */
export type FieldValue = JsonValue | Media | RichTextDoc | FieldValues | FieldValue[];

/** A block / collection / page `fields` bag — field name -> authored value. */
export interface FieldValues {
  [field: string]: FieldValue;
}

/** The JSON body of an editor RPC call: an object of values, any of which may be
 * omitted (an absent key is simply not sent). */
export interface RpcInput {
  [key: string]: FieldValue | undefined;
}

export type FieldType =
  | "text"
  | "textarea"
  | "richtext"
  | "url"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  /** A publication timestamp — rendered as publish-now / schedule / unpublish. */
  | "publish"
  /** A URL segment, derived from the field named by `from` while it is untouched. */
  | "slug"
  | "media"
  | "select"
  | "repeater"
  | "group";

export interface FieldDefinition {
  name: string;
  label?: string;
  type: FieldType;
  required?: boolean;
  default?: FieldValue;
  fields?: FieldDefinition[];
  min?: number;
  max?: number;
  options?: string[];
  /** For `select`: fetch options at edit time from a query handler of this name, which must
   * return `{ value, label }[]`. Lets a select offer live data (e.g. existing campaigns)
   * instead of a static list. Takes precedence over `options`. */
  optionsFrom?: string;
  /** For `slug`: the sibling field this one is derived from (e.g. `"title"`). */
  from?: string;
}

export interface RegionDefinition {
  name: string;
  label?: string;
  allowedTypes?: string[] | null;
}

export interface DefaultBlockDefinition {
  region: string;
  blockTypeSlug: string;
  fields?: FieldValues;
}

export interface BlockType {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  fieldsSchema?: FieldDefinition[] | null;
  icon?: string | null;
  category?: string | null;
}

export interface ContentType {
  id: string;
  name: string;
  slug: string;
  regions?: RegionDefinition[] | null;
  fieldsSchema?: FieldDefinition[] | null;
  defaultBlocks?: DefaultBlockDefinition[] | null;
}

/** A collection: one of the host app's own pramen entities, edited generically via a
 * field schema (mirror of @pramen/cms `CollectionMeta`). Fetched from `listCollections`
 * and used to build the nav + the generic list/edit views. No `entity`/`idField` — those
 * are server-only; the editor addresses a collection purely by `slug`. */
export interface CollectionMeta {
  slug: string;
  label: string;
  pluralLabel: string;
  icon?: string;
  fields: FieldDefinition[];
  list: string[];
  titleField: string;
  /** The entity's PK column name (defaults "id" server-side) — the editor reads a row's id
   * from this to open/save/delete it. */
  idField: string;
  orderBy?: { column: string; dir?: "asc" | "desc" };
  /** The workflow features the collection opted into server-side (`supports`), e.g.
   * `["drafts", "scheduling"]`. Carried here so this mirror stays faithful to
   * `CollectionMeta`. The editor renders the matching affordances (publish/unpublish, a
   * schedule picker, a preview link, a revision list) in `CollectionWorkflow`; an empty
   * list renders none of them. */
  supports?: CollectionFeature[];
}

/** What the server says this deployment supports (mirror of `listCmsCapabilities`).
 *
 * Server-declared, like a collection's `supports: [...]`: the editor asks what exists
 * rather than being configured to hide things locally, so the chrome and the data cannot
 * disagree. `multilingual` is the derived answer to the question the UI actually asks. */
export interface CmsCapabilities {
  /** Declared locales, most-preferred first. */
  locales: string[];
  /** The locale a page gets when created without one — `locales[0]`. */
  defaultLocale: string;
  /** More than one declared locale. Gates the whole i18n surface. */
  multilingual: boolean;
}

/** Used until `listCmsCapabilities` answers, and when it cannot (an older server). Assumes
 * MONOLINGUAL: a hidden i18n surface on a multilingual site is recoverable by reloading,
 * where a half-rendered one on a single-locale site is what this replaced. */
export const DEFAULT_CAPABILITIES: CmsCapabilities = { locales: ["en"], defaultLocale: "en", multilingual: false };

/** Mirror of @pramen/cms `CollectionFeature`. */
export type CollectionFeature = "drafts" | "scheduling" | "revisions" | "preview";

export interface Page {
  id: string;
  typeId: string;
  title: string;
  slug: string;
  status: string;
  locale: string;
  fields?: FieldValues | null; // content-type-level structured data (fieldsSchema)
  translationGroupId?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  canonicalUrl?: string | null;
  robots?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: string | null;
  scheduledAt?: string | null;
  unpublishAt?: string | null;
  updatedAt?: string | null;
}

export interface ResolvedMedia {
  id: string;
  key: string;
  url: string;
  alt: string | null;
  contentType: string | null;
  filename: string | null;
}

export interface RenderedBlock {
  id: string; // placement id (reorder/remove)
  block_id: string; // block instance id (edit)
  block_type: string;
  title: string | null;
  fields: FieldValues;
  is_shared: boolean;
  pending?: boolean; // optimistic placeholder — not yet persisted (temp ids, no getBlock)
}

export interface AssembledPage {
  page: Page & { translations?: { locale: string; slug: string }[]; seo?: FieldValues };
  regions: Record<string, RenderedBlock[]>;
}

export interface Media {
  id: string;
  file: { key: string; contentType?: string; filename?: string; size?: number; uploadedAt?: number };
  alt?: string | null;
  createdAt?: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string | null;
  note: string | null;
  createdAt: string;
}
