// File storage — the object-store seam, mirroring the Driver/Dialect seam for SQL.
// The sign/upload/download engine is written against a small `StorageAdapter`, so
// the same flow runs over any object store; R2 is the Cloudflare default.
//
// Design (see .mine/file-storage-design.md and DESIGN.md):
//  - A `fileRef` column stores small JSON metadata (a FileRef), never the bytes.
//  - Bytes live in the object store, addressed by a tenant-scoped key.
//  - Handlers get `ctx.files`: mint a signed upload url, mint a signed download url
//    (only AFTER an ACL'd read of the owning row), and head/delete blobs.
//  - The Worker serves `/files/upload` and `/files/download`, authorized purely by
//    an HMAC-signed token (no S3 credentials, no bytes through the Durable Object).
//
// Why HMAC tokens instead of S3 presigned urls: pramen already owns the edge and a
// secret; signing is pure WebCrypto over the R2 binding, so it works with the plain
// R2 binding and stays backend-agnostic. URLs are RELATIVE so the server never
// needs to know its own public origin — the client resolves them against its base.

import { BadRequest, PramenError } from "./errors";
import type { Files, FileRef, HeadResult } from "../sdk/files";

// The portable type surface (FileRef, Files, sign opts) lives in sdk/files.ts;
// re-export it here so runtime callers have one import site.
export type { Files, FileRef, HeadResult, SignDownloadOpts, SignUploadOpts } from "../sdk/files";

// --- StorageAdapter: the object-store seam ---

export interface PutResult {
  key: string;
  size: number;
  etag?: string;
}
export interface GetResult {
  body: ReadableStream;
  size: number;
  contentType?: string;
}

export interface StorageAdapter {
  put(
    key: string,
    body: ReadableStream | ArrayBuffer | Uint8Array | null,
    opts?: { contentType?: string },
  ): Promise<PutResult>;
  get(key: string): Promise<GetResult | null>;
  head(key: string): Promise<HeadResult | null>;
  delete(key: string): Promise<void>;
}

/** R2 — the Cloudflare default. Wraps an R2 bucket binding. Streaming: bytes flow
 * directly between the client and R2 in the Worker, never through the DO. */
export class R2Adapter implements StorageAdapter {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array | null, opts?: { contentType?: string }): Promise<PutResult> {
    const obj = await this.bucket.put(key, body as ReadableStream, {
      httpMetadata: opts?.contentType ? { contentType: opts.contentType } : undefined,
    });
    return { key, size: obj?.size ?? 0, etag: obj?.etag };
  }

  async get(key: string): Promise<GetResult | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: obj.body, size: obj.size, contentType: obj.httpMetadata?.contentType };
  }

  async head(key: string): Promise<HeadResult | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return { size: obj.size, contentType: obj.httpMetadata?.contentType };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

/** In-memory store for unit tests / substrates without an object store. Not durable. */
export class MemoryAdapter implements StorageAdapter {
  private readonly store = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array | null, opts?: { contentType?: string }): Promise<PutResult> {
    const bytes = await toBytes(body);
    this.store.set(key, { bytes, contentType: opts?.contentType });
    return { key, size: bytes.byteLength };
  }

  async get(key: string): Promise<GetResult | null> {
    const e = this.store.get(key);
    if (!e) return null;
    return { body: bytesToStream(e.bytes), size: e.bytes.byteLength, contentType: e.contentType };
  }

  async head(key: string): Promise<HeadResult | null> {
    const e = this.store.get(key);
    return e ? { size: e.bytes.byteLength, contentType: e.contentType } : null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

async function toBytes(body: ReadableStream | ArrayBuffer | Uint8Array | null): Promise<Uint8Array> {
  if (body == null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  const buf = await new Response(body).arrayBuffer();
  return new Uint8Array(buf);
}

function bytesToStream(bytes: Uint8Array): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// --- base64url (shared shape with auth.ts/jwt.ts) ---

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const strToB64url = (s: string) => bytesToB64url(new TextEncoder().encode(s));
const b64urlToStr = (s: string) => new TextDecoder().decode(b64urlToBytes(s));

// --- signed file tokens (HMAC-SHA256) ---

interface FileToken {
  /** tenant */ t: string;
  /** key */ k: string;
  /** op */ op: "get" | "put";
  /** expiry (epoch seconds) */ exp: number;
  /** content-type (put: enforced; get: disposition hint) */ ct?: string;
  /** max size in bytes (put only) */ max?: number;
  /** filename (download disposition) */ fn?: string;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function signToken(token: FileToken, secret: string): Promise<string> {
  const data = strToB64url(JSON.stringify(token));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${bytesToB64url(new Uint8Array(sig))}`;
}

/** Verify a file token's signature + expiry; returns the payload or null. */
export async function verifyToken(raw: string, secret: string): Promise<FileToken | null> {
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const data = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  let ok: boolean;
  try {
    const key = await hmacKey(secret);
    ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig), new TextEncoder().encode(data));
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload: FileToken;
  try {
    payload = JSON.parse(b64urlToStr(data));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || Math.floor(Date.now() / 1000) >= payload.exp) return null;
  return payload;
}

// --- key generation ---

function randomKeySuffix(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// A prefix segment must be a safe, single path segment (no traversal, no slashes).
function safePrefix(prefix: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) throw new BadRequest("invalid file prefix");
  return prefix;
}

// Sanitize a filename for the QUOTED part of a Content-Disposition header: strip quotes /
// backslashes (header injection) and everything outside printable ASCII, then bound length.
// The non-ASCII fold is not cosmetic — `Headers.set` takes a WebIDL ByteString and THROWS on
// any code point above U+00FF, so an uploaded `报告.pdf` would 500 its own download.
function safeFilename(name: string): string {
  return codePoints(name, 255).replace(/[^\x20-\x7e]|["\\]/g, "_");
}

// RFC 5987 `ext-value`: percent-encode UTF-8, escaping the four chars encodeURIComponent
// leaves behind that are not `attr-char` (' ( ) *).
function rfc5987(name: string): string {
  return encodeURIComponent(codePoints(name, 255)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Truncate by CODE POINT, not UTF-16 unit — a raw slice can cut a surrogate pair in half —
// and drop unpaired surrogates, which `encodeURIComponent` throws a URIError on. They can
// arrive in the INPUT, not just from truncation: JSON admits "\ud800", and one survives the
// signed token intact (JSON.stringify escapes it back to ASCII, so the TextEncoder never
// folds it to U+FFFD, and JSON.parse restores it). Unthrown, that 500s every download of the
// file, forever. `Array.from` iterates code points, so a lone surrogate is a 1-unit element
// while a real pair is 2.
function codePoints(name: string, max: number): string {
  const lone = (c: string) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff;
  return Array.from(name).filter((c) => !lone(c)).slice(0, max).join("");
}

// The full header value: an ASCII-only quoted fallback for old clients, plus the `filename*`
// parameter that every current browser prefers — so a non-ASCII name survives the round trip.
function contentDisposition(name: string): string {
  return `attachment; filename="${safeFilename(name)}"; filename*=UTF-8''${rfc5987(name)}`;
}

// --- Files facade (ctx.files) ---

export interface FilesConfig {
  tenant: string;
  secret: string;
  adapter: StorageAdapter;
  /** Worker base path for file endpoints (default "/files"). */
  basePath?: string;
}

/** A file token secret must be present and non-trivial, else upload/download tokens
 * would be forgeable (HMAC over an empty/weak key). Below this, file storage is
 * treated as unconfigured — fail closed rather than mint forgeable urls. The dev
 * defaults satisfy it; production should set a strong, random FILES_SECRET. */
export const MIN_FILES_SECRET_LEN = 16;
export function isUsableFilesSecret(secret: string | undefined | null): secret is string {
  return typeof secret === "string" && secret.length >= MIN_FILES_SECRET_LEN;
}
const filesUnconfigured = () =>
  new PramenError("file storage is not configured (set a strong FILES_SECRET)", 503, "unavailable");

/** Construct the per-tenant `ctx.files` facade. */
export function createFiles(cfg: FilesConfig): Files {
  const base = cfg.basePath ?? "/files";
  const prefix = `${cfg.tenant}/`;

  const ensureOwnKey = (key: string): string => {
    if (typeof key !== "string" || !key.startsWith(prefix)) throw new BadRequest("file key is outside this tenant");
    return key;
  };

  return {
    async signUpload(opts) {
      if (!isUsableFilesSecret(cfg.secret)) throw filesUnconfigured();
      const ct = opts.contentType || "application/octet-stream";
      const seg = opts.prefix ? `${safePrefix(opts.prefix)}/` : "";
      const key = `${prefix}${seg}${randomKeySuffix()}`;
      const exp = Math.floor(Date.now() / 1000) + (opts.expiresIn ?? 900);
      const token = await signToken({ t: cfg.tenant, k: key, op: "put", exp, ct, max: opts.maxSize, fn: opts.filename }, cfg.secret);
      const ref: FileRef = { key, size: 0, contentType: ct, filename: opts.filename, uploadedAt: Date.now() };
      return { url: `${base}/upload?token=${encodeURIComponent(token)}`, ref };
    },

    async signDownload(ref, opts) {
      if (!isUsableFilesSecret(cfg.secret)) throw filesUnconfigured();
      const r = typeof ref === "string" ? { key: ref } : ref;
      const key = ensureOwnKey(r.key);
      const exp = Math.floor(Date.now() / 1000) + (opts?.expiresIn ?? 3600);
      const fn = opts?.download ? (typeof ref === "string" ? undefined : ref.filename) : undefined;
      const token = await signToken({ t: cfg.tenant, k: key, op: "get", exp, fn }, cfg.secret);
      return { url: `${base}/download?token=${encodeURIComponent(token)}`, expiresAt: exp * 1000 };
    },

    head: (key) => cfg.adapter.head(ensureOwnKey(key)),
    delete: (key) => cfg.adapter.delete(ensureOwnKey(key)),
  };
}

// --- Worker endpoint: /files/upload (PUT) and /files/download (GET) ---

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  // Neither is CORS-safelisted, so without this a browser client that `fetch()`es a download
  // (rather than navigating to it) reads both as null — and the filename encoding below
  // would be invisible to exactly the cross-origin SPAs `CORS_ORIGINS` exists for.
  "access-control-expose-headers": "content-disposition, content-length",
};

const fileError = (status: number, code: string, msg: string) =>
  Response.json({ ok: false, error: msg, code }, { status, headers: CORS });

/** Serve the file endpoints. Returns a Response for any `/files/*` path, or null
 * if the request is not a file request (so the caller can keep routing). */
export async function handleFileRequest(
  request: Request,
  opts: { adapter: StorageAdapter; secret: string },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/files/")) return null;

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const isUpload = url.pathname === "/files/upload";
  const isDownload = url.pathname === "/files/download";
  if (!isUpload && !isDownload) return fileError(404, "not_found", "no such file endpoint");

  // Fail closed: without a usable secret, never verify a token (it would accept
  // forgeable ones signed with the empty/weak key).
  if (!isUsableFilesSecret(opts.secret)) return fileError(503, "unavailable", "file storage is not configured");

  const raw = url.searchParams.get("token");
  if (!raw) return fileError(401, "unauthorized", "missing token");
  const token = await verifyToken(raw, opts.secret);
  if (!token) return fileError(403, "forbidden", "invalid or expired token");

  try {
    if (isUpload) {
      if (request.method !== "PUT") return fileError(405, "method_not_allowed", "use PUT to upload");
      if (token.op !== "put") return fileError(403, "forbidden", "token is not an upload token");

      // Size cap. R2 requires a known length for a streamed body, so a capped upload
      // must declare a content-length — that closes the "length-less unbounded body"
      // hole (an over-declared body would also fail R2's stream-length check, and a
      // mismatched short declaration can't exceed the cap). The post-put check is a
      // safety net for buffering adapters (MemoryAdapter).
      if (token.max != null) {
        const cl = request.headers.get("content-length");
        const declared = cl == null ? NaN : Number(cl);
        if (!Number.isFinite(declared)) {
          return fileError(411, "length_required", "content-length is required for size-capped uploads");
        }
        if (declared > token.max) return fileError(413, "too_large", "file exceeds the maximum size");
      }

      const result = await opts.adapter.put(token.k, request.body, { contentType: token.ct });
      if (token.max != null && result.size > token.max) {
        await opts.adapter.delete(token.k).catch(() => {});
        return fileError(413, "too_large", "file exceeds the maximum size");
      }
      return Response.json(
        { ok: true, result: { key: token.k, size: result.size, contentType: token.ct, etag: result.etag } },
        { headers: CORS },
      );
    }

    // download
    if (request.method !== "GET") return fileError(405, "method_not_allowed", "use GET to download");
    if (token.op !== "get") return fileError(403, "forbidden", "token is not a download token");

    const obj = await opts.adapter.get(token.k);
    if (!obj) return fileError(404, "not_found", "file not found");

    const headers = new Headers(CORS);
    headers.set("content-type", obj.contentType ?? token.ct ?? "application/octet-stream");
    headers.set("content-length", String(obj.size));
    // Never let the browser sniff a user-uploaded blob into an executable type.
    headers.set("x-content-type-options", "nosniff");
    if (token.fn) headers.set("content-disposition", contentDisposition(token.fn));
    return new Response(obj.body, { headers });
  } catch (err) {
    if (err instanceof PramenError) return fileError(err.status, err.code, err.message);
    console.error("pramen: file endpoint error", err);
    return fileError(500, "internal", "internal error");
  }
}

// A media key is `<tenant>/media/<...>` — the `media/` prefix (set by @pramen/cms's
// signMediaUpload) is what makes a blob PUBLIC. This guard ensures the public /media
// route can only serve media-prefixed blobs, never a signed private attachment.
const MEDIA_KEY = /^[^/]+\/media\/[^/][^\0]*$/;

/** Serve a PUBLIC media blob by key: `GET /media/<key>`. Cache-friendly + nosniff, no
 * auth (published-site assets are public; the random tenant-scoped key is the capability).
 * Returns a Response for any `/media/*` path, or null if not a media request. Restricted
 * to `<tenant>/media/` keys so it can't serve arbitrary (e.g. signed-private) objects. */
export async function handleMediaRequest(
  request: Request,
  opts: { adapter: StorageAdapter },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/media/")) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return fileError(405, "method_not_allowed", "use GET");

  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice("/media/".length));
  } catch {
    return fileError(400, "bad_request", "invalid media path");
  }
  if (key.includes("..") || !MEDIA_KEY.test(key)) return fileError(404, "not_found", "no such media");

  const obj = await opts.adapter.get(key);
  if (!obj) return fileError(404, "not_found", "media not found");
  const headers = new Headers();
  headers.set("content-type", obj.contentType ?? "application/octet-stream");
  headers.set("content-length", String(obj.size));
  // Blobs are immutable (random keys), so cache hard; never sniff into an executable type.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : obj.body, { headers });
}
