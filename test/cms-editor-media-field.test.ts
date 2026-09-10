// What a `media` field's control makes of the value it is handed.
//
// The field's TYPE says "a media id". The column is free-form JSON and the editor is not its
// only writer, so the value can be anything: a seeded page, an import, or a value that made
// the round trip out of the public read API, where `getPage` resolves a media id into
// `{ url, alt, … }` so the site can render it. One such object reached `MediaField`, which
// rendered it as the fallback for a missing filename — and React refuses an object as a
// child, so the crash took out the whole `/pages/:id` route through the router's error
// boundary. Every page holding one became unopenable in the editor while still rendering
// perfectly on the site, which is the part that made it hard to see.
//
// The narrowing is therefore a pure function, and these are its contract.

import { describe, expect, test } from "bun:test";
import { validateFields, type FieldDefinition } from "@pramen/cms";
import { mediaFieldValue } from "../packages/cms-editor/src/fields";

describe("a media field's value, as the control has to treat it", () => {
  test("a media id is looked up and shown", () => {
    expect(mediaFieldValue("8824bd53-1e7f-435c-8a1c-ffe6")).toEqual({
      id: "8824bd53-1e7f-435c-8a1c-ffe6",
      label: "8824bd53-1e7f-435c-8a1c-ffe6",
      hasValue: true,
    });
  });

  test("an empty field looks up nothing and offers no clear", () => {
    for (const empty of [null, undefined, ""]) {
      expect(mediaFieldValue(empty)).toEqual({ id: null, label: "", hasValue: false });
    }
  });

  test("a RESOLVED media value is not an id — and never reaches the DOM as an object", () => {
    // The shape `getPage` hands the site — minus its `id`, which is the case below.
    // `label` is a string in every branch; that is the whole bug, expressed as a type the
    // renderer can rely on.
    const resolved = { url: "/media/main/media/abc123", alt: "Tenisový kurt v ranním světle" };
    const { id, label, hasValue } = mediaFieldValue(resolved);
    expect(id).toBeNull();
    expect(typeof label).toBe("string");
    expect(label).toBe("/media/main/media/abc123");
    expect(hasValue).toBe(true);
  });

  test("a resolved value carries the id it came from, and that id is used", () => {
    // `ResolvedMedia` is `{ id, key, url, alt, contentType, filename }` — the id survives the
    // round trip, so this corruption is fully recoverable: the field resolves and renders as
    // if nothing were wrong, and the next save writes the bare id back.
    expect(
      mediaFieldValue({
        id: "8824bd53-1e7f-435c-8a1c-ffe6",
        key: "main/media/abc123",
        url: "/media/main/media/abc123",
        alt: null,
        contentType: "image/jpeg",
        filename: "kurt.jpg",
      }),
    ).toEqual({ id: "8824bd53-1e7f-435c-8a1c-ffe6", label: "8824bd53-1e7f-435c-8a1c-ffe6", hasValue: true });
    // An `id` that is not a usable string falls back to the url rather than being trusted.
    expect(mediaFieldValue({ id: 42, url: "/media/x" }).id).toBeNull();
    expect(mediaFieldValue({ id: "", url: "/media/x" }).label).toBe("/media/x");
  });

  test("an unrecognised value still offers `clear` — that is how it gets repaired", () => {
    // Not `id !== null`: the whole point is that the picker cannot represent this value, so
    // the only way back to a clean field from inside the editor is to clear it. A bare
    // primitive counts — the server's `media` check names a number as exactly what a bad
    // writer puts here, and without a clear button it is indistinguishable from an empty
    // field while every save 400s.
    expect(mediaFieldValue({ url: "/figma/imgComponent14.jpg", alt: "x" }).hasValue).toBe(true);
    expect(mediaFieldValue({ nonsense: true }).hasValue).toBe(true);
    expect(mediaFieldValue(42)).toEqual({ id: null, label: "42", hasValue: true });
    expect(mediaFieldValue(true)).toEqual({ id: null, label: "true", hasValue: true });
  });

  test("an object with no usable url reads as empty rather than as junk", () => {
    expect(mediaFieldValue({ alt: "no url here" }).label).toBe("");
    expect(mediaFieldValue({ url: 42 }).label).toBe("");
  });
});

// The other half of the same bug. Opening the page is not enough: the editor autosaves the
// WHOLE fields bag, so a block holding one of these values sends it straight back on an edit
// to an unrelated field — and `validateFields` rejected it, naming a field the editor never
// touched, on every save, forever.
describe("a stored non-id media value does not block an unrelated edit", () => {
  const schema: FieldDefinition[] = [
    { name: "image", type: "media" },
    { name: "heading", type: "text" },
  ];
  const stored = { image: { url: "/media/main/media/abc123", alt: "x" }, heading: "before" };

  test("echoing back exactly what is stored is tolerated", () => {
    // Reference equality would never hold here — the bag has been through JSON — so this is
    // a value comparison, unlike `richtext`, whose tolerated value is a string.
    const edit = { image: { url: "/media/main/media/abc123", alt: "x" }, heading: "after" };
    expect(() => validateFields(schema, edit, "", { legacyBaseline: stored })).not.toThrow();
  });

  test("a DIFFERENT non-id value is still rejected", () => {
    // The carve-out must not become a way to introduce one.
    const attack = { image: { url: "//evil/x.jpg" }, heading: "after" };
    expect(() => validateFields(schema, attack, "", { legacyBaseline: stored })).toThrow(/must be a media id/);
    expect(() => validateFields(schema, attack, "", {})).toThrow(/must be a media id/);
    // No baseline at all is the strict default — a fresh write cannot smuggle one in.
    expect(() => validateFields(schema, stored, "", {})).toThrow(/must be a media id/);
  });

  test("a real media id is unaffected either way", () => {
    const ok = { image: "8824bd53-1e7f-435c-8a1c-ffe6", heading: "after" };
    expect(() => validateFields(schema, ok, "", { legacyBaseline: stored })).not.toThrow();
    expect(() => validateFields(schema, ok, "", {})).not.toThrow();
  });
});
