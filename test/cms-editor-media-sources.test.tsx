// @pramen/cms-editor: media sources (`slots.mediaSources`), the frames the editor puts around a
// deployment's browser for an external store.
//
// The source itself is the deployment's (it lists, imports through its own handlers, and
// reports the `cms_media` id it ended up with), so what is ours to promise is the wiring: no
// sources renders the editor as it was, a source is a tab in the field's picker whose result is
// picked like a tile, and on the Media screen it is an action beside Upload whose result
// closes its dialog and reloads the library. Without a DOM: podoba's `Dialog` renders nothing on
// the server, so the picker's CONTENT and the screen's actions are tested where they are
// decided, and the bundle half (a deployment's module replaces ours) is in
// `cms-editor-host-build.test.ts`.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolve } from "node:path";
import { configureI18n } from "../packages/cms-editor/src/i18n";
import {
  editorCall,
  LIBRARY_TAB,
  libraryImported,
  MediaPickerContent,
  mediaSourceActions,
  MediaSourceBrowser,
  sourceTab,
} from "../packages/cms-editor/src/media-source-ui";
import { mediaSources } from "../packages/cms-editor/src/media-sources";
import { PanelBoundary } from "../packages/cms-editor/src/panel-boundary";
import { headerActions } from "../packages/cms-editor/src/page-header";
import type { MediaSource, MediaSourceProps } from "../packages/cms-editor/src/slots";
import type { RpcInput } from "../packages/cms-editor/src/types";

// The editor's podoba, the one `mediaSourceActions` builds with: the repo root has none, and the
// assertion below is about element identity, so it has to be the same `Button`.
const { Button } = (await import(Bun.resolveSync("@podoba/react", resolve(import.meta.dir, "../packages/cms-editor")))) as typeof import("@podoba/react");

let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  error.mockRestore();
  configureI18n({});
});

/** A source whose browser records what it was handed, so a test can act as the source would. */
interface RecordingSource {
  source: MediaSource;
  seen: MediaSourceProps[];
}

function recordingSource(id = "gs", label = "Graphic Standard"): RecordingSource {
  const seen: MediaSourceProps[] = [];
  const Browser = (props: MediaSourceProps) => {
    seen.push(props);
    return <div data-browser={id} data-mode={props.mode}>browser:{id}</div>;
  };
  return { source: { id, label, Browser }, seen };
}

const call = editorCall({ call: async <T,>() => undefined as T });
const LIBRARY = <p data-library="">the library</p>;

describe("no media sources", () => {
  test("the slot's default is empty", () => {
    expect(mediaSources).toEqual([]);
  });

  test("the picker is its library, with no tab strip around it", () => {
    const html = renderToStaticMarkup(<MediaPickerContent sources={[]} library={LIBRARY} call={call} onPick={() => {}} onCancel={() => {}} />);
    expect(html).toBe(renderToStaticMarkup(LIBRARY));
  });

  test("the Media screen gets no actions, and its header renders exactly as before", () => {
    expect(mediaSourceActions([], () => {})).toEqual([]);
    // What the Media screen hands its header: the hidden file input, Upload, and the (empty)
    // list of source actions. One shown action goes in as it is, ungrouped.
    const children = [<input key="i" type="file" hidden />, <Button key="u">+ Upload</Button>, mediaSourceActions([], () => {})];
    expect(renderToStaticMarkup(<>{headerActions(children)}</>)).toBe(renderToStaticMarkup(<>{children}</>));
  });
});

describe("in a media field's picker", () => {
  test("the library is the first tab, selected, and each source is a tab beside it", () => {
    configureI18n({ locale: "cs" });
    const { source } = recordingSource();
    const html = renderToStaticMarkup(<MediaPickerContent sources={[source]} library={LIBRARY} call={call} onPick={() => {}} onCancel={() => {}} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Odkud soubor vzít"');
    const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(tabs).toEqual(["Knihovna", "Graphic Standard"]);
    expect(html).toMatch(/data-key="library"[^>]*aria-selected="true"/);
    expect(html).toContain("the library");
    expect(html).not.toContain("browser:gs");
  });

  test("a source's tab renders its browser in pick mode, and its result is picked like a tile", () => {
    const { source, seen } = recordingSource();
    const picked: string[] = [];
    let cancelled = 0;
    const html = renderToStaticMarkup(
      <MediaPickerContent sources={[source]} library={LIBRARY} call={call} onPick={(id) => picked.push(id)} onCancel={() => { cancelled++; }} defaultSelectedKey={sourceTab(source)} />,
    );
    expect(html).toContain('data-mode="pick"');
    expect(seen.length).toBeGreaterThan(0);
    const props = seen.at(-1)!;
    expect(props.mode).toBe("pick");
    expect(props.call).toBe(call);
    props.onDone("media-1");
    expect(picked).toEqual(["media-1"]);
    props.onCancel();
    expect(cancelled).toBe(1);
  });

  test("a source called `library` does not take the library's tab", () => {
    const { source } = recordingSource("library", "Library elsewhere");
    expect(sourceTab(source)).not.toBe(LIBRARY_TAB);
    const html = renderToStaticMarkup(<MediaPickerContent sources={[source]} library={LIBRARY} call={call} onPick={() => {}} onCancel={() => {}} />);
    expect([...html.matchAll(/role="tab"/g)].length).toBe(2);
  });

  test("a browser renders inside the panels' error boundary, so a throw costs its tab, not the picker", () => {
    // Error boundaries do not run on the server, so this checks the element rather than the
    // rendered failure; the boundary's own behaviour is `cms-editor-panels.test.ts`'s.
    const broken: MediaSource = { id: "dam", label: "DAM", Browser: () => { throw new Error("dam is down"); } };
    const el = MediaSourceBrowser({ source: broken, call, mode: "pick", onDone: () => {}, onCancel: () => {} });
    expect(el.type).toBe(PanelBoundary);
    expect((el.props as { slug: string }).slug).toBe("DAM");
  });
});

describe("on the Media screen", () => {
  test("each source is one of the editor's own Buttons, so a header slot restyles and moves it like Upload", () => {
    const a = recordingSource("gs", "Graphic Standard").source;
    const b = recordingSource("dam", "DAM").source;
    const opened: string[] = [];
    const actions = mediaSourceActions([a, b], (s) => opened.push(s.id));
    expect(actions.map((el) => el.type)).toEqual([Button, Button]);
    expect(renderToStaticMarkup(<>{actions}</>)).toContain("Graphic Standard");
    (actions[1] as ReactElement<{ onPress: () => void }>).props.onPress();
    expect(opened).toEqual(["dam"]);
    // Disabled with Upload while an upload is running.
    expect(mediaSourceActions([a], () => {}, true).every((el) => (el as ReactElement<{ isDisabled?: boolean }>).props.isDisabled)).toBe(true);
  });

  test("the default header groups Upload and the source actions into one cell", () => {
    const children = [<input key="i" type="file" hidden />, <Button key="u">+ Upload</Button>, mediaSourceActions([recordingSource().source], () => {})];
    const grouped = headerActions(children);
    expect(isValidElement(grouped) && grouped.type).toBe("div");
    // Every child is still rendered, the hidden input included: the upload button drives it.
    expect(Children.toArray((grouped as ReactElement<{ children: unknown }>).props.children as never).length).toBe(3);
  });

  test("a source's result closes its dialog and reloads the library", () => {
    const steps: string[] = [];
    const { source, seen } = recordingSource();
    const onDone = libraryImported({ close: () => steps.push("close"), reload: () => steps.push("reload") });
    renderToStaticMarkup(<MediaSourceBrowser source={source} call={call} mode="library" onDone={onDone} onCancel={() => steps.push("cancel")} />);
    const props = seen.at(-1)!;
    expect(props.mode).toBe("library");
    props.onDone("media-2");
    expect(steps).toEqual(["close", "reload"]);
    props.onCancel();
    expect(steps).toEqual(["close", "reload", "cancel"]);
  });
});

describe("the call a source is handed", () => {
  test("is the editor's own, detached from the client so it survives being passed around", async () => {
    const calls: unknown[] = [];
    const client = {
      prefix: "rpc",
      async call<T>(name: string, input?: RpcInput): Promise<T> {
        calls.push([this.prefix, name, input]);
        return "media-3" as T;
      },
    };
    const detached = editorCall(client);
    expect(await detached<string>("importFromGs", { assetId: "a1" })).toBe("media-3");
    expect(calls).toEqual([["rpc", "importFromGs", { assetId: "a1" }]]);
  });
});
