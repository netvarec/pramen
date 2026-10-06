// The frames the editor puts around a deployment's media sources (`slots.mediaSources`).
//
// A source is a deployment's own browser for an external store (a DAM, another product's
// assets): it lists, imports through its own handlers, and reports the `cms_media` id it ended
// up with. What it is NOT given is the editor's furniture, and that is all this module is: the
// tab strip in a media field's picker, the action beside Upload on the Media screen and the
// dialog it opens, and what each does with the id. Kept out of `fields.tsx` and
// `components.tsx` so that wiring is testable without the page editor, and out of
// `media-sources.ts` because that module is the SLOT: a deployment replaces it whole, and
// anything else in it would go with it.
//
// With no sources every function here hands back exactly what it was given (the picker's
// library, no actions), so a deployment that fills nothing renders the editor as it was.

import { Button, Dialog, Tab, TabList, TabPanel, Tabs } from "@podoba/react";
import type { ReactElement, ReactNode } from "react";
import type { Api } from "./api";
import { t, useI18n } from "./i18n";
import { PanelBoundary } from "./panel-boundary";
import type { EditorApi, MediaSource, MediaSourceProps } from "./slots";
import type { RpcInput } from "./types";

/** The picker's own tab, beside one per source. Source tabs are prefixed, so a source whose id
 * happens to be `library` cannot collide with it. */
export const LIBRARY_TAB = "library";

/** A source's tab id in the picker. */
export const sourceTab = (source: MediaSource): string => `source:${source.id}`;

/** The editor's `call`, detached from the client so a source can pass it around. `Api.call` is
 * a method, and handing it over bare would lose its `this` at the first call. */
export function editorCall(api: Pick<Api, "call">): EditorApi["call"] {
  return <T,>(name: string, input?: RpcInput) => api.call<T>(name, input);
}

/** One source's browser, inside the boundary a deployment's component gets everywhere it
 * renders in our tree: a throw costs this tab or dialog, not the editor. */
export function MediaSourceBrowser({ source, ...props }: MediaSourceProps & { source: MediaSource }) {
  const { Browser } = source;
  return (
    <PanelBoundary slug={source.label}>
      <Browser {...props} />
    </PanelBoundary>
  );
}

/**
 * What a media field's picker shows: its library, and a tab per source beside it.
 *
 * No sources, no tabs: `library` comes back as it was handed in, so the picker's markup is the
 * one it always had. With sources, the library is the first tab (selected), and a source's
 * `onDone` is `onPick`, the same thing choosing a tile does.
 */
export function MediaPickerContent({
  sources,
  library,
  call,
  onPick,
  onCancel,
  defaultSelectedKey = LIBRARY_TAB,
}: {
  sources: readonly MediaSource[];
  library: ReactNode;
  call: EditorApi["call"];
  onPick: (mediaId: string) => void;
  onCancel: () => void;
  /** The tab open first. The library, unless a test says otherwise. */
  defaultSelectedKey?: string;
}) {
  const { t } = useI18n();
  if (sources.length === 0) return <>{library}</>;
  return (
    <Tabs defaultSelectedKey={defaultSelectedKey}>
      <TabList aria-label={t("picker.media.sources")}>
        <Tab id={LIBRARY_TAB}>{t("picker.media.library")}</Tab>
        {sources.map((s) => (
          <Tab key={s.id} id={sourceTab(s)}>{s.label}</Tab>
        ))}
      </TabList>
      <TabPanel id={LIBRARY_TAB}>{library}</TabPanel>
      {sources.map((s) => (
        <TabPanel key={s.id} id={sourceTab(s)}>
          <MediaSourceBrowser source={s} call={call} mode="pick" onDone={onPick} onCancel={onCancel} />
        </TabPanel>
      ))}
    </Tabs>
  );
}

/**
 * The Media screen's action per source, to go beside Upload in the page header.
 *
 * An ARRAY of the editor's own `Button`s rather than a component that renders them, because the
 * header is a slot and a theme recognises the editor's actions by element type (the GS header
 * restyles every `Button` child and moves them into its upload hub). Wrapped in a component of
 * ours, they would arrive as one unknown element and lose both.
 */
export function mediaSourceActions(sources: readonly MediaSource[], onOpen: (source: MediaSource) => void, disabled = false): ReactElement[] {
  return sources.map((s) => (
    <Button key={`media-source:${s.id}`} variant="secondary" className="shrink-0" isDisabled={disabled} onPress={() => onOpen(s)}>
      {s.label}
    </Button>
  ));
}

/** What the Media screen does when a source reports an id: close the source's dialog and reload
 * the library from the top, where an import lands (newest first), as an upload does. */
export function libraryImported({ close, reload }: { close: () => void; reload: () => void }): (mediaId: string) => void {
  return () => {
    close();
    reload();
  };
}

/** The dialog a Media-screen action opens, with the source's browser in `"library"` mode. */
export function MediaSourceDialog({ source, call, onClose, onImported }: { source: MediaSource; call: EditorApi["call"]; onClose: () => void; onImported: (mediaId: string) => void }) {
  return (
    <Dialog isOpen isDismissable size="lg" title={source.label} closeLabel={t("common.close")} onOpenChange={(open) => !open && onClose()}>
      <MediaSourceBrowser source={source} call={call} mode="library" onDone={onImported} onCancel={onClose} />
    </Dialog>
  );
}
