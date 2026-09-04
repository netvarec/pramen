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

// --- the app bar, and what has to clear it -----------------------------------------------
//
// Two classes for ONE number. The app bar (the rail toggle + the account menu) is sticky at
// the top of the content column, and the screen header is sticky BELOW it — so the header's
// offset has to be the bar's height, exactly. They live here, together, because the two are
// rendered by different modules (`routes/_layout.tsx` and `page-header.tsx`) and a magic `44`
// written out in each is a one-pixel gap or overlap waiting for the next edit. Tailwind needs
// literal class names, so this is a pair of strings rather than a length.

/** The app bar's height. */
export const APP_BAR_H = "h-11";

/** …and the sticky offset anything pinned beneath it must use. Same 44px. */
export const BELOW_APP_BAR = "top-11";
