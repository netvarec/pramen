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
    // The shape `getPage` hands the site. `label` is a string in every branch; that is the
    // whole bug, expressed as a type the renderer can rely on.
    const resolved = { url: "/media/main/media/abc123", alt: "Tenisový kurt v ranním světle" };
    const { id, label, hasValue } = mediaFieldValue(resolved);
    expect(id).toBeNull();
    expect(typeof label).toBe("string");
    expect(label).toBe("/media/main/media/abc123");
    expect(hasValue).toBe(true);
  });

  test("an unrecognised value still offers `clear` — that is how it gets repaired", () => {
    // Not `id !== null`: the whole point is that the picker cannot represent this value, so
    // the only way back to a clean field from inside the editor is to clear it.
    expect(mediaFieldValue({ url: "/figma/imgComponent14.jpg", alt: "x" }).hasValue).toBe(true);
    expect(mediaFieldValue({ nonsense: true }).hasValue).toBe(true);
    expect(mediaFieldValue(42).hasValue).toBe(false);
  });

  test("an object with no usable url reads as empty rather than as junk", () => {
    expect(mediaFieldValue({ alt: "no url here" }).label).toBe("");
    expect(mediaFieldValue({ url: 42 }).label).toBe("");
  });
});
