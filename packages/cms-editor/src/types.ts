// Local mirror of the @pramen/cms shapes the editor needs. Kept local (not imported from
// @pramen/cms) so the editor stays a self-contained browser app with no server-package
// dependency — it speaks to the CMS purely over HTTP.

export type FieldType =
  | "text"
  | "textarea"
  | "richtext"
  | "url"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "media"
  | "select"
  | "repeater"
  | "group";

export interface FieldDefinition {
  name: string;
  label?: string;
  type: FieldType;
  required?: boolean;
  default?: unknown;
  fields?: FieldDefinition[];
  min?: number;
  max?: number;
  options?: string[];
  /** For `select`: fetch options at edit time from a query handler of this name, which must
   * return `{ value, label }[]`. Lets a select offer live data (e.g. existing campaigns)
   * instead of a static list. Takes precedence over `options`. */
  optionsFrom?: string;
}

export interface RegionDefinition {
  name: string;
  label?: string;
  allowedTypes?: string[] | null;
}

export interface DefaultBlockDefinition {
  region: string;
  blockTypeSlug: string;
  fields?: Record<string, unknown>;
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

export interface Page {
  id: string;
  typeId: string;
  title: string;
  slug: string;
  status: string;
  locale: string;
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
  fields: Record<string, unknown>;
  is_shared: boolean;
  pending?: boolean; // optimistic placeholder — not yet persisted (temp ids, no getBlock)
}

export interface AssembledPage {
  page: Page & { translations?: { locale: string; slug: string }[]; seo?: Record<string, unknown> };
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
