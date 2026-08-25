// Rich-text helpers for the editor. Local mirrors of the @pramen/cms functions, kept here
// because the editor is a self-contained browser app with no server-package dependency —
// it speaks to the CMS purely over HTTP (see types.ts).

import type { RichTextDoc, RichTextNode } from "./types";

/** Is this value a rich-text document (rather than a legacy HTML string or a plain bag)? */
export function isRichTextDoc(v: unknown): v is RichTextDoc {
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as RichTextDoc).type === "doc";
}

/** The block-level node types that end a line when flattening to plain text. */
const BLOCK_TYPES = new Set(["paragraph", "heading", "listItem", "taskItem", "blockquote", "codeBlock", "horizontalRule"]);

/** Flatten a rich-text document to plain text — for list cells and collapsed-block
 * previews, which want the words without the structure. Mirrors `richTextToPlainText`
 * in @pramen/cms. */
export function richTextToPlainText(value: RichTextDoc | null | undefined): string {
  const parts: string[] = [];
  const walk = (nodes: readonly RichTextNode[]): void => {
    for (const node of nodes) {
      if (node.type === "text") parts.push(node.text ?? "");
      else if (node.type === "hardBreak") parts.push("\n");
      if (node.content) walk(node.content);
      if (BLOCK_TYPES.has(node.type)) parts.push("\n");
    }
  };
  walk(value?.content ?? []);
  return parts.join("").replace(/\n{2,}/g, "\n").trim();
}
