// File storage — the portable type surface. The `fileRef` column type and the
// `ctx.files` facade handlers use. Pure types (no platform code); the Cloudflare
// glue (R2 adapter, signing, the Worker /files endpoint) lives in runtime/storage.ts.

/** What a `fileRef` column holds: small JSON metadata, never the bytes. */
export interface FileRef {
  /** Object-store key (tenant-scoped, e.g. "acme/ab12…"). */
  key: string;
  /** Size in bytes (0 until the upload is confirmed via files.head()). */
  size: number;
  contentType: string;
  /** Original upload filename, used for Content-Disposition on download. */
  filename?: string;
  /** Epoch ms the ref was last written/confirmed. */
  uploadedAt?: number;
}

/** Object-store metadata for a stored blob. */
export interface HeadResult {
  size: number;
  contentType?: string;
}

export interface SignUploadOpts {
  contentType: string;
  filename?: string;
  /** Max accepted upload size in bytes (enforced at the Worker). */
  maxSize?: number;
  /** URL lifetime in seconds (default 900 = 15 min). */
  expiresIn?: number;
  /** Optional key prefix segment under the tenant (e.g. "avatars"). */
  prefix?: string;
}

export interface SignDownloadOpts {
  /** URL lifetime in seconds (default 3600 = 1 hour). */
  expiresIn?: number;
  /** Force a download (Content-Disposition: attachment) vs inline. */
  download?: boolean;
}

/** The per-tenant file facade handed to handlers as `ctx.files`. */
export interface Files {
  /** Mint a tenant-scoped key + a signed PUT url for a direct-to-store upload. */
  signUpload(opts: SignUploadOpts): Promise<{ url: string; ref: FileRef }>;
  /** Mint a signed GET url for an existing blob. Call only after an ACL'd read of
   * the owning row — knowing a key is not, by itself, authorization. */
  signDownload(ref: FileRef | string, opts?: SignDownloadOpts): Promise<{ url: string; expiresAt: number }>;
  /** Object-store metadata (size/contentType), or null if the blob is absent. */
  head(key: string): Promise<HeadResult | null>;
  /** Delete a blob (lifecycle / cascade). */
  delete(key: string): Promise<void>;
}
