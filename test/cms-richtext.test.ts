// Unit tests for @pramen/cms's structured rich text (pure — no server boot).
//
// `richtext` used to be an HTML string scrubbed with js-xss on write. It is now a document
// tree, and the write-path boundary is a STRUCTURAL allow-list: unknown node/mark types are
// dropped, only declared attributes survive, and a `link` href must pass a scheme check.

import { expect, test } from "bun:test";
import {
  DEFAULT_RICH_TEXT_SCHEMA,
  MAX_RICH_TEXT_DEPTH,
  isSafeHref,
  normalizeFields,
  normalizeRichText,
  richTextToPlainText,
  validateFields,
  type FieldDefinition,
  type RichTextDoc,
} from "@pramen/cms";

const doc = (...content: unknown[]): RichTextDoc => ({ type: "doc", content: content as RichTextDoc["content"] });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });

test("normalizeRichText keeps the allow-listed vocabulary", () => {
  const input = doc(
    { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
    para(text("plain "), text("bold", [{ type: "bold" }])),
    { type: "bulletList", content: [{ type: "listItem", content: [para(text("one"))] }] },
  );
  expect(normalizeRichText(input)).toEqual(input as RichTextDoc);
});

test("normalizeRichText drops unknown node types", () => {
  const out = normalizeRichText(doc(para(text("kept")), { type: "iframe", attrs: { src: "https://evil.example" } }));
  expect(out.content).toEqual([para(text("kept"))] as RichTextDoc["content"]);
});

test("normalizeRichText drops unknown marks but keeps the text", () => {
  const out = normalizeRichText(doc(para(text("hi", [{ type: "bold" }, { type: "onclick" }]))));
  expect(out.content).toEqual([para(text("hi", [{ type: "bold" }]))] as RichTextDoc["content"]);
});

test("normalizeRichText drops a link mark with an unsafe href", () => {
  const unsafe = doc(para(text("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])));
  // The MARK goes, not the text — an anchor with no destination is worse than plain text.
  expect(normalizeRichText(unsafe).content).toEqual([para(text("click"))] as RichTextDoc["content"]);

  const safe = doc(para(text("click", [{ type: "link", attrs: { href: "/about", title: "About" } }])));
  expect(normalizeRichText(safe)).toEqual(safe as RichTextDoc);
});

test("isSafeHref matches the editor's own link allow-list", () => {
  for (const ok of ["https://example.com", "http://example.com", "mailto:a@b.c", "tel:+420123", "/relative", "#anchor"]) {
    expect(isSafeHref(ok)).toBe(true);
  }
  for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>", "vbscript:x", "evil.com", 42, null]) {
    expect(isSafeHref(bad)).toBe(false);
  }
});

test("normalizeRichText keeps only declared attributes, and only JSON primitives", () => {
  const out = normalizeRichText(
    doc({ type: "heading", attrs: { level: 3, onclick: "steal()", nested: { a: 1 } }, content: [text("H")] }),
  );
  expect(out.content?.[0].attrs).toEqual({ level: 3 });
});

test("normalizeRichText rejects an out-of-range heading level", () => {
  const out = normalizeRichText(doc({ type: "heading", attrs: { level: 99 }, content: [text("H")] }));
  expect(out.content?.[0].attrs).toBeUndefined();
});

test("normalizeRichText yields an empty doc for a non-document value", () => {
  expect(normalizeRichText("<p>legacy html</p>")).toEqual({ type: "doc", content: [] });
  expect(normalizeRichText(null)).toEqual({ type: "doc", content: [] });
});

test("a custom schema can widen or narrow the vocabulary", () => {
  const narrow = { nodes: { doc: [], paragraph: [], text: [] }, marks: {} };
  const out = normalizeRichText(doc(para(text("hi", [{ type: "bold" }])), { type: "heading", content: [text("H")] }), narrow);
  expect(out.content).toEqual([para(text("hi"))] as RichTextDoc["content"]);
  expect(DEFAULT_RICH_TEXT_SCHEMA.nodes.heading).toEqual(["level"]);
});

test("validateFields rejects a legacy HTML string with a message naming the migration", () => {
  const schema: FieldDefinition[] = [{ name: "body", type: "richtext" }];
  expect(() => validateFields(schema, { body: "<p>hi</p>" })).toThrow(/not an HTML string/);
  expect(() => validateFields(schema, { body: { type: "paragraph" } })).toThrow(/must be a rich-text document/);
  expect(() => validateFields(schema, { body: doc(para(text("ok"))) })).not.toThrow();
});

test("normalizeFields normalizes richtext nested in group and repeater", () => {
  const schema: FieldDefinition[] = [
    { name: "intro", type: "richtext" },
    { name: "meta", type: "group", fields: [{ name: "note", type: "richtext" }] },
    { name: "items", type: "repeater", fields: [{ name: "body", type: "richtext" }] },
    { name: "title", type: "text" },
  ];
  const evil = doc(para(text("x", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])));
  const out = normalizeFields(schema, {
    intro: evil,
    meta: { note: evil },
    items: [{ body: evil }],
    title: "untouched",
  });
  const clean = [para(text("x"))];
  expect((out.intro as RichTextDoc).content).toEqual(clean as RichTextDoc["content"]);
  expect(((out.meta as Record<string, RichTextDoc>).note).content).toEqual(clean as RichTextDoc["content"]);
  expect(((out.items as Record<string, RichTextDoc>[])[0].body).content).toEqual(clean as RichTextDoc["content"]);
  expect(out.title).toBe("untouched");
});

test("richTextToPlainText flattens to words with block boundaries", () => {
  const input = doc(
    { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
    para(text("Hello "), text("world", [{ type: "bold" }])),
    { type: "bulletList", content: [{ type: "listItem", content: [para(text("one"))] }, { type: "listItem", content: [para(text("two"))] }] },
  );
  expect(richTextToPlainText(input)).toBe("Title\nHello world\none\ntwo");
  expect(richTextToPlainText(null)).toBe("");
});

test("richTextToPlainText turns a hard break into a newline", () => {
  expect(richTextToPlainText(doc(para(text("a"), { type: "hardBreak" }, text("b"))))).toBe("a\nb");
});

// --- regression gates from the #36 review ------------------------------------

test("isSafeHref rejects a protocol-relative url", () => {
  // `//evil.example/x` looks site-relative but a browser resolves it as absolute
  // cross-origin. Not XSS, but this function is the boundary, not a UI hint.
  expect(isSafeHref("//evil.example/x")).toBe(false);
  expect(isSafeHref("/still-relative")).toBe(true);
  expect(isSafeHref("https://example.com//path")).toBe(true);
});

test("normalizeRichText caps recursion instead of blowing the stack", () => {
  // JSON.parse is iterative in V8, so a deeply nested payload reaches the normalizer
  // intact — and this runs inside the DO's storage.transaction().
  let node: Record<string, unknown> = { type: "text", text: "deep" };
  for (let i = 0; i < MAX_RICH_TEXT_DEPTH + 50; i++) node = { type: "blockquote", content: [node] };
  const out = normalizeRichText({ type: "doc", content: [node] });
  let depth = 0;
  let cursor = out.content?.[0];
  while (cursor?.content?.[0]) {
    cursor = cursor.content[0];
    depth++;
  }
  expect(depth).toBeLessThanOrEqual(MAX_RICH_TEXT_DEPTH + 1);
});

test("a legacy HTML string is tolerated — and kept — only where the bag holds stored data", () => {
  const schema: FieldDefinition[] = [{ name: "body", type: "richtext" }];
  const legacy = { body: "<p>stored before the migration</p>" };
  // Default: strict, because the value is new input.
  expect(() => validateFields(schema, legacy)).toThrow(/not an HTML string/);
  // allowLegacyRichText: the bag carries a row we already stored (placeBlock's merge).
  expect(() => validateFields(schema, legacy, "", { allowLegacyRichText: true })).not.toThrow();
  // And normalization must NOT turn it into an empty doc — that would delete the content.
  expect(normalizeFields(schema, legacy).body).toBe("<p>stored before the migration</p>");
});

test("richTextToPlainText gives a collapsed block something to show", () => {
  // The editor's block preview used to pick the first non-empty STRING field; a richtext
  // field is an object, so a prose-only block read "empty".
  const body = doc(para(text("Wide-ranging notes on the topic")));
  expect(richTextToPlainText(body)).toBe("Wide-ranging notes on the topic");
});
