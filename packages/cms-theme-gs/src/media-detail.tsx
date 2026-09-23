// `slots.mediaDetail`: one file's detail as GS's asset preview modal.
//
// GS `AssetPreviewModal`: a large modal (90% of the viewport, up to 75rem) with the title and
// the close control in a header row, the file on a muted stage on the left, and a 300px column
// of facts and actions on the right. On a phone the two stack and the whole body scrolls.
//
// The editor owns everything IN it (the preview element, the alt-text form, the facts, the
// tags, every action and its handler); this module only arranges the three named parts. That
// is the point of the slot: the previous version of this split the dialog's children by
// POSITION, and worked until the first child was not the preview.

import { Button, Heading, ModalDialog, ModalOverlay, ModalSurface } from "@podoba/react";
import type { MediaDetailFrameProps } from "@pramen/cms-editor/slots";
import { copy } from "./copy";

export function MediaDetailFrame({ title, preview, details, actions, onClose, closeLabel }: MediaDetailFrameProps) {
  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalSurface className="flex h-[90vh] max-h-[90vh] w-[min(90vw,75rem)] max-w-[min(90vw,75rem)] flex-col overflow-hidden p-0">
        <ModalDialog className="relative flex min-h-0 flex-1 flex-col outline-none">
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border p-6">
            <Heading slot="title" className="min-w-0 break-all text-heading3 font-medium">{title}</Heading>
            <Button variant="ghost" aria-label={closeLabel} onPress={onClose} className="h-8 w-8 shrink-0 p-0">
              <span aria-hidden="true">×</span>
            </Button>
          </header>
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[1fr_300px] md:overflow-hidden">
            <section aria-label={copy.t("media.previewLabel")} className="flex min-h-64 items-center justify-center overflow-hidden bg-surface-muted p-6 [&_img]:m-0 [&_img]:max-h-full [&_img]:object-contain">
              {preview}
            </section>
            <aside aria-label={copy.t("media.detailsLabel")} className="flex flex-col gap-4 p-6 md:overflow-y-auto">
              {details}
              {/* The editor lays its actions out as one row, sized for a full-width dialog;
                  in a 300px column they wrap instead of running out of it. */}
              <div className="[&>div]:flex-wrap">{actions}</div>
            </aside>
          </div>
        </ModalDialog>
      </ModalSurface>
    </ModalOverlay>
  );
}
