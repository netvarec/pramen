// `slots.detailHeader`: one record's header as the Graphic Standard draws it.
//
// GS's "title to go back": `BrandPageHeader` with the parent list as a soft grey line ABOVE the
// title ("Types / Article"), so the way back reads as part of the heading rather than as a
// button beside it. A real `<a>` with the editor's `href`, so middle-click and "open in new tab"
// work; a plain click calls `onBack` instead, which the editor has already wrapped in the
// screen's unsaved-changes guard (the page editor's "leave without saving?").
//
// The facts the editor passes as `children` (a slug, the "defined in code" badge) go in the
// header's right column and are NOT docked to the bottom of a phone's screen the way a hero CTA
// is: they are labels, not an action.

import { BrandPageHeader } from "@podoba/react";
import type { DetailHeaderProps } from "@pramen/cms-editor/slots";
import type { MouseEvent } from "react";

/** A click the browser should handle itself: another button, or a modifier asking for a new tab
 * or window. */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function DetailHeader({ title, parent, href, onBack, children }: DetailHeaderProps) {
  return (
    <BrandPageHeader
      className="gs-detail-header"
      greeting={title}
      parentLinkTone="soft"
      parentLink={
        <a
          href={href}
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            onBack();
          }}
        >
          {parent}
        </a>
      }
      mobileCtaDocked={false}
      cta={children ? <div className="flex h-full flex-wrap items-start justify-end gap-2 text-small">{children}</div> : undefined}
    />
  );
}
