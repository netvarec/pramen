// The header of one record's screen: the way back to its list, and its name.
//
// ONE component for a pattern that was written out seven times. The collection item, the block
// and content type builders, a menu, a vocabulary and a widget area each opened with the same
// three lines (a ghost "← Types" button, a 22px `<h1>`, sometimes a muted slug beside it), and
// the page editor carried the same two facts inside its toolbar. Seven copies meant a
// deployment that wanted its own detail header had seven places to rewrite, and the one that
// did rewrote two of them (by string replacement against our source) and left the other five
// looking like a different product.
//
// A SLOT (`slots.detailHeader`, contract `DetailHeaderProps` in `slots.ts`), and a LEAF:
// `components.tsx`, `schema-builder.tsx` and `furniture.tsx` all render it, and
// `components.tsx` already imports from `furniture.tsx`, so it has to sit below both.
//
// `href` is part of the contract and unused here, on purpose. The default keeps the button it
// replaced, so an unthemed editor looks exactly as it did; a theme that renders the way back as
// a real link (and so gets middle-click and "open in new tab") needs the href, and a caller is
// the only place that can build one, since only it knows which list it came from.

import { Button } from "@podoba/react";
import type { DetailHeaderProps } from "./slots";

export function DetailHeader({ title, parent, onBack, children }: DetailHeaderProps) {
  return (
    <div className="mb-4 mt-2 flex items-center gap-3">
      <Button variant="ghost" size="sm" onPress={onBack}>← {parent}</Button>
      <h1 className="text-[22px] font-normal text-fg">{title}</h1>
      {children}
    </div>
  );
}
