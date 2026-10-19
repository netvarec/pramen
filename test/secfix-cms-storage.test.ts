// Security regressions for the object-store routes: which stored content types get the
// active-document sandbox, which ones may be declared at all, and how long a public /media
// answer may be cached once purging is a takedown.

import { describe, expect, test } from "bun:test";
import { createFiles, handleMediaRequest, isActiveType, isSingleMimeType, MEDIA_MAX_AGE, MemoryAdapter } from "../packages/server/src/runtime/storage";

describe("isActiveType covers what a browser renders as a document", () => {
  test("the XML family and XSLT are active", () => {
    for (const t of ["application/rss+xml", "application/atom+xml", "application/mathml+xml", "application/vnd.dummy+xml", "text/xsl", "application/xslt+xml", "multipart/x-mixed-replace"]) {
      expect(isActiveType(t)).toBe(true);
    }
  });

  test("a comma list is active if ANY member is (browsers resolve it to the last valid one)", () => {
    expect(isActiveType("text/plain, text/html")).toBe(true);
    expect(isActiveType("image/svg+xml,")).toBe(true);
    expect(isActiveType("image/svg+xml , image/svg+xml")).toBe(true);
    expect(isActiveType("image/png, image/jpeg")).toBe(false);
  });

  test("a value that does not parse as a MIME type fails toward the sandbox", () => {
    expect(isActiveType("html")).toBe(true);
    expect(isActiveType("text/")).toBe(true);
  });

  test("inert media is still left alone", () => {
    for (const t of ["image/png", "video/mp4", "application/pdf", "text/plain; charset=utf-8", "application/octet-stream"]) {
      expect(isActiveType(t)).toBe(false);
    }
  });
});

describe("an upload declares exactly one MIME type", () => {
  const files = createFiles({ tenant: "main", secret: "secfix-dummy-secret-0123456789", adapter: new MemoryAdapter() });

  test("a list or a malformed value is refused at signing", async () => {
    for (const ct of ["text/plain, text/html", "image/svg+xml,", "html", "text/html\r\nx-evil: 1"]) {
      await expect(files.signUpload({ contentType: ct })).rejects.toThrow(/single MIME type/);
    }
  });

  test("ordinary types, with parameters, are accepted", async () => {
    expect(isSingleMimeType("image/png")).toBe(true);
    expect(isSingleMimeType('text/plain; charset="utf-8"')).toBe(true);
    await expect(files.signUpload({ contentType: "image/svg+xml" })).resolves.toBeTruthy();
  });
});

describe("/media is cached for a bounded time, never immutable", () => {
  test("a whole answer carries a bounded max-age a purge can outlast", async () => {
    const adapter = new MemoryAdapter();
    await adapter.put("main/media/x", new Response("bytes").body, { contentType: "image/png" });
    const res = (await handleMediaRequest(new Request("https://x.test/media/main/media/x"), { adapter }))!;
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control")!;
    expect(cc).not.toContain("immutable");
    expect(cc).toBe(`public, max-age=${MEDIA_MAX_AGE}`);
    expect(MEDIA_MAX_AGE).toBeLessThanOrEqual(24 * 3600);
  });
});
