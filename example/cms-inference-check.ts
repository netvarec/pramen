// Compile-time proof that @pramen/cms block-field inference works. Type-checked by
// `bun run typecheck`; every @ts-expect-error must trigger a real error, and the positive
// cases must compile. Not imported at runtime.

import { defineBlockType } from "@pramen/cms";
import type { BlockFieldsOf, ResolvedMedia } from "@pramen/cms";

const hero = defineBlockType(
  "hero",
  [
    { name: "heading", type: "text", required: true },
    { name: "subtitle", type: "text" },
    { name: "image", type: "media" },
    { name: "count", type: "number", required: true },
    { name: "featured", type: "boolean" },
    { name: "items", type: "repeater", fields: [{ name: "label", type: "text", required: true }] },
    { name: "cta", type: "group", fields: [{ name: "url", type: "url", required: true }] },
  ] as const,
);

type HeroFields = BlockFieldsOf<typeof hero>;

function positive(f: HeroFields): void {
  const heading: string = f.heading; // required text → string
  const count: number = f.count; // required number → number
  const image: ResolvedMedia | null | undefined = f.image; // media → ResolvedMedia | null (+ optional)
  const items = f.items; // repeater → array of nested
  const firstLabel: string | undefined = items?.[0]?.label;
  const ctaUrl: string | undefined = f.cta?.url; // group → nested object
  const featured: boolean | undefined = f.featured;
  void heading;
  void count;
  void image;
  void firstLabel;
  void ctaUrl;
  void featured;
}

function negative(f: HeroFields): void {
  // @ts-expect-error heading is a string, not a number
  const bad1: number = f.heading;
  // @ts-expect-error count is a required number, not a string
  const bad2: string = f.count;
  // @ts-expect-error a repeater item's label is a string, not a number
  const bad3: number = f.items?.[0]?.label ?? 0;
  void bad1;
  void bad2;
  void bad3;
}

void positive;
void negative;
