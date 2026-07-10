// HTTP client for the CMS handlers. Bearer token + the pramen `{ ok, result }` envelope,
// same transport shape as @pramen/admin's api.ts. Config is persisted in localStorage.

import type { AssembledPage, AuditEntry, BlockType, ContentType, Media, Page } from "./types";

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

const LS = "pramen.cmsEditor";
export function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(LS);
    if (raw) return JSON.parse(raw) as Config;
  } catch {
    /* ignore */
  }
  return { baseUrl: "http://localhost:8787", token: "", tenant: "main" };
}
export function saveConfig(cfg: Config): void {
  localStorage.setItem(LS, JSON.stringify(cfg));
}

export class Api {
  constructor(private cfg: Config) {}

  setConfig(cfg: Config): void {
    this.cfg = cfg;
  }

  private base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, "");
  }

  /** Call a CMS RPC handler. Throws ApiError on a non-`ok` envelope. */
  async call<T = unknown>(name: string, input?: unknown): Promise<T> {
    const res = await fetch(`${this.base()}/rpc/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pramen-tenant": this.cfg.tenant || "main",
        ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
      },
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
  listPages = () => this.call<Page[]>("listPages");
  getPagePreview = (slug: string, locale?: string) => this.call<AssembledPage>("getPage", { slug, locale, preview: true });
  listMedia = () => this.call<Media[]>("listMedia");
  listPageAudit = (pageId: string) => this.call<AuditEntry[]>("listPageAudit", { pageId });
}
