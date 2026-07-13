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
  async call<T = unknown>(name: string, input?: unknown): Promise<T> {
    // Expired token: hand off to sign-in instead of firing a request that will 403 into an
    // error banner. The returned promise never settles — navigation is already underway.
    if (this.onExpired && this.cfg.token && isTokenExpired(this.cfg.token)) {
      this.onExpired();
      return new Promise<T>(() => {});
    }
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
  listPageAudit = (pageId: string) => this.call<AuditEntry[]>("listPageAudit", { pageId });

  // --- media ---
  listMedia = (limit = 50, offset = 0) => this.call<Media[]>("listMedia", { limit, offset });
  getMedia = (id: string) => this.call<Media | null>("getMedia", { id });
  updateMedia = (id: string, alt: string | null) => this.call<Media>("updateMedia", { id, alt });
  deleteMedia = (id: string) => this.call<{ ok: true }>("deleteMedia", { id });

  /** Full upload flow: sign → PUT the bytes → persist a `cms_media` row. Returns the row. */
  async uploadMedia(file: File): Promise<Media> {
    const contentType = file.type || "application/octet-stream";
    const signed = await this.call<{ url: string; ref: { key: string; contentType: string; filename?: string } }>("signMediaUpload", { contentType, filename: file.name });
    await this.put(signed.url, await file.arrayBuffer(), contentType);
    return this.call<Media>("createMedia", { ref: signed.ref, alt: file.name });
  }
}
