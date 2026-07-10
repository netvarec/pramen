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
import type { ComponentType, ReactElement } from "react";
import type { RenderedBlock, BlockTypeDef, BlockFieldsOf } from "./index";

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
