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
  /** A pointer to a record that is not this row — a pramen row or an external record.
   * Stored as an opaque id; resolved through `referenceFrom`. */
  | "reference"
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
  /** For `reference`: the query handler that resolves it. Called `{ search?, limit, offset }`
   * to browse and `{ ids }` to resolve labels for stored values; returns
   * {@link ReferenceResult} either way. */
  referenceFrom?: string;
  /** For `reference`: store a list of ids rather than one. */
  multiple?: boolean;
}

/** One option a `reference` field's handler returns. */
export interface ReferenceOption {
  value: string;
  label: string;
  /** Secondary text under the label — a date, an owner, a status. A picker over a thousand
   * records usually needs more than a name to tell two rows apart. */
  hint?: string;
}

/** What a `reference` field's handler returns, for both request shapes. */
export interface ReferenceResult {
  items: ReferenceOption[];
  hasMore?: boolean;
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
  /** The `cmsBootstrap` owner that declares this type in the app's code, or null/absent when
   * an editor authored it. The builder renders an owned type read-only: a save would 409, and
   * before it did, it would have been quietly reverted at the next cold start.
   *
   * Only meaningful when `CmsCapabilities.codeDefinedTypes` is true — an older server sends
   * no owner for any row, which is indistinguishable from "nothing is code-defined". */
  managedBy?: string | null;
}

export interface ContentType {
  id: string;
  name: string;
  slug: string;
  regions?: RegionDefinition[] | null;
  fieldsSchema?: FieldDefinition[] | null;
  defaultBlocks?: DefaultBlockDefinition[] | null;
  /** See `BlockType.managedBy`. */
  managedBy?: string | null;
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
  /** Where this collection sits in the primary nav — see {@link NAV_ORDER}. Filled in
   * server-side, so the editor sorts one list of numbers. Optional here only because an
   * OLDER server does not send it; `NAV_ORDER.collections` is the fallback, which is
   * exactly where collections rendered before the key existed. */
  navOrder?: number;
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
  /** The server's `listPages` understands `contentType` — the licence to give each content
   * type its own tab and its own list. An older server ACCEPTS the argument and ignores it
   * (an unknown input key is passed through, not rejected), answering with the pooled list:
   * without this probe the editor renders N tabs that all show every type's pages under a
   * heading claiming otherwise, and "New page" from any of them stamps that tab's type. */
  pagesByType: boolean;
  /** The server has the site-furniture handlers (menus, redirects, taxonomies, widget
   * areas). Declared, not probed: an older server answers `listMenus` with a 404 like any
   * unknown handler, and a nav section whose every screen fails is worse than no section. */
  siteFurniture: boolean;
  /** The server stamps `managedBy` on the types `cmsBootstrap` declares, and refuses to
   * update one. Declared rather than inferred from the rows: this package has no dependency
   * on `@pramen/cms`, so a NEWER editor can run against an older server — where every row
   * reports no owner, which reads identically to "no type is code-defined". Trusting the row
   * there means the builder offers a save the server accepts and the next cold start
   * reverts, i.e. GitHub #48 in the deployment that upgraded the editor to fix it. */
  codeDefinedTypes: boolean;
  /** Whether THIS caller may author, i.e. holds one of the deployment's `editorRoles`.
   *
   * Per-caller, unlike the rest of this probe. The read handlers are open to
   * `editorRoles ∪ reviewerRoles` but every write is editor-only, and the editor cannot
   * derive that: it knows the caller's roles from `me` but not which roles the deployment
   * configured. Without it a reviewer-only session gets the authoring nav and every screen
   * 403s on its first save. */
  canEdit: boolean;
}

/**
 * Where each built-in section sits in the primary nav — the editor's mirror of
 * `NAV_ORDER` in @pramen/cms.
 *
 * A mirror, not an import: the editor is a standalone browser app that speaks to the CMS
 * purely over HTTP and has no server-package dependency (see the note at the top of this
 * file). The numbers are ordinals spaced 100 apart; only their relative order is contract.
 */
export const NAV_ORDER = {
  pages: 100,
  collections: 200,
  media: 300,
  menus: 400,
  taxonomies: 500,
  widgets: 600,
  redirects: 700,
  adminPages: 800,
  types: 900,
  users: 1000,
  settings: 1100,
  extra: 1200,
} as const;

/** Used until `listCmsCapabilities` answers, and when it cannot (an older server). Assumes
 * MONOLINGUAL: a hidden i18n surface on a multilingual site is recoverable by reloading,
 * where a half-rendered one on a single-locale site is what this replaced. */
export const DEFAULT_CAPABILITIES: CmsCapabilities = {
  locales: ["en"],
  defaultLocale: "en",
  multilingual: false,
  pagesByType: false,
  siteFurniture: false,
  codeDefinedTypes: false,
  // Fails OPEN, unlike its neighbours. An older server sends no `canEdit`, and hiding
  // every authoring control from a real editor is unrecoverable from inside the editor;
  // showing one that 403s is a legible error with a way forward. The server is the
  // boundary either way — this only decides what is drawn.
  canEdit: true,
};

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

// --- site furniture (mirrors of the @pramen/cms shapes) ----------------------

/** What a menu item points at. `custom` is a literal href; the rest are references the
 * server resolves at read time, so a link follows its page instead of freezing a slug. */
export type MenuItemKind = "custom" | "page" | "term" | "collection";

export interface MenuItem {
  id: string;
  label: string;
  kind?: MenuItemKind;
  /** `page`: a page id · `term`: a term id · `collection`: a collection slug. */
  ref?: string | null;
  /** `custom`: the href as authored. Filled in by `getMenu` for the resolved kinds. */
  url?: string;
  target?: string;
  titleAttr?: string;
  cssClasses?: string;
  children?: MenuItem[];
}

export interface Menu {
  id: string;
  name: string;
  label: string;
  items?: MenuItem[] | null;
  /** Optimistic-concurrency counter — send it back as `expectedVersion` so a second
   * editor's whole-tree overwrite is a 409 rather than a silent replacement. */
  version?: number;
}

/** Mirror of `MAX_MENU_DEPTH` in @pramen/cms — the editor refuses to nest deeper rather
 * than letting a save fail on the server with the tree already reordered on screen. */
export const MAX_MENU_DEPTH = 5;

export interface Redirect {
  id: string;
  fromPath: string;
  toPath: string;
  status: number;
  enabled: boolean;
  note?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Mirror of `REDIRECT_STATUSES` in @pramen/cms. */
export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;

export interface Taxonomy {
  id: string;
  slug: string;
  label: string;
  pluralLabel?: string | null;
  description?: string | null;
  hierarchical?: boolean;
}

export interface Term {
  id: string;
  taxonomyId: string;
  slug: string;
  label: string;
  description?: string | null;
  parentId?: string | null;
  position?: number;
  children?: Term[];
}

export type WidgetType = "content" | "menu" | "component";

export interface Widget {
  id: string;
  type: WidgetType;
  title?: string | null;
  content?: RichTextDoc;
  menuName?: string;
  componentId?: string;
  componentProps?: FieldValues;
}

export interface WidgetArea {
  id: string;
  name: string;
  label: string;
  description?: string | null;
  widgets?: Widget[] | null;
  /** See {@link Menu.version}. */
  version?: number;
}

// --- Block Kit: custom admin pages (mirrors @pramen/cms `./blockkit`) ----------------

/** An input a Block Kit form or actions row can carry. */
export type AdminInput =
  | { type: "text_input"; action_id: string; label?: string; placeholder?: string; initial_value?: string; multiline?: boolean; required?: boolean }
  | { type: "number_input"; action_id: string; label?: string; placeholder?: string; initial_value?: number; min?: number; max?: number; required?: boolean }
  | { type: "select"; action_id: string; label?: string; options: { value: string; label: string }[]; initial_value?: string; required?: boolean }
  | { type: "toggle"; action_id: string; label?: string; initial_value?: boolean }
  /** Write-only: deliberately has NO `initial_value`, so a stored secret is never echoed
   * back into the admin's DOM. */
  | { type: "secret_input"; action_id: string; label?: string; placeholder?: string; required?: boolean };

export interface AdminButton {
  type: "button";
  action_id: string;
  label: string;
  style?: "primary" | "secondary" | "danger";
  value?: string;
  /** Ask before firing. A page has no code in the browser, so it cannot put up its own. */
  confirm?: string;
}

export type AdminElement = AdminButton | AdminInput;

export type AdminBlock =
  | { type: "header"; text: string; level?: 1 | 2 | 3 }
  | { type: "section"; text: string }
  | { type: "divider" }
  | { type: "context"; text: string }
  | { type: "fields"; fields: { label: string; value: string }[] }
  | { type: "table"; columns: { key: string; label: string }[]; rows: Record<string, string | number | boolean | null>[]; empty?: string }
  | { type: "stats"; stats: { label: string; value: string; hint?: string }[] }
  | { type: "actions"; block_id?: string; elements: AdminElement[] }
  | { type: "form"; block_id: string; fields: AdminInput[]; submit: { label: string; action_id: string } }
  | { type: "image"; url: string; alt?: string; caption?: string }
  | { type: "columns"; columns: AdminBlock[][] }
  | { type: "empty"; text: string; hint?: string }
  | { type: "accordion"; title: string; blocks: AdminBlock[]; open?: boolean };

/** What a Block Kit page answers with. The WHOLE page comes back on every interaction. */
export interface AdminPageResponse {
  blocks: AdminBlock[];
  toast?: { text: string; tone?: "info" | "success" | "error" };
}

/** A custom admin page, as the editor sees it (from `listAdminPages`) — never the render
 * function, and never the role list. A page the caller may not open is simply absent. */
export interface AdminPageMeta {
  slug: string;
  label: string;
  icon?: string;
  navOrder?: number;
}

// --- media sorting and filtering -----------------------------------------------------------
//
// Mirrors of the vocabularies `listMedia` accepts in @pramen/cms. Mirrored rather than
// imported for the reason at the top of this file — the editor is a standalone browser app
// with no server-package dependency — and checked against the originals in
// `test/cms-editor-mirrors.test.ts`, because a duplicate nobody verifies is a latent bug with
// a comment on it.
//
// The server treats an unrecognised value as absent, so a drift here degrades to the default
// order rather than to an error. That is the failure worth having, and it is still a failure:
// a sort the editor offers and the server drops is a control that silently does nothing.

/** How the media library may be ordered. */
export const MEDIA_SORTS = ["newest", "oldest", "name", "name_desc", "largest", "smallest"] as const;
export type MediaSort = (typeof MEDIA_SORTS)[number];

/** What each sort is called on screen. */
export const MEDIA_SORT_LABELS: Record<MediaSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  name: "Name A–Z",
  name_desc: "Name Z–A",
  largest: "Largest first",
  smallest: "Smallest first",
};

/** The coarse type buckets the library filters by. */
export const MEDIA_KINDS = ["image", "video", "audio", "document", "other"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** …and their labels. Plural, because each names a SET the filter narrows to. */
export const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  image: "Images",
  video: "Video",
  audio: "Audio",
  document: "Documents",
  other: "Other",
};
