// File storage: the object-store seam, mirroring the Driver/Dialect seam for SQL.
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
// needs to know its own public origin: the client resolves them against its base.

import { BadRequest, PramenError } from "./errors";
import type { Files, FileRef, HeadResult } from "../sdk/files";
import { signToken, verifyToken, isUsableSecret, MIN_TOKEN_SECRET_LEN, type ExpiringToken } from "./token";

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
  /** Size of the WHOLE object, also when only a range of it is in `body`. */
  size: number;
  contentType?: string;
  /** Quoted HTTP entity tag, when the store has one (for `ETag` / `If-Range`). */
  etag?: string;
  /** The byte range `body` holds, resolved against `size`. Set by an adapter that honoured
   * `GetOpts.range`; an adapter that ignores the option leaves it unset and hands back the
   * whole object. An adapter that READS a range MUST report it here: unset is taken to mean
   * "whole object", and the route cannot tell a slice from the whole without reading it. */
  range?: ByteRange;
}
/** A byte range: `length` bytes from `offset`, both resolved against the object's size. */
export interface ByteRange {
  offset: number;
  length: number;
}
/** A requested range, not yet resolved against the object's size (the shape of `R2Range`, so
 * it is resolved by the store in the same call that reads it, with no `head` first). */
export type RangeRequest = { offset: number; length?: number } | { suffix: number };
export interface GetOpts {
  /** Read only this part of the object (an HTTP `Range` request). An adapter that honours it
   * throws `RangeNotSatisfiable` when the range starts past the end. */
  range?: RangeRequest;
}

/** Thrown by `StorageAdapter.get` for a range that starts past the end of the object: the
 * caller answers 416 and needs the object's size to say so. */
export class RangeNotSatisfiable extends Error {
  constructor(readonly size: number) {
    super(`range not satisfiable for an object of ${size} bytes`);
  }
}

/** Resolve a requested range against an object of `size` bytes: an end past the object is
 * clamped, a suffix longer than it is the whole object, and a start at or past the end is
 * `null` (unsatisfiable). */
export function resolveRange(req: RangeRequest, size: number): ByteRange | null {
  if ("suffix" in req) {
    const length = Math.min(req.suffix, size);
    return length > 0 ? { offset: size - length, length } : null;
  }
  if (req.offset >= size) return null;
  const length = Math.min(req.length ?? size - req.offset, size - req.offset);
  return length > 0 ? { offset: req.offset, length } : null;
}

export interface StorageAdapter {
  put(
    key: string,
    body: ReadableStream | ArrayBuffer | Uint8Array | null,
    opts?: { contentType?: string },
  ): Promise<PutResult>;
  get(key: string, opts?: GetOpts): Promise<GetResult | null>;
  head(key: string): Promise<HeadResult | null>;
  delete(key: string): Promise<void>;
}

/** R2, the Cloudflare default. Wraps an R2 bucket binding. Streaming: bytes flow
 * directly between the client and R2 in the Worker, never through the DO. */
export class R2Adapter implements StorageAdapter {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array | null, opts?: { contentType?: string }): Promise<PutResult> {
    const obj = await this.bucket.put(key, body as ReadableStream, {
      httpMetadata: opts?.contentType ? { contentType: opts.contentType } : undefined,
    });
    return { key, size: obj?.size ?? 0, etag: obj?.etag };
  }

  async get(key: string, opts?: GetOpts): Promise<GetResult | null> {
    const req = opts?.range;
    let obj: R2ObjectBody | null;
    try {
      obj = await this.bucket.get(key, req ? { range: req } : undefined);
    } catch (err) {
      // R2 refuses a range that starts past the end rather than clamping it. Only then is the
      // size worth a second operation: to tell that apart from a real failure, and to name it.
      if (!req) throw err;
      const head = await this.bucket.head(key);
      if (!head) return null;
      if (!resolveRange(req, head.size)) throw new RangeNotSatisfiable(head.size);
      throw err;
    }
    if (!obj) return null;
    let range: ByteRange | undefined;
    if (req) {
      // Report what R2 SAYS it read, not what was asked for: the route labels the body with
      // this, and a store that clamped or ignored the request would otherwise be mislabelled.
      // R2 echoes an `R2Range`, which may still be in suffix / open-ended form, and carries
      // every key (workerd's has `suffix: undefined` beside an offset), so test values, not keys.
      const got = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
      if (got) {
        const r = resolveRange(got.suffix != null ? { suffix: got.suffix } : { offset: got.offset ?? 0, length: got.length }, obj.size);
        if (!r) throw new RangeNotSatisfiable(obj.size);
        range = r;
      }
    }
    return { body: obj.body, size: obj.size, contentType: obj.httpMetadata?.contentType, etag: obj.httpEtag, range };
  }

  async head(key: string): Promise<HeadResult | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return { size: obj.size, contentType: obj.httpMetadata?.contentType, etag: obj.httpEtag };
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

  async get(key: string, opts?: GetOpts): Promise<GetResult | null> {
    const e = this.store.get(key);
    if (!e) return null;
    const size = e.bytes.byteLength;
    let r: ByteRange | undefined;
    if (opts?.range) {
      const resolved = resolveRange(opts.range, size);
      if (!resolved) throw new RangeNotSatisfiable(size);
      r = resolved;
    }
    const bytes = r ? e.bytes.subarray(r.offset, r.offset + r.length) : e.bytes;
    return { body: bytesToStream(bytes), size, contentType: e.contentType, range: r };
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

// --- signed file tokens ---
//
// The HMAC/base64url machinery is shared with page-preview links and anything else that
// needs a signed capability url; it lives in runtime/token.ts. This file only declares
// what a FILE token carries.

interface FileToken extends ExpiringToken {
  /** tenant */ t: string;
  /** key */ k: string;
  /** op */ op: "get" | "put";
  /** content-type (put: enforced; get: disposition hint) */ ct?: string;
  /** max size in bytes (put only) */ max?: number;
  /** filename (download disposition) */ fn?: string;
}

const signFileToken = (token: FileToken, secret: string): Promise<string> => signToken(token, secret);

/** Verify a file token's signature + expiry; returns the payload or null. */
export const verifyFileToken = (raw: string, secret: string): Promise<FileToken | null> => verifyToken<FileToken>(raw, secret);

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
// The non-ASCII fold is not cosmetic: `Headers.set` takes a WebIDL ByteString and THROWS on
// any code point above U+00FF, so an uploaded `报告.pdf` would 500 its own download.
function safeFilename(name: string): string {
  return codePoints(name, 255).replace(/[^\x20-\x7e]|["\\]/g, "_");
}

// RFC 5987 `ext-value`: percent-encode UTF-8, escaping the four chars encodeURIComponent
// leaves behind that are not `attr-char` (' ( ) *).
function rfc5987(name: string): string {
  return encodeURIComponent(codePoints(name, 255)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Truncate by CODE POINT, not UTF-16 unit (a raw slice can cut a surrogate pair in half)
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
// parameter that every current browser prefers, so a non-ASCII name survives the round trip.
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
 * treated as unconfigured, failing closed rather than minting forgeable urls. The dev
 * defaults satisfy it; production should set a strong, random FILES_SECRET. */
export const MIN_FILES_SECRET_LEN = MIN_TOKEN_SECRET_LEN;
export const isUsableFilesSecret = isUsableSecret;
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
      const token = await signFileToken({ t: cfg.tenant, k: key, op: "put", exp, ct, max: opts.maxSize, fn: opts.filename }, cfg.secret);
      const ref: FileRef = { key, size: 0, contentType: ct, filename: opts.filename, uploadedAt: Date.now() };
      return { url: `${base}/upload?token=${encodeURIComponent(token)}`, ref };
    },

    async signDownload(ref, opts) {
      if (!isUsableFilesSecret(cfg.secret)) throw filesUnconfigured();
      const r = typeof ref === "string" ? { key: ref } : ref;
      const key = ensureOwnKey(r.key);
      const exp = Math.floor(Date.now() / 1000) + (opts?.expiresIn ?? 3600);
      const fn = opts?.download ? (typeof ref === "string" ? undefined : ref.filename) : undefined;
      const token = await signFileToken({ t: cfg.tenant, k: key, op: "get", exp, fn }, cfg.secret);
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
  "access-control-allow-headers": "content-type, authorization, range, if-range",
  // Neither is CORS-safelisted, so without this a browser client that `fetch()`es a download
  // (rather than navigating to it) reads both as null, and the filename encoding below
  // would be invisible to exactly the cross-origin SPAs `CORS_ORIGINS` exists for.
  "access-control-expose-headers": "content-disposition, content-length, content-range, accept-ranges, etag",
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
  const token = await verifyFileToken(raw, opts.secret);
  if (!token) return fileError(403, "forbidden", "invalid or expired token");

  try {
    if (isUpload) {
      if (request.method !== "PUT") return fileError(405, "method_not_allowed", "use PUT to upload");
      if (token.op !== "put") return fileError(403, "forbidden", "token is not an upload token");

      // Size cap. R2 requires a known length for a streamed body, so a capped upload
      // must declare a content-length, which closes the "length-less unbounded body"
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

    // Ranges here too: a private video behind `signDownload` needs them as much as a public
    // one does (Safari will not play it without a 206 for `bytes=0-1`).
    const headers = new Headers(CORS);
    // Never let the browser sniff a user-uploaded blob into an executable type.
    headers.set("x-content-type-options", "nosniff");
    if (token.fn) headers.set("content-disposition", contentDisposition(token.fn));
    return await serveObject(request, opts.adapter, token.k, {
      headers,
      fallbackContentType: token.ct,
      notFound: () => fileError(404, "not_found", "file not found"),
    });
  } catch (err) {
    if (err instanceof PramenError) return fileError(err.status, err.code, err.message);
    console.error("pramen: file endpoint error", err);
    return fileError(500, "internal", "internal error");
  }
}

// A media key is `<tenant>/media/<...>`, and the `media/` prefix (set by @pramen/cms's
// signMediaUpload) is what makes a blob PUBLIC. This guard ensures the public /media
// route can only serve media-prefixed blobs, never a signed private attachment.
const MEDIA_KEY = /^[^/]+\/media\/[^/][^\0]*$/;

/** Content types the browser treats as an ACTIVE DOCUMENT: one that can run script when
 * opened at the top level, rather than being rendered as inert media.
 *
 * `nosniff` stops a browser guessing its way INTO one of these; it does nothing when the
 * type is declared outright. And it is declared by the uploader: `signMediaUpload` takes
 * `contentType` from its input with no allow-list, so an editor can upload
 * `image/svg+xml` (a perfectly ordinary thing to want, since SVG is a real image format)
 * and that file, opened at `/media/<key>`, runs its own script on THIS origin.
 *
 * Which matters because of the embedded topology: `@pramen/cms-astro` mounts the editor on
 * the same origin that serves `/media`, and the editor keeps its session token in
 * `localStorage` there. So without this, "editor uploads an SVG, admin clicks Preview" is
 * an editor-to-admin token theft, and `setUserRoles` is admin-gated precisely because those
 * roles are not meant to be equivalent. */
const ACTIVE_TYPES = new Set(["text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml"]);

/** `sandbox` with no tokens is the maximally restrictive form: the response becomes an
 * opaque-origin document with scripts disabled, so it can neither run code nor reach this
 * origin's storage. `default-src 'none'` stops it fetching anything of its own.
 *
 * Applied ONLY to the active types, deliberately. Sandboxing everything would be simpler to
 * describe and would risk the browser's built-in PDF viewer, which is a plugin-ish surface a
 * blanket sandbox can disable, breaking a legitimate preview to defend against a type that
 * was never executable. An SVG still RENDERS under this; only its script does not run. */
const ACTIVE_TYPE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** Whether a stored content type needs the sandbox above. Parameters after `;` (a charset)
 * are stripped, so `text/html; charset=utf-8` is still html. */
export function isActiveType(contentType: string | null | undefined): boolean {
  const base = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return ACTIVE_TYPES.has(base);
}

/**
 * One `Range: bytes=…` request header, not yet resolved against a size (the store does that
 * in the same call that reads it). `null` means "serve the whole object": no header, a unit
 * other than bytes, several ranges (a multipart response is not worth it for media; answering
 * 200 with everything is allowed), or an end before the start. `bytes=-0` asks for nothing,
 * so it is `"unsatisfiable"` (416) whatever the size.
 */
export function parseRangeHeader(header: string | null | undefined): RangeRequest | "unsatisfiable" | null {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header ?? "");
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    const suffix = Number(b);
    return suffix === 0 ? "unsatisfiable" : { suffix };
  }
  const offset = Number(a);
  if (b === "") return { offset };
  const end = Number(b);
  return end < offset ? null : { offset, length: end - offset + 1 };
}

/**
 * GET/HEAD one stored object, honouring a single byte range. Shared by `/media/` and
 * `/files/download` so the two cannot drift. `headers` carries the route's own (CORS,
 * disposition, nosniff); `cacheControl` applies to a whole-object answer only.
 *
 * - A ranged GET is ONE store operation: the adapter resolves the range against the size it
 *   reads anyway. A `head` happens only where the size or validator is needed up front: a HEAD
 *   request, an `If-Range`, or `bytes=-0`.
 * - 206 only when the adapter REPORTS the range it read (`GetResult.range`). Without it the
 *   body may be the whole object (an adapter that ignores ranges) or, against the contract, a
 *   slice it forgot to report; either way it is a 200, and `content-length` is left off so a
 *   wrong length can never be declared over the body.
 * - A 206 is `private`: a shared cache keyed by URL alone would otherwise store two bytes as
 *   the object for a year (and the Workers Cache API throws on `put` of a 206).
 * - A zero-length object has no satisfiable range worth refusing, so it is a 200, empty.
 */
async function serveObject(
  request: Request,
  adapter: StorageAdapter,
  key: string,
  opts: { headers: Headers; notFound: () => Response; fallbackContentType?: string; cacheControl?: string },
): Promise<Response> {
  const headers = opts.headers;
  headers.set("accept-ranges", "bytes");
  const isHead = request.method === "HEAD";
  let req = parseRangeHeader(request.headers.get("range"));

  const describe = (meta: { contentType?: string; etag?: string }) => {
    const ct = meta.contentType ?? opts.fallbackContentType ?? "application/octet-stream";
    headers.set("content-type", ct);
    if (meta.etag) headers.set("etag", meta.etag);
    // Never sniff into, nor render as live, an executable type (see ACTIVE_TYPES).
    if (isActiveType(ct)) headers.set("content-security-policy", ACTIVE_TYPE_CSP);
  };
  const whole = (size: number | null, body: ReadableStream | null) => {
    if (size != null) headers.set("content-length", String(size));
    if (opts.cacheControl) headers.set("cache-control", opts.cacheControl);
    return new Response(isHead ? null : body, { status: 200, headers });
  };
  const partial = (r: ByteRange, size: number, body: ReadableStream | null) => {
    headers.set("content-range", `bytes ${r.offset}-${r.offset + r.length - 1}/${size}`);
    headers.set("content-length", String(r.length));
    headers.set("cache-control", "private, max-age=31536000, immutable");
    return new Response(isHead ? null : body, { status: 206, headers });
  };
  const unsatisfiable = (size: number) => {
    headers.set("content-range", `bytes */${size}`);
    headers.delete("content-length");
    return new Response(null, { status: 416, headers });
  };

  // HEAD, `If-Range` and `bytes=-0` are answered (or decided) from metadata alone.
  const ifRange = request.headers.get("if-range");
  if (isHead || req === "unsatisfiable" || (req && ifRange)) {
    const head = await adapter.head(key);
    if (!head) return opts.notFound();
    describe(head);
    // A validator that no longer matches means the client's earlier bytes are stale: send it
    // all. A date-form `If-Range` cannot be checked (no Last-Modified is served), same answer.
    if (req && ifRange && (!head.etag || ifRange !== head.etag)) req = null;
    if (req && head.size === 0) req = null;
    if (req === "unsatisfiable") return unsatisfiable(head.size);
    if (isHead) {
      if (!req) return whole(head.size, null);
      const r = resolveRange(req, head.size);
      return r ? partial(r, head.size, null) : unsatisfiable(head.size);
    }
  }

  let obj: GetResult | null;
  try {
    obj = await adapter.get(key, req ? { range: req } : undefined);
  } catch (err) {
    if (!(err instanceof RangeNotSatisfiable)) throw err;
    if (err.size !== 0) return unsatisfiable(err.size);
    obj = await adapter.get(key);
    req = null;
  }
  if (!obj) return opts.notFound();
  describe(obj);
  if (obj.range) return partial(obj.range, obj.size, obj.body);
  return whole(req ? null : obj.size, obj.body);
}

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

  // Byte ranges matter for video: Safari will not play one at all unless `bytes=0-1` comes
  // back as a 206, and seeking needs ranges in every browser.
  const headers = new Headers();
  headers.set("x-content-type-options", "nosniff");
  return serveObject(request, opts.adapter, key, {
    headers,
    notFound: () => fileError(404, "not_found", "media not found"),
    // Blobs are immutable (random keys), so a whole one caches hard.
    cacheControl: "public, max-age=31536000, immutable",
  });
}
