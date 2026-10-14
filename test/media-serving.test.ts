// `/media/<key>` is public, unauthenticated and INLINE: it is the preview path. Two
// properties of that route are load-bearing and neither is obvious from reading the handler.

import { describe, expect, test } from "bun:test";
import { handleMediaRequest, isActiveType, MemoryAdapter, parseByteRange, type StorageAdapter } from "../packages/server/src/runtime/storage";
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
  test("parseByteRange resolves the three forms against the size", () => {
    expect(parseByteRange("bytes=0-1", 10)).toEqual({ offset: 0, length: 2 });
    expect(parseByteRange("bytes=4-", 10)).toEqual({ offset: 4, length: 6 });
    expect(parseByteRange("bytes=-3", 10)).toEqual({ offset: 7, length: 3 });
    // An end past the object is clamped, a suffix longer than it is the whole object.
    expect(parseByteRange("bytes=8-99", 10)).toEqual({ offset: 8, length: 2 });
    expect(parseByteRange("bytes=-99", 10)).toEqual({ offset: 0, length: 10 });
  });

  test("whole object for no header, another unit, or several ranges", () => {
    expect(parseByteRange(null, 10)).toBeNull();
    expect(parseByteRange("items=0-1", 10)).toBeNull();
    expect(parseByteRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseByteRange("bytes=5-2", 10)).toBeNull();
  });

  test("a start past the end is unsatisfiable", () => {
    expect(parseByteRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-0", 10)).toBe("unsatisfiable");
  });

  const KEY = "main/media/0123456789abcdef";
  const serve = async (headers: Record<string, string> = {}, adapter?: StorageAdapter) => {
    const a = adapter ?? new MemoryAdapter();
    if (!adapter) await a.put(KEY, new TextEncoder().encode("0123456789"), { contentType: "video/mp4" });
    return (await handleMediaRequest(new Request(`https://x/media/${KEY}`, { headers }), { adapter: a }))!;
  };

  test("a range is a 206 with just those bytes", async () => {
    const res = await serve({ range: "bytes=2-5" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  test("no range is the whole object, and says ranges are accepted", async () => {
    const res = await serve();
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("0123456789");
  });

  test("an unsatisfiable range is a 416 that names the size", async () => {
    const res = await serve({ range: "bytes=50-" });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  // A third-party adapter written before `GetOpts` ignores the range and hands back the whole
  // object. Labelling that a 206 would make the player read the wrong bytes.
  test("an adapter that ignores the range gets a 200, not a mislabelled 206", async () => {
    const inner = new MemoryAdapter();
    await inner.put(KEY, new TextEncoder().encode("0123456789"), { contentType: "video/mp4" });
    const legacy: StorageAdapter = {
      put: (k, b, o) => inner.put(k, b, o),
      get: async (k) => {
        const r = await inner.get(k);
        return r && { body: r.body, size: r.size, contentType: r.contentType };
      },
      head: (k) => inner.head(k),
      delete: (k) => inner.delete(k),
    };
    const res = await serve({ range: "bytes=2-5" }, legacy);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect(await res.text()).toBe("0123456789");
  });
});
