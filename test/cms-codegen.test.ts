// Unit test for @pramen/cms's generateBlockTypes (pure, no server boot).
import { test, expect } from "bun:test";
import { generateBlockTypes } from "@pramen/cms";
import type { FieldDefinition } from "@pramen/cms";

test("generateBlockTypes emits per-slug interfaces + a registry", () => {
  const blockTypes: Array<{ slug: string; fieldsSchema: FieldDefinition[] }> = [
    {
      slug: "hero",
      fieldsSchema: [
        { name: "heading", type: "text", required: true },
        { name: "subtitle", type: "text" },
        { name: "image", type: "media" },
        { name: "count", type: "number", required: true },
        { name: "items", type: "repeater", fields: [{ name: "label", type: "text", required: true }] },
      ],
    },
    { slug: "rich_text", fieldsSchema: [{ name: "body", type: "richtext", required: true }] },
  ];
  const out = generateBlockTypes(blockTypes);

  expect(out).toContain("export interface HeroFields {");
  expect(out).toContain('"heading": string;'); // required → no ?
  expect(out).toContain('"subtitle"?: string;'); // optional → ?
  expect(out).toContain('"image"?: ResolvedMedia | null;');
  expect(out).toContain('"count": number;');
  expect(out).toContain('"items"?: Array<{ "label": string; }>;'); // repeater of nested
  expect(out).toContain("export interface RichTextFields {");
  expect(out).toContain('"body": RichText;');
  expect(out).toContain("export interface BlockFieldsBySlug {");
  expect(out).toContain('"hero": HeroFields;');
  expect(out).toContain('"rich_text": RichTextFields;');
});

test("generateBlockTypes omits an import nothing references", () => {
  // Every tsconfig here sets noUnusedLocals, so an unconditional import is a TS6192 build
  // break in the consumer's project — in a file they are told not to edit.
  const out = generateBlockTypes([{ slug: "plain", fieldsSchema: [{ name: "title", type: "text" }] }]);
  expect(out).not.toContain("import type");
  const rich = generateBlockTypes([{ slug: "prose", fieldsSchema: [{ name: "body", type: "richtext" }] }]);
  expect(rich).toContain('import type { RichText } from "@pramen/cms";');
  expect(rich).not.toContain("ResolvedMedia");
});

test("generateBlockTypes refuses slugs that are not distinct TS identifiers", () => {
  // Slugs are webmaster-authored with no deploy, so nothing upstream guarantees this.
  expect(() => generateBlockTypes([{ slug: "2-col", fieldsSchema: [] }])).toThrow(/not an identifier/);
  expect(() =>
    generateBlockTypes([
      { slug: "rich-text", fieldsSchema: [] },
      { slug: "rich_text", fieldsSchema: [] },
    ]),
  ).toThrow(/collides/);
});
