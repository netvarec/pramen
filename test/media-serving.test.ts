// `/media/<key>` is public, unauthenticated and INLINE — it is the preview path. Two
// properties of that route are load-bearing and neither is obvious from reading the handler.

import { describe, expect, test } from "bun:test";
import { isActiveType } from "../packages/server/src/runtime/storage";
import { fallbackFilename } from "../packages/cms-editor/src/components";

describe("active content types are sandboxed", () => {
  // `signMediaUpload` takes `contentType` from its caller with no allow-list, and the media
  // route echoes it back. `nosniff` prevents a browser guessing its way INTO an executable
  // type; it does nothing when the type is declared outright. So an editor can upload an
  // SVG — an ordinary thing to want — and without a sandbox that file runs script on the
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

  // The content type is caller-supplied, so it cannot be pasted into a filename unchecked —
  // a subtype carrying a path separator or a second extension is dropped, not sanitized
  // halfway.
  test("a subtype that is not a plausible extension is dropped entirely", () => {
    expect(fallbackFilename(media("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).toBe("m-1");
    expect(fallbackFilename(media("image/../../etc/passwd"))).toBe("m-1");
    expect(fallbackFilename(media(undefined))).toBe("m-1");
  });
});
