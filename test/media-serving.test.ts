// `/media/<key>` is public, unauthenticated and INLINE: it is the preview path. Two
// properties of that route are load-bearing and neither is obvious from reading the handler.

import { describe, expect, test } from "bun:test";
import {
  createFiles,
  handleFileRequest,
  handleMediaRequest,
  isActiveType,
  MemoryAdapter,
  parseRangeHeader,
  resolveRange,
  type StorageAdapter,
} from "../packages/server/src/runtime/storage";
import { fallbackFilename } from "../packages/cms-editor/src/components";

describe("active content types are sandboxed", () => {
  // `signMediaUpload` takes `contentType` from its caller with no allow-list, and the media
  // route echoes it back. `nosniff` prevents a browser guessing its way INTO an executable
  // type; it does nothing when the type is declared outright. So an editor can upload an
  // SVG (an ordinary thing to want) and without a sandbox that file runs script on the
  // origin that, in the embedded topology, holds the editor's session token.
  test("the document types a browser will execute", () => {
    expect(isActiveType("image/svg+xml")).toBe(true);
    expect(isActiveType("text/html")).toBe(true);
    expect(isActiveType("application/xhtml+xml")).toBe(true);
    expect(isActiveType("text/xml")).toBe(true);
  });

  // Deliberately narrow: sandboxing everything would risk the browser's built-in PDF viewer,
  // breaking a legitimate preview to defend against bytes that were never executable.
  test("inert media is left alone", () => {
    for (const t of ["image/png", "image/jpeg", "image/webp", "video/mp4", "audio/mpeg", "application/pdf", "text/plain"]) {
      expect(isActiveType(t)).toBe(false);
    }
  });

  test("a charset parameter does not smuggle a type past the check", () => {
    expect(isActiveType("text/html; charset=utf-8")).toBe(true);
    expect(isActiveType("IMAGE/SVG+XML")).toBe(true);
    expect(isActiveType("  text/html  ")).toBe(true);
  });

  test("an absent or unknown type is not sandboxed", () => {
    expect(isActiveType(null)).toBe(false);
    expect(isActiveType(undefined)).toBe(false);
    expect(isActiveType("application/octet-stream")).toBe(false);
  });
});

describe("fallbackFilename", () => {
  const media = (contentType?: string, filename?: string) =>
    ({ id: "m-1", file: { key: "media/x", contentType, filename } }) as never;

  // Rows with no filename are a real state, not a defensive hypothetical: `createMedia`
  // stores whatever ref it is handed, and the media backfill writes `filename: null`.
  // Without a name the browser saves the file as `download`, with no extension.
  test("names an unnamed file after its id, with an extension from the content type", () => {
    expect(fallbackFilename(media("image/png"))).toBe("m-1.png");
    expect(fallbackFilename(media("application/pdf"))).toBe("m-1.pdf");
  });

  test("a structured-suffix type keeps only the base subtype", () => {
    expect(fallbackFilename(media("image/svg+xml"))).toBe("m-1.svg");
  });

  // The content type is caller-supplied, so it cannot be pasted into a filename unchecked:
  // a subtype carrying a path separator or a second extension is dropped, not sanitized
  // halfway.
  test("a subtype that is not a plausible extension is dropped entirely", () => {
    expect(fallbackFilename(media("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).toBe("m-1");
    expect(fallbackFilename(media("image/../../etc/passwd"))).toBe("m-1");
    expect(fallbackFilename(media(undefined))).toBe("m-1");
  });
});

// Video needs byte ranges: Safari will not play one unless `Range: bytes=0-1` comes back as a
// 206, and seeking needs ranges in every browser. The route used to answer every request with
// the whole object and a 200.
describe("byte ranges", () => {
  test("parseRangeHeader reads the three forms without needing a size", () => {
    expect(parseRangeHeader("bytes=0-1")).toEqual({ offset: 0, length: 2 });
    expect(parseRangeHeader("bytes=4-")).toEqual({ offset: 4 });
    expect(parseRangeHeader("bytes=-3")).toEqual({ suffix: 3 });
  });

  test("whole object for no header, another unit, several ranges, or an end before the start", () => {
    expect(parseRangeHeader(null)).toBeNull();
    expect(parseRangeHeader("items=0-1")).toBeNull();
    expect(parseRangeHeader("bytes=0-1,4-5")).toBeNull();
    expect(parseRangeHeader("bytes=5-2")).toBeNull();
    expect(parseRangeHeader("bytes=-0")).toBe("unsatisfiable");
  });

  test("resolveRange clamps the end and refuses a start past it", () => {
    expect(resolveRange({ offset: 4 }, 10)).toEqual({ offset: 4, length: 6 });
    expect(resolveRange({ suffix: 3 }, 10)).toEqual({ offset: 7, length: 3 });
    expect(resolveRange({ offset: 8, length: 92 }, 10)).toEqual({ offset: 8, length: 2 });
    expect(resolveRange({ suffix: 99 }, 10)).toEqual({ offset: 0, length: 10 });
    expect(resolveRange({ offset: 10 }, 10)).toBeNull();
    expect(resolveRange({ suffix: 5 }, 0)).toBeNull();
  });

  const KEY = "main/media/0123456789abcdef";
  const seeded = async (bytes = "0123456789") => {
    const a = new MemoryAdapter();
    await a.put(KEY, new TextEncoder().encode(bytes), { contentType: "video/mp4" });
    return a;
  };
  const serve = async (headers: Record<string, string> = {}, adapter?: StorageAdapter, method = "GET") =>
    (await handleMediaRequest(new Request(`https://x/media/${KEY}`, { headers, method }), { adapter: adapter ?? (await seeded()) }))!;

  // Counts store operations, and lets a test stand in a misbehaving adapter.
  const spy = (inner: StorageAdapter, get?: StorageAdapter["get"]) => {
    const calls = { get: 0, head: 0 };
    const adapter: StorageAdapter = {
      put: (k, b, o) => inner.put(k, b, o),
      get: (k, o) => (calls.get++, (get ?? inner.get.bind(inner))(k, o)),
      head: (k) => (calls.head++, inner.head(k)),
      delete: (k) => inner.delete(k),
    };
    return { adapter, calls };
  };

  test("a range is a 206 with just those bytes, from one store operation", async () => {
    const { adapter, calls } = spy(await seeded());
    const res = await serve({ range: "bytes=2-5" }, adapter);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("2345");
    expect(calls).toEqual({ get: 1, head: 0 });
  });

  // A shared cache keyed by URL alone would otherwise keep two bytes as the object for a year.
  test("a 206 is private, a whole object is publicly immutable", async () => {
    expect((await serve({ range: "bytes=0-1" })).headers.get("cache-control")).toStartWith("private");
    expect((await serve()).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("no range is the whole object, and says ranges are accepted", async () => {
    const res = await serve();
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("10");
    expect(await res.text()).toBe("0123456789");
  });

  test("an unsatisfiable range is a 416 that names the size", async () => {
    for (const range of ["bytes=50-", "bytes=-0"]) {
      const res = await serve({ range });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */10");
    }
  });

  // RFC 9110 has a suffix range satisfiable on an empty representation; nothing is gained by
  // refusing either form, and some players treat a 416 as a hard error.
  test("an empty object is a 200 whatever the range", async () => {
    for (const range of ["bytes=0-1", "bytes=-500"]) {
      const res = await serve({ range }, await seeded(""));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe("0");
    }
  });

  test("HEAD with a range answers from metadata and opens no body", async () => {
    const { adapter, calls } = spy(await seeded());
    const res = await serve({ range: "bytes=0-1" }, adapter, "HEAD");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-1/10");
    expect(res.headers.get("content-length")).toBe("2");
    expect(calls).toEqual({ get: 0, head: 1 });
  });

  test("an If-Range that does not match the etag gets the whole object", async () => {
    const inner = await seeded();
    const { adapter } = spy(inner);
    adapter.head = async (k) => ({ ...(await inner.head(k))!, etag: '"v2"' });
    const stale = await serve({ range: "bytes=2-5", "if-range": '"v1"' }, adapter);
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("0123456789");
    const fresh = await serve({ range: "bytes=2-5", "if-range": '"v2"' }, adapter);
    expect(fresh.status).toBe(206);
    expect(await fresh.text()).toBe("2345");
  });

  // A third-party adapter written before `GetOpts` ignores the range and hands back the whole
  // object. Labelling that a 206 would make the player read the wrong bytes.
  test("an adapter that ignores the range gets a 200, not a mislabelled 206", async () => {
    const inner = await seeded();
    const { adapter } = spy(inner, async (k) => {
      const r = await inner.get(k);
      return r && { body: r.body, size: r.size, contentType: r.contentType };
    });
    const res = await serve({ range: "bytes=2-5" }, adapter);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect(await res.text()).toBe("0123456789");
  });

  // The other way to get the contract wrong: read the slice, forget to report it. The route
  // cannot tell, so it must not declare the whole object's length over a two-byte body.
  test("an adapter that slices without reporting it never gets a wrong content-length", async () => {
    const inner = await seeded();
    const { adapter } = spy(inner, async (k, o) => {
      const r = await inner.get(k, o);
      return r && { body: r.body, size: r.size, contentType: r.contentType };
    });
    const res = await serve({ range: "bytes=2-5" }, adapter);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBeNull();
  });

  test("/files/download serves ranges too", async () => {
    const secret = "test-secret-at-least-32-characters-long";
    const adapter = new MemoryAdapter();
    await adapter.put("main/video", new TextEncoder().encode("0123456789"), { contentType: "video/mp4" });
    const { url } = await createFiles({ tenant: "main", secret, adapter }).signDownload("main/video");
    const res = (await handleFileRequest(new Request(`https://x${url}`, { headers: { range: "bytes=0-1" } }), { adapter, secret }))!;
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-1/10");
    expect(res.headers.get("access-control-expose-headers")).toContain("content-range");
    expect(await res.text()).toBe("01");
  });
});
