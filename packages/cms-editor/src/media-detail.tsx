// The dialog frame around one media file's detail.
//
// A SLOT (`slots.mediaDetail`, contract `MediaDetailFrameProps` in `slots.ts`). The split is
// between what the file detail IS and where it goes: the editor keeps the preview element, the
// alt-text form, the facts, the tags and every action with its handler (`MediaDetail` in
// `components.tsx`), and this module only arranges them inside a dialog. So a theme that wants
// the preview beside the details rather than above them (a design system's asset viewer) writes
// a layout, not a copy of the upload, save, download and delete logic.
//
// It exists because the alternative was worse in a specific way. A deployment reached that
// layout by renaming `<Modal>` to its own component in our source and splitting the children it
// received by POSITION (`const [preview, ...details] = Children.toArray(children)`), which
// worked until the day the first child was not the preview. Named parts make the arrangement a
// contract instead of an accident of child order.
//
// The default is the dialog every other form in the editor opens in, with the three parts
// stacked in the order they always were.

import { Dialog } from "@podoba/react";
import type { MediaDetailFrameProps } from "./slots";

export function MediaDetailFrame({ title, preview, details, actions, onClose, closeLabel }: MediaDetailFrameProps) {
  return (
    <Dialog isOpen isDismissable size="lg" title={title} closeLabel={closeLabel} onOpenChange={(open) => !open && onClose()}>
      {preview}
      {details}
      {actions}
    </Dialog>
  );
}
