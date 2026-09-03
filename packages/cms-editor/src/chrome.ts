// The layout primitives every screen shares.
//
// A LEAF module on purpose. These were copied into four files, and the obvious fix — put
// them in `components.tsx`, which already has them — is not available: `components.tsx`
// imports from `furniture.tsx` (for `flattenTerms`, used by the page editor's Terms panel),
// so `furniture.tsx` importing back would be a cycle. Constants and class strings have no
// dependencies of their own, so they belong below both.
//
// Class strings rather than components, because that is what the call sites want: most
// apply them to an element they are already styling for their own reasons.

/** The page gutter every full-width screen uses. */
export const WRAP = "mx-auto max-w-[1200px] px-7 pb-8 pt-2";

/** One row in a list — a card-surfaced strip with the standard inset. */
export const ROW = "flex items-center gap-3 rounded-[14px] border border-transparent bg-surface-card px-[18px] py-3.5";
