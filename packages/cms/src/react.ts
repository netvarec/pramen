// @pramen/cms/react — the headless renderer. Like WollyCMS's BlockRenderer, it maps a
// block's `block_type` slug to a React component from a registry you provide; the CMS
// stays headless and never dictates markup. Pair with useLiveQuery from @pramen/react
// for a live-updating page:
//
//   import { BlockRenderer, RegionRenderer } from "@pramen/cms/react";
//   const components = { hero: Hero, rich_text: RichText, cta: Cta };
//   const { data } = useLiveQuery(client, "getPage", { slug });   // AssembledPage
//   return RegionRenderer({ regions: data.regions, name: "content", components });
//
// Written with `createElement` (not JSX) so the package needs no DOM lib / JSX build
// config and stays on the same tsconfig as the rest of pramen. In a JSX codebase you'd
// normally write `<BlockRenderer .../>` — it's an ordinary component either way.

import { createElement, Fragment } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { isSafeHref } from "./index";
import type { RenderedBlock, BlockTypeDef, BlockFieldsOf, RichTextDoc, RichTextNode, RichTextMark } from "./index";

/** Props a component for a specific typed block type receives — `fields` is inferred from
 * the block type's schema via `BlockFieldsOf` (see `defineBlockType`). */
export interface TypedBlockProps<D extends BlockTypeDef> {
  fields: BlockFieldsOf<D>;
  block: RenderedBlock;
  region?: string;
  position: number;
}

/** A React component for a typed block type: `const Hero: TypedBlockComponent<typeof heroDef>`. */
export type TypedBlockComponent<D extends BlockTypeDef> = ComponentType<TypedBlockProps<D>>;

/** Props a block component receives. `fields` is the block's (override-merged) content. */
export interface BlockComponentProps {
  fields: Record<string, unknown>;
  block: RenderedBlock;
  region?: string;
  position: number;
}

export type BlockComponents = Record<string, ComponentType<BlockComponentProps>>;

export interface BlockRendererProps {
  blocks: RenderedBlock[];
  region?: string;
  components: BlockComponents;
  /** Rendered when no component is registered for a block's type. Defaults to a text node. */
  fallback?: ComponentType<{ block: RenderedBlock }>;
}

/** Render an ordered list of blocks, each via its registered component. */
export function BlockRenderer({ blocks, region, components, fallback }: BlockRendererProps): ReactElement {
  return createElement(
    Fragment,
    null,
    blocks.map((block, index) => {
      const Component = components[block.block_type];
      if (!Component) {
        return fallback
          ? createElement(fallback, { key: block.id, block })
          : createElement(Fragment, { key: block.id }, `Unknown block type: ${block.block_type}`);
      }
      return createElement(Component, { key: block.id, fields: block.fields, block, region, position: index });
    }),
  );
}

export interface RegionRendererProps {
  regions: Record<string, RenderedBlock[]>;
  name: string;
  components: BlockComponents;
  fallback?: ComponentType<{ block: RenderedBlock }>;
}

/** Render a single named region from an AssembledPage's `regions` map. */
export function RegionRenderer({ regions, name, components, fallback }: RegionRendererProps): ReactElement {
  return BlockRenderer({ blocks: regions[name] ?? [], region: name, components, fallback });
}

// --- rich text ----------------------------------------------------------------------
// A `richtext` field is a document tree, not an HTML string, so it renders as REAL React
// elements — no `dangerouslySetInnerHTML`, and nothing to sanitize at render time (the
// write path already dropped every node/mark outside the allow-list). Override any node
// type through `components` when your design system wants its own element.

/** Props a rich-text node component receives. `children` is the already-rendered subtree. */
export interface RichTextNodeProps {
  node: RichTextNode;
  children: ReactNode;
}

/** Per-node-type component overrides, keyed by node type (`"paragraph"`, `"heading"`, …). */
export type RichTextNodeComponents = Record<string, ComponentType<RichTextNodeProps>>;

const MARK_TAGS: Record<string, string> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strike: "s",
  code: "code",
  highlight: "mark",
};

/** Wrap a text leaf in its marks, innermost-first. A `link` is the only mark carrying
 * attributes we pass through; `target="_blank"` gets `rel` forced, since the renderer owns
 * the markup and a bare `_blank` hands the opened page a `window.opener` handle. */
function renderMarks(text: string, marks: RichTextMark[] | undefined): ReactNode {
  let out: ReactNode = text;
  for (const mark of marks ?? []) {
    if (mark.type === "link") {
      const attrs = mark.attrs ?? {};
      // The href is the one attribute that can execute script, and this renderer declares
      // itself a rescue for content that never passed through normalizeRichText (an app
      // writing rows via its own mutation, a bootstrap seed, an import). So check it here
      // too: an unsafe href drops the anchor and renders the text, never a live link.
      if (!isSafeHref(attrs.href)) continue;
      const target = typeof attrs.target === "string" ? attrs.target : undefined;
      out = createElement(
        "a",
        {
          href: String(attrs.href ?? ""),
          title: typeof attrs.title === "string" ? attrs.title : undefined,
          target,
          rel: target === "_blank" ? "noopener noreferrer" : undefined,
        },
        out,
      );
    } else {
      out = createElement(MARK_TAGS[mark.type] ?? "span", null, out);
    }
  }
  return out;
}

function renderRichTextNode(node: RichTextNode, key: number, components?: RichTextNodeComponents): ReactNode {
  if (node.type === "text") return createElement(Fragment, { key }, renderMarks(node.text ?? "", node.marks));

  const children = (node.content ?? []).map((child, i) => renderRichTextNode(child, i, components));
  const Override = components?.[node.type];
  if (Override) return createElement(Override, { key, node, children });

  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "paragraph":
      return createElement("p", { key }, children);
    case "heading": {
      // Range-checked, matching RichText.astro. Both renderers declare themselves a rescue
      // for hand-written content that never passed through normalizeRichText, so neither
      // may trust the attribute — an out-of-range level would emit <h0>/<h99>.
      // Integer too: `h2.5` throws InvalidCharacterError in document.createElement.
      const raw = attrs.level;
      const level = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 6 ? raw : 2;
      return createElement(`h${level}`, { key }, children);
    }
    case "blockquote":
      return createElement("blockquote", { key }, children);
    case "codeBlock":
      return createElement(
        "pre",
        { key },
        createElement("code", { className: typeof attrs.language === "string" ? `language-${attrs.language}` : undefined }, children),
      );
    case "bulletList":
      return createElement("ul", { key }, children);
    case "orderedList":
      return createElement("ol", { key, start: typeof attrs.start === "number" ? attrs.start : undefined }, children);
    case "listItem":
      return createElement("li", { key }, children);
    case "taskList":
      return createElement("ul", { key, "data-type": "taskList" }, children);
    case "taskItem":
      return createElement("li", { key, "data-type": "taskItem", "data-checked": attrs.checked === true ? "true" : "false" }, children);
    case "hardBreak":
      return createElement("br", { key });
    case "horizontalRule":
      return createElement("hr", { key });
    default:
      // Unreachable through the write path (normalizeRichText drops unknown types), so
      // rendering the subtree is a rescue for hand-written content, not a policy.
      return createElement(Fragment, { key }, children);
  }
}

export interface RichTextRendererProps {
  value: RichTextDoc | null | undefined;
  components?: RichTextNodeComponents;
}

/** Render a rich-text document as React elements. */
export function RichTextRenderer({ value, components }: RichTextRendererProps): ReactElement {
  return createElement(
    Fragment,
    null,
    (value?.content ?? []).map((node, i) => renderRichTextNode(node, i, components)),
  );
}
