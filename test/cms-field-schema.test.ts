// @pramen/cms — validating an AUTHORED field schema (GitHub #9).
//
// `validateFields` checks a VALUE against a schema. This checks the SCHEMA. It did not need
// to exist while the only way to make a block type was a developer writing
// `defineBlockType(...)` in the repo, where tsc is the check. Now the editor authors types,
// so `fieldsSchema` arrives from a browser as free JSON into a `t.json()` column — and a
// malformed one is caught NOWHERE downstream: `FieldForm` renders nothing for an unknown
// type, `validateFields` is documented as lenient about them, and the field's content is
// silently lost on every save.

import { describe, expect, test } from "bun:test";
import {
  createCmsHandlers,
  FIELD_TYPES,
  MAX_FIELD_DEPTH,
  normalizeDefaultBlocks,
  normalizeFieldSchema,
  normalizeRegions,
} from "../packages/cms/src/index";
import { FIELD_TYPES as EDITOR_FIELD_TYPES } from "../packages/cms-editor/src/schema-builder";
import type { HandlerContext } from "@pramen/server";

describe("field schemas", () => {
  test("a field needs a usable name — it is an object key and a generated TS property", () => {
    expect(() => normalizeFieldSchema([{ name: "", type: "text" }])).toThrow(/must be a field name/);
    expect(() => normalizeFieldSchema([{ name: "my-field", type: "text" }])).toThrow(/must be a field name/);
    expect(() => normalizeFieldSchema([{ name: "1st", type: "text" }])).toThrow(/must be a field name/);
    expect(normalizeFieldSchema([{ name: "heading", type: "text" }])).toEqual([{ name: "heading", type: "text" }]);
  });

  test("two siblings cannot share a name", () => {
    // Two controls writing the same key means one of them can never be saved at all.
    expect(() => normalizeFieldSchema([{ name: "a", type: "text" }, { name: "a", type: "number" }])).toThrow(/declares 'a' twice/);
  });

  test("a nested group may reuse an outer name — it writes into its own bag", () => {
    expect(() => normalizeFieldSchema([
      { name: "title", type: "text" },
      { name: "card", type: "group", fields: [{ name: "title", type: "text" }] },
    ])).not.toThrow();
  });

  test("an unknown type is refused, not stored", () => {
    expect(() => normalizeFieldSchema([{ name: "a", type: "wysiwyg" }])).toThrow(/not a field type/);
  });

  test("each field is REBUILT, so a stale key from another type cannot ride along", () => {
    // Switching a field from `select` to `text` and back must not resurrect the old options.
    expect(normalizeFieldSchema([{ name: "a", type: "text", options: ["x"], referenceFrom: "h", junk: 1 }])).toEqual([{ name: "a", type: "text" }]);
  });

  test("a select needs options or a handler; a reference needs a handler", () => {
    expect(() => normalizeFieldSchema([{ name: "a", type: "select" }])).toThrow(/needs either/);
    expect(() => normalizeFieldSchema([{ name: "a", type: "select", options: ["x", "x"] }])).toThrow(/same option twice/);
    expect(normalizeFieldSchema([{ name: "a", type: "select", optionsFrom: "listCampaigns" }])[0]!.optionsFrom).toBe("listCampaigns");
    expect(() => normalizeFieldSchema([{ name: "a", type: "reference" }])).toThrow(/needs a `referenceFrom`/);
  });

  test("an empty group or repeater is refused — it is the shape of a half-finished edit", () => {
    expect(() => normalizeFieldSchema([{ name: "a", type: "group", fields: [] }])).toThrow(/at least one nested field/);
    expect(() => normalizeFieldSchema([{ name: "a", type: "repeater" }])).toThrow(/at least one nested field/);
  });

  test("a repeater's bounds must be orderable", () => {
    expect(() => normalizeFieldSchema([{ name: "a", type: "repeater", min: 3, max: 1, fields: [{ name: "b", type: "text" }] }])).toThrow(/above max/);
  });

  test("nesting is depth-capped", () => {
    let deep: Record<string, unknown> = { name: "leaf", type: "text" };
    for (let i = 0; i < MAX_FIELD_DEPTH; i++) deep = { name: `g${i}`, type: "group", fields: [deep] };
    expect(() => normalizeFieldSchema([deep])).toThrow(/nests deeper than/);
  });

  test("a slug's source must be a text field standing beside it", () => {
    expect(() => normalizeFieldSchema([{ name: "slug", type: "slug", from: "title" }])).toThrow(/not a field alongside it/);
    expect(() => normalizeFieldSchema([
      { name: "slug", type: "slug", from: "count" },
      { name: "count", type: "number" },
    ])).toThrow(/can only follow a text field/);
    // Forward references are legitimate — a slug may be declared before the title it follows.
    expect(() => normalizeFieldSchema([
      { name: "slug", type: "slug", from: "title" },
      { name: "title", type: "text" },
    ])).not.toThrow();
  });

  test("the editor's type list matches the server's", () => {
    // The editor offers exactly what the runtime knows: a type it offered and the server did
    // not would be a 400 on save, and one the server knew and it did not would be
    // unauthorable. It cannot import the list (no server dependency), so this is the check.
    expect(EDITOR_FIELD_TYPES).toEqual(FIELD_TYPES);
  });
});

describe("regions and default blocks", () => {
  test("a content type needs at least one region, with usable, distinct names", () => {
    expect(() => normalizeRegions([])).toThrow(/at least one region/);
    expect(() => normalizeRegions([{ name: "my region" }])).toThrow(/must be a region name/);
    // A HYPHEN is fine: a region name is only an object key on the assembled page, unlike a
    // field name, which `generateBlockTypes` emits as a TS property. Held to the stricter
    // rule it rejected names already stored, making such a type permanently unsavable.
    expect(normalizeRegions([{ name: "main-content" }])[0]!.name).toBe("main-content");
    // The assembled page is an object keyed by region name, so a duplicate silently
    // overwrites.
    expect(() => normalizeRegions([{ name: "a" }, { name: "a" }])).toThrow(/declares 'a' twice/);
  });

  test("an EMPTY allow-list means `any`, not `nothing`", () => {
    // A region that refuses every block type is almost always a half-finished edit, and it
    // is indistinguishable on screen from one that allows everything.
    expect(normalizeRegions([{ name: "a", allowedTypes: [] }])[0]!.allowedTypes).toBeNull();
    expect(normalizeRegions([{ name: "a" }])[0]!.allowedTypes).toBeNull();
    expect(normalizeRegions([{ name: "a", allowedTypes: ["hero", "hero"] }])[0]!.allowedTypes).toEqual(["hero"]);
  });

  test("a default block must name a region that exists and a type that region allows", () => {
    const regions = normalizeRegions([{ name: "hero", allowedTypes: ["hero"] }]);
    expect(() => normalizeDefaultBlocks([{ region: "nowhere", blockTypeSlug: "hero" }], regions)).toThrow(/does not declare/);
    expect(() => normalizeDefaultBlocks([{ region: "hero", blockTypeSlug: "rich_text" }], regions)).toThrow(/does not allow it/);
    expect(normalizeDefaultBlocks([{ region: "hero", blockTypeSlug: "hero" }], regions)).toHaveLength(1);
  });
});

describe("the type handlers hold the line", () => {
  const handlers = createCmsHandlers() as unknown as Record<string, { input?: (raw: unknown) => unknown; auth?: readonly string[] }>;
  const parse = (name: string, raw: unknown) => handlers[name]!.input!(raw);

  test("createBlockType validates the authored schema", () => {
    expect(() => parse("createBlockType", { name: "Hero", slug: "hero", fieldsSchema: [{ name: "a", type: "nope" }] })).toThrow(/not a field type/);
  });

  test("a block type's slug admits underscores, because it is a registry key and not a URL", () => {
    // `{ rich_text: RichText }` is the convention every existing schema uses.
    expect(parse("createBlockType", { name: "Rich Text", slug: "rich_text" })).toMatchObject({ slug: "rich_text" });
    expect(() => parse("createBlockType", { name: "x", slug: "Rich Text" })).toThrow(/must be a key/);
  });

  test("a content type's slug follows the same rule — both are registry keys", () => {
    // These were split (block types admitted `_`, content types did not) for no reason that
    // survives inspection: an underscore is as legal in the `/types/:slug` segment as
    // anywhere else in a URL, and the example ships `seeded_doc`.
    expect(parse("createContentType", { name: "x", slug: "my_type", regions: [{ name: "a" }] })).toMatchObject({ slug: "my_type" });
    expect(parse("createContentType", { name: "x", slug: "my-type", regions: [{ name: "a" }] })).toMatchObject({ slug: "my-type" });
    expect(() => parse("createContentType", { name: "x", slug: "My Type", regions: [{ name: "a" }] })).toThrow(/must be a key/);
  });

  test("authoring a type is editor-gated", () => {
    for (const name of ["createBlockType", "updateBlockType", "createContentType", "updateContentType"]) {
      expect((handlers[name] as { auth?: readonly string[] }).auth, name).toEqual(["editor", "admin"]);
    }
  });

  test("listCmsCapabilities is what tells the editor whether to offer any of this", () => {
    const caps = (createCmsHandlers() as unknown as { listCmsCapabilities: { run: (c: HandlerContext) => { canEdit: boolean } } })
      .listCmsCapabilities.run({ identity: { roles: ["reviewer"] } } as unknown as HandlerContext);
    expect(caps.canEdit).toBe(false);
  });
});
