// HTTP client for the CMS handlers. Bearer token + the pramen `{ ok, result }` envelope,
// same transport shape as @pramen/admin's api.ts. Config is persisted in localStorage.

import type { AdminPageMeta, AdminPageResponse, AssembledPage, AuditEntry, BlockType, ContentType, Media, Menu, MenuItem, Page, Redirect, Taxonomy, Term, Widget, WidgetArea } from "./types";
import type { DefaultBlockDefinition, FieldDefinition, RegionDefinition, RpcInput } from "./types";

/** The payload `createBlockType` / `updateBlockType` take. `fieldsSchema` is the whole
 * point: a block type IS its field schema. */
export interface BlockTypeInput {
  name: string;
  slug: string;
  description?: string | null;
  icon?: string | null;
  category?: string | null;
  fieldsSchema?: FieldDefinition[];
}

/** The payload `createContentType` / `updateContentType` take. */
export interface ContentTypeInput {
  name: string;
  slug: string;
  regions?: RegionDefinition[];
  fieldsSchema?: FieldDefinition[];
  defaultBlocks?: DefaultBlockDefinition[];
}

export interface Config {
  baseUrl: string;
  token: string;
  tenant: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Decode a JWT's `exp` claim (seconds) and report whether it has passed. A non-JWT token or
 * one without `exp` is treated as NOT expired (fail open) — the server is the real authority.
 * Used to bounce an expired session to sign-in before/instead of firing doomed requests. */
export function isTokenExpired(token: string): boolean {
  try {
    const seg = String(token).split(".")[1];
    if (!seg) return false;
    const payload = JSON.parse(atob(seg.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" && Date.now() >= payload.exp * 1000;
  } catch {
    return false;
  }
}

const LS = "pramen.cmsEditor";

/** The columns the page LIST renders — id (to open the row), title, slug, locale, status.
 * `typeId` rides along so a caller can tell which type a row belongs to without a join. */
export const PAGE_LIST_COLUMNS = ["id", "typeId", "title", "slug", "locale", "status"] as const;

/**
 * The session for this page load.
 *
 * A backend DECLARED by the shell (see `mount.ts`) wins over anything stored: the server
 * that served the editor knows where its own API is, so there is nothing for a person to
 * type and get wrong, and a stale url from an earlier deployment can't outlive it. Only
 * the token is the browser's to remember.
 */
export function loadConfig(declared?: { url: string; tenant: string }): Config {
  let stored: Partial<Config> = {};
  try {
    const raw = localStorage.getItem(LS);
    if (raw) stored = JSON.parse(raw) as Partial<Config>;
  } catch {
    /* ignore */
  }
  const token = typeof stored.token === "string" ? stored.token : "";
  if (declared) return { baseUrl: declared.url, tenant: declared.tenant, token };
  return { baseUrl: stored.baseUrl ?? "http://localhost:8787", tenant: stored.tenant ?? "main", token };
}
export function saveConfig(cfg: Config): void {
  localStorage.setItem(LS, JSON.stringify(cfg));
}
/** Drop the persisted session (used when handing off to an external sign-in page). */
export function clearConfig(): void {
  try {
    localStorage.removeItem(LS);
  } catch {
    /* ignore */
  }
}

export class Api {
  /** `onExpired` fires when a call is attempted with a locally-expired token — the app wires
   * it to redirect to sign-in. We can't key off HTTP status: an expired token is rejected as
   * anonymous and a role-gated handler then returns 403, indistinguishable from a valid token
   * that merely lacks the role. So expiry is detected client-side from the token's `exp`. */
  constructor(private cfg: Config, private onExpired?: () => void) {}

  setConfig(cfg: Config): void {
    this.cfg = cfg;
  }

  private base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, "");
  }

  /** Call a CMS RPC handler. Throws ApiError on a non-`ok` envelope. */
  async call<T = unknown>(name: string, input?: RpcInput): Promise<T> {
    // Expired token: hand off to sign-in instead of firing a request that will 403 into an
    // error banner. The returned promise never settles — navigation is already underway.
    if (this.onExpired && this.cfg.token && isTokenExpired(this.cfg.token)) {
      this.onExpired();
      return new Promise<T>(() => {});
    }
    const headers = new Headers({
      "content-type": "application/json",
      "x-pramen-tenant": this.cfg.tenant || "main",
    });
    if (this.cfg.token) headers.set("authorization", `Bearer ${this.cfg.token}`);
    const res = await fetch(`${this.base()}/rpc/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input ?? {}),
    });
    let body: { ok?: boolean; result?: unknown; error?: string; code?: string };
    try {
      body = await res.json();
    } catch {
      throw new ApiError(`non-JSON response (HTTP ${res.status})`, "bad_response", res.status);
    }
    if (body.ok !== true) {
      const msg = body.error ?? `request failed (HTTP ${res.status})`;
      const hint = res.status === 403 ? " — check your token has an editor/reviewer role" : "";
      throw new ApiError(msg + hint, body.code ?? "error", res.status);
    }
    return body.result as T;
  }

  /** Upload bytes to a signed url (relative → resolved against the base). */
  async put(signedUrl: string, body: Blob | ArrayBuffer, contentType: string): Promise<void> {
    const url = signedUrl.startsWith("http") ? signedUrl : `${this.base()}${signedUrl}`;
    const res = await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body });
    if (!res.ok) throw new ApiError(`upload failed (HTTP ${res.status})`, "upload_failed", res.status);
  }

  /** Absolute URL for a relative media/serving path. */
  resolve(path: string): string {
    return path.startsWith("http") ? path : `${this.base()}${path}`;
  }

  // --- typed convenience wrappers ---
  listBlockTypes = () => this.call<BlockType[]>("listBlockTypes");
  listContentTypes = () => this.call<ContentType[]>("listContentTypes");
  getContentType = (id: string) => this.call<ContentType | null>("getContentType", { id });
  /** All pages, or just one content type's (by SLUG), one page of them at a time. The server
   * does the filtering AND the paging — see `listPages` in @pramen/cms; it caps its result,
   * so narrowing or counting client-side would be narrowing an already-truncated list.
   *
   * `PAGE_LIST_COLUMNS` is the projection the list screen actually renders. The full page row
   * carries every SEO column, the schedule stamps and the whole `fields` bag; asking for all
   * of it to draw five columns is the D1-over-RPC shape that made lists hang (GitHub #22).
   * The editor fetches a whole page by id (`getPageById`) when it needs the wide row. */
  listPages = (opts: { contentType?: string; limit?: number; offset?: number } = {}) =>
    this.call<Page[]>("listPages", { ...opts, select: [...PAGE_LIST_COLUMNS] });
  /** One page, wide, by id — what the page editor opens. Resolving an id against `listPages`
   * instead can miss: that list is capped, and the editor lists one content type per tab. */
  getPageById = (pageId: string) => this.call<Page | null>("getPageById", { pageId });
  getPagePreview = (slug: string, locale?: string) => this.call<AssembledPage>("getPage", { slug, locale, preview: true });
  listPageAudit = (pageId: string) => this.call<AuditEntry[]>("listPageAudit", { pageId });

  // --- media ---
  listMedia = (limit = 50, offset = 0) => this.call<Media[]>("listMedia", { limit, offset });
  getMedia = (id: string) => this.call<Media | null>("getMedia", { id });
  updateMedia = (id: string, alt: string | null) => this.call<Media>("updateMedia", { id, alt });
  deleteMedia = (id: string) => this.call<{ ok: true }>("deleteMedia", { id });
  // Trash is not a UI nicety here: deleteMedia no longer removes the R2 object, so without
  // a reachable purge a file can be "deleted" in the library and still be served on the
  // live site — the case a takedown request actually needs.
  listTrash = (limit = 50) => this.call<{ pages: Page[]; media: Media[] }>("listTrash", { limit });
  restoreMedia = (id: string) => this.call<{ ok: true }>("restoreMedia", { id });
  purgeMedia = (id: string) => this.call<{ ok: true }>("purgeMedia", { id });

  // --- block types & content types (the schema behind pages) ---
  //
  // Read wrappers existed from the start; the WRITE half did not, which is why a fresh CMS
  // could not be bootstrapped from the editor at all — `createBlockType` / `createContentType`
  // had to be curled before the editor was usable (GitHub #9). The handlers were already
  // there and already editor-gated; only these and the screens over them were missing.
  createBlockType = (input: BlockTypeInput) => this.call<BlockType>("createBlockType", input as unknown as RpcInput);
  /** Patch a block type. `slug` is the stable key and is NOT mutable server-side. */
  updateBlockType = (id: string, input: Partial<BlockTypeInput>) => this.call<BlockType>("updateBlockType", { id, ...input } as unknown as RpcInput);
  createContentType = (input: ContentTypeInput) => this.call<ContentType>("createContentType", input as unknown as RpcInput);
  updateContentType = (id: string, input: Partial<ContentTypeInput>) => this.call<ContentType>("updateContentType", { id, ...input } as unknown as RpcInput);

  // --- site furniture ---
  listMenus = () => this.call<Menu[]>("listMenus");
  createMenu = (name: string, label: string) => this.call<Menu>("createMenu", { name, label, items: [] });
  updateMenu = (id: string, patch: { label?: string; items?: MenuItem[] }) => this.call<Menu>("updateMenu", { id, ...patch } as unknown as RpcInput);
  deleteMenu = (id: string) => this.call<{ ok: true }>("deleteMenu", { id });

  listRedirects = (limit = 200, offset = 0) => this.call<Redirect[]>("listRedirects", { limit, offset });
  createRedirect = (input: { fromPath: string; toPath: string; status?: number; enabled?: boolean; note?: string }) =>
    this.call<Redirect>("createRedirect", input);
  updateRedirect = (id: string, patch: { fromPath?: string; toPath?: string; status?: number; enabled?: boolean; note?: string | null }) =>
    this.call<Redirect>("updateRedirect", { id, ...patch } as unknown as RpcInput);
  deleteRedirect = (id: string) => this.call<{ ok: true }>("deleteRedirect", { id });

  listTaxonomies = () => this.call<Taxonomy[]>("listTaxonomies");
  createTaxonomy = (input: { slug: string; label: string; pluralLabel?: string; description?: string; hierarchical?: boolean }) =>
    this.call<Taxonomy>("createTaxonomy", input);
  updateTaxonomy = (id: string, patch: { label?: string; pluralLabel?: string | null; description?: string | null; hierarchical?: boolean }) =>
    this.call<Taxonomy>("updateTaxonomy", { id, ...patch } as unknown as RpcInput);
  deleteTaxonomy = (id: string) => this.call<{ ok: true }>("deleteTaxonomy", { id });

  /** A vocabulary's terms as a TREE. The server folds it, so every consumer does not. */
  getTermTree = (taxonomy: string) => this.call<Term[]>("getTermTree", { taxonomy });
  createTerm = (input: { taxonomy: string; slug: string; label: string; description?: string; parentId?: string | null; position?: number }) =>
    this.call<Term>("createTerm", input as unknown as RpcInput);
  updateTerm = (id: string, patch: { slug?: string; label?: string; description?: string | null; parentId?: string | null; position?: number }) =>
    this.call<Term>("updateTerm", { id, ...patch } as unknown as RpcInput);
  deleteTerm = (id: string) => this.call<{ ok: true }>("deleteTerm", { id });

  listPageTerms = (pageId: string) => this.call<Term[]>("listPageTerms", { pageId });
  setPageTerms = (pageId: string, termIds: string[]) => this.call<{ ok: true }>("setPageTerms", { pageId, termIds });

  // --- Block Kit: custom admin pages ---
  /** The pages THIS caller may open. Filtered server-side, so a nav entry that 403s when
   * clicked cannot happen. An older server has no such handler; the caller treats a failure
   * as "no custom pages". */
  listAdminPages = () => this.call<AdminPageMeta[]>("listAdminPages");
  /** Render a page, or act on it and render the result. One round trip per interaction. */
  adminPageInteract = (input: { page: string; type: "page_load" | "block_action" | "form_submit"; action_id?: string; block_id?: string; value?: unknown; values?: Record<string, unknown> }) =>
    this.call<AdminPageResponse>("adminPageInteract", input as unknown as RpcInput);

  listWidgetAreas = () => this.call<WidgetArea[]>("listWidgetAreas");
  createWidgetArea = (name: string, label: string, description?: string) => this.call<WidgetArea>("createWidgetArea", { name, label, description, widgets: [] });
  updateWidgetArea = (id: string, patch: { label?: string; description?: string | null; widgets?: Widget[] }) =>
    this.call<WidgetArea>("updateWidgetArea", { id, ...patch } as unknown as RpcInput);
  deleteWidgetArea = (id: string) => this.call<{ ok: true }>("deleteWidgetArea", { id });

  /** Full upload flow: sign → PUT the bytes → persist a `cms_media` row. Returns the row. */
  async uploadMedia(file: File): Promise<Media> {
    const contentType = file.type || "application/octet-stream";
    const signed = await this.call<{ url: string; ref: { key: string; contentType: string; filename?: string } }>("signMediaUpload", { contentType, filename: file.name });
    await this.put(signed.url, await file.arrayBuffer(), contentType);
    return this.call<Media>("createMedia", { ref: signed.ref, alt: file.name });
  }
}
