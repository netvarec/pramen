// @pramen/cms-editor — the panel registry: where a deployment's own React screens are
// registered, and how their bundles get loaded.
//
// Tested without a DOM, which is the point of `panels.ts` being free of React at runtime.
// What is being pinned here is not rendering; it is the three rules that decide whether a
// panel can be reached at all:
//
//   - a bundle URL is EXECUTED, so what may be one is a security question, not a tidiness one;
//   - a failing bundle costs its own panel and nothing else;
//   - "still loading" and "loaded, and never registered this slug" are different answers, and
//     the second is a deployment mistake nobody can diagnose from a spinner.

import { afterEach, describe, expect, test } from "bun:test";
import {
  getPanel,
  loadPanelBundles,
  panelBundleUrl,
  panelsSettled,
  panelsVersion,
  readPanelUrls,
  registerPanel,
  resetPanels,
  subscribePanels,
  type PanelApi,
  type PanelHost,
  type PanelProps,
} from "../packages/cms-editor/src/panels";
import { PanelBoundary, panelFailureMessage } from "../packages/cms-editor/src/panel-boundary";
import { adminPageKind } from "../packages/cms-editor/src/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getTheme, initTheme, resetTheme, setTheme, subscribeTheme } from "../packages/cms-editor/src/theme";

const DOC = "https://site.example/__admin/apps/curation";
/** A component, as far as the registry is concerned — it only checks that it is callable. */
const Screen = () => null;
/** Collect warnings instead of printing them. */
const sink = () => {
  const seen: string[] = [];
  return { warn: (m: string) => void seen.push(m), seen };
};

afterEach(() => resetPanels());

describe("registering", () => {
  test("a panel is found by the slug the server listed", () => {
    registerPanel({ slug: "curation", render: Screen });
    expect(getPanel("curation")?.render).toBe(Screen);
    expect(getPanel("nope")).toBeUndefined();
  });

  test("a registration bumps the version the route subscribes to", () => {
    const before = panelsVersion();
    let woken = 0;
    const stop = subscribePanels(() => void (woken += 1));
    registerPanel({ slug: "curation", render: Screen });
    expect(woken).toBe(1);
    expect(panelsVersion()).toBeGreaterThan(before);
    stop();
    registerPanel({ slug: "rota", render: Screen });
    // Unsubscribed means unsubscribed: a torn-down route must not be woken.
    expect(woken).toBe(1);
  });

  test("a slug is trimmed, so a stray space in app.ts does not orphan the component", () => {
    registerPanel({ slug: "  curation  ", render: Screen });
    expect(getPanel("curation")?.slug).toBe("curation");
  });

  test("only the slug and the component are kept", () => {
    // A bundle that declares a label or a position is asserting placement with nothing to
    // check it against — those are the server's, and they stay the server's.
    registerPanel({ slug: "curation", render: Screen, label: "Mine", navOrder: 1 } as never);
    expect(Object.keys(getPanel("curation")!).sort()).toEqual(["render", "slug"]);
  });

  test("a registration with no slug is refused, loudly", () => {
    const { warn, seen } = sink();
    registerPanel({ slug: "   ", render: Screen }, warn);
    registerPanel({ render: Screen } as never, warn);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/no slug/);
  });

  test("a registration whose render is not a function is refused", () => {
    const { warn, seen } = sink();
    registerPanel({ slug: "curation", render: "<div/>" } as never, warn);
    expect(getPanel("curation")).toBeUndefined();
    expect(seen[0]).toMatch(/must be a React component/);
  });

  test("a duplicate slug warns and the LAST wins", () => {
    // Not a throw. Registration runs inside a dynamic import of code this editor does not
    // own, where a throw is swallowed by the loader's per-bundle catch and reappears as "the
    // panel never registered" — the least informative possible report of "you did it twice".
    // Last-wins is also the only rule under which re-evaluating a bundle (a dev reload)
    // behaves.
    const Other = () => null;
    const { warn, seen } = sink();
    registerPanel({ slug: "curation", render: Screen }, warn);
    registerPanel({ slug: "curation", render: Other }, warn);
    expect(getPanel("curation")?.render).toBe(Other);
    expect(seen[0]).toMatch(/registered twice/);
  });
});

describe("what may be a bundle URL", () => {
  test("a path is resolved against the DOCUMENT, not the origin", () => {
    // The same rule `opensInSameTab` keeps: a relative specifier is what the BROWSER would
    // resolve that way, and resolving against `location.origin` instead silently loads a
    // different file.
    expect(panelBundleUrl("/_astro/panel.a1b2.js", DOC)).toBe("https://site.example/_astro/panel.a1b2.js");
    expect(panelBundleUrl("./panel.js", DOC)).toBe("https://site.example/__admin/apps/panel.js");
  });

  test("an absolute http(s) URL is kept — a panel may live on a CDN", () => {
    expect(panelBundleUrl("https://cdn.example/panel.js", DOC)).toBe("https://cdn.example/panel.js");
    expect(panelBundleUrl("http://localhost:5173/panel.js", DOC)).toBe("http://localhost:5173/panel.js");
  });

  test("a non-web scheme is refused — this string is IMPORTED, which is to say executed", () => {
    // `javascript:`, `data:` and `blob:` all parse happily as URLs and all name code with no
    // origin to attribute it to. An http(s) URL is fetched under the page's own CSP and
    // shows up in the network log like every other asset.
    expect(panelBundleUrl("data:text/javascript,globalThis.x=1", DOC)).toBeUndefined();
    expect(panelBundleUrl("javascript:alert(1)", DOC)).toBeUndefined();
    expect(panelBundleUrl("blob:https://site.example/abc", DOC)).toBeUndefined();
  });

  test("nothing, whitespace and non-strings are refused", () => {
    expect(panelBundleUrl("", DOC)).toBeUndefined();
    expect(panelBundleUrl("   ", DOC)).toBeUndefined();
    expect(panelBundleUrl(42, DOC)).toBeUndefined();
    expect(panelBundleUrl(null, DOC)).toBeUndefined();
    // No document to resolve a relative path against is not an answer either.
    expect(panelBundleUrl("./panel.js", "")).toBeUndefined();
  });
});

describe("reading the shell's declaration", () => {
  const host = (panels: unknown): PanelHost => ({ PRAMEN_CMS_EDITOR: { panels } as never });

  test("no declaration is no panels, and says nothing about it", () => {
    const { warn, seen } = sink();
    expect(readPanelUrls(undefined, DOC, warn)).toEqual([]);
    expect(readPanelUrls({}, DOC, warn)).toEqual([]);
    expect(readPanelUrls(host(undefined), DOC, warn)).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("the declared bundles come back resolved, in order", () => {
    expect(readPanelUrls(host(["/a.js", "https://cdn.example/b.js"]), DOC)).toEqual(["https://site.example/a.js", "https://cdn.example/b.js"]);
  });

  test("a bad entry is dropped and warned about — it does not take the admin down", () => {
    // The value is server-generated, so one that fails the check means something upstream is
    // wrong. A green deploy is the worst place to discover that, and a blank admin is the
    // worst way to be told.
    const { warn, seen } = sink();
    expect(readPanelUrls(host(["/good.js", "javascript:alert(1)", 7]), DOC, warn)).toEqual(["https://site.example/good.js"]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/unusable panel bundle URL/);
  });

  test("a declaration that is not an array is refused as a whole", () => {
    const { warn, seen } = sink();
    expect(readPanelUrls(host("/a.js"), DOC, warn)).toEqual([]);
    expect(seen[0]).toMatch(/must be an array/);
  });
});

describe("loading bundles", () => {
  test("nothing declared means nothing in flight, and nothing awaited", async () => {
    await loadPanelBundles([]);
    expect(panelsSettled()).toBe(true);
  });

  test("a bundle registers as it lands, and `settled` only then", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const loading = loadPanelBundles(["/a.js"], async () => {
      await blocked;
      registerPanel({ slug: "curation", render: Screen });
    });
    // While it is in flight the route must say "Loading…", not "no panel is registered" —
    // this is the whole reason the count exists.
    expect(panelsSettled()).toBe(false);
    expect(getPanel("curation")).toBeUndefined();
    release();
    await loading;
    expect(panelsSettled()).toBe(true);
    expect(getPanel("curation")).toBeDefined();
  });

  test("one failing bundle does not take the others' registrations with it", async () => {
    // Per-bundle catch, not one try around the lot: bundles are independent deployments of
    // independent project code.
    const { warn, seen } = sink();
    await loadPanelBundles(
      ["/bad.js", "/good.js"],
      async (url) => {
        if (url === "/bad.js") throw new Error("404");
        registerPanel({ slug: "curation", render: Screen });
      },
      warn,
    );
    expect(getPanel("curation")).toBeDefined();
    expect(panelsSettled()).toBe(true);
    expect(seen[0]).toMatch(/\/bad\.js failed to load — 404/);
  });

  test("a failure still settles, so the route stops claiming to be loading", async () => {
    const { warn } = sink();
    await loadPanelBundles(["/bad.js"], () => Promise.reject(new Error("boom")), warn);
    expect(panelsSettled()).toBe(true);
  });

  test("the loader wakes subscribers on both edges", async () => {
    // A route that mounted before the load started has to hear that one BEGAN, or it renders
    // its "no panel registered" diagnostic against a registry that is about to fill up.
    let woken = 0;
    subscribePanels(() => void (woken += 1));
    await loadPanelBundles(["/a.js"], async () => {});
    expect(woken).toBe(2);
  });
});

// --- which kind a listed screen is ------------------------------------------------------

describe("adminPageKind", () => {
  test("an absent kind is Block Kit — what every entry was before panels existed", () => {
    // And what an older server still sends. Defaulting the other way would route every
    // existing deployment's `adminPage()` at a component nobody registered.
    expect(adminPageKind({ slug: "dispatch", label: "Dispatch" })).toBe("blocks");
  });

  test("the two known kinds come back as themselves", () => {
    expect(adminPageKind({ slug: "d", label: "d", kind: "blocks" })).toBe("blocks");
    expect(adminPageKind({ slug: "c", label: "c", kind: "panel" })).toBe("panel");
  });

  test("an unrecognised kind degrades to Block Kit rather than to a blank screen", () => {
    // From a NEWER server. Block Kit then asks it to render a screen it may have no server
    // render for, and the reader gets an error naming the page — which is a legible failure.
    // Passing the string through instead would fall out of every branch and paint nothing.
    expect(adminPageKind({ slug: "x", label: "x", kind: "hologram" })).toBe("blocks");
    expect(adminPageKind({ slug: "x", label: "x", kind: "" })).toBe("blocks");
  });
});

// --- what a panel is handed -------------------------------------------------------------

describe("PanelProps", () => {
  test("a registered component renders with the four things a panel gets, and no more", () => {
    // The route hands these to `<panel.render />`; this pins the SHAPE, which is the part a
    // consumer writes against. `me` is deliberately absent — a panel that branches on the
    // caller's roles to decide what to show is doing client-side authorization, and the gate
    // that counts is `roles` on `adminPanel()`, enforced before the entry is even listed.
    let handed: PanelProps | undefined;
    const api: PanelApi = { call: async () => null, resolve: (p) => `https://cms.example${p}` };
    registerPanel({
      slug: "curation",
      render: (props) => {
        handed = props;
        return createElement("p", null, `${props.theme} @ ${props.basePath} → ${props.api.resolve("/m/1.jpg")}`);
      },
    });
    const props: PanelProps = { api, basePath: "/__admin", theme: "dark", setError: () => {} };
    const html = renderToStaticMarkup(createElement(getPanel("curation")!.render, props));
    expect(html).toBe("<p>dark @ /__admin → https://cms.example/m/1.jpg</p>");
    expect(Object.keys(handed!).sort()).toEqual(["api", "basePath", "setError", "theme"]);
    // The transport is the NARROW view, not the editor's `Api` class — handing that over
    // would make its ~40 CMS wrappers an API this package has to keep.
    expect(Object.keys(handed!.api).sort()).toEqual(["call", "resolve"]);
  });
});

// --- the theme, as a store --------------------------------------------------------------
//
// It moved out of `_layout.tsx` because a panel is handed it and is rendered by that layout
// through `<Outlet />` — so threading it as a prop would have put a value one route wants on
// every route, and a second `useState` would have been two sources of truth for one document
// attribute. Tested here, beside the thing that made it a store.

describe("the theme store", () => {
  test("survives a runtime with no localStorage and no document", () => {
    // Both are absent under Bun, which is exactly the shape a private window with site data
    // blocked has: the object is there and THROWS on access. One try/catch covers both, and
    // a theme that cannot be remembered must never be a theme that cannot be set.
    resetTheme();
    initTheme();
    expect(getTheme()).toBe("light");
    setTheme("dark");
    expect(getTheme()).toBe("dark");
    resetTheme();
  });

  test("notifies subscribers, and only on a real change", () => {
    resetTheme();
    let woken = 0;
    const stop = subscribeTheme(() => void (woken += 1));
    setTheme("dark");
    setTheme("dark");
    expect(woken).toBe(1);
    setTheme("light");
    expect(woken).toBe(2);
    stop();
    setTheme("dark");
    expect(woken).toBe(2);
    resetTheme();
  });
});

// --- a panel's blast radius --------------------------------------------------------------
//
// A panel is someone else's component in the editor's own React tree, and React's answer to
// an uncaught render error is to unmount the whole root. Without a boundary one bad panel
// does not break a screen, it blanks the admin: no sidebar, no way off the route that is
// failing, and a reload lands straight back on it because the URL is a real route.

describe("PanelBoundary", () => {
  test("a caught error becomes the message the reader is shown", () => {
    expect(PanelBoundary.getDerivedStateFromError(new Error("column 'hidden' does not exist"))).toEqual({
      failure: "column 'hidden' does not exist",
    });
  });

  test("a throw with nothing to say still says something", () => {
    // `throw "nope"` and `throw {}` are both real; `String(err)` of the second is
    // "[object Object]" and of an empty Error is "", which is not a message a reader can act
    // on and not one they should be shown as if it were.
    expect(panelFailureMessage("nope")).toBe("nope");
    expect(panelFailureMessage(new Error(""))).toBe("threw a value with no message");
    expect(panelFailureMessage(new Error("   "))).toBe("threw a value with no message");
  });

  test("a healthy panel is passed straight through", () => {
    const html = renderToStaticMarkup(
      createElement(PanelBoundary, { slug: "curation" }, createElement("p", null, "hello")),
    );
    expect(html).toBe("<p>hello</p>");
  });

  test("the fallback names the panel and the failure, and is announced", () => {
    // `role="alert"`, because the screen the reader asked for is not there and nothing else
    // on the page changed to say so.
    const boundary = new PanelBoundary({ slug: "curation", children: null });
    boundary.state = PanelBoundary.getDerivedStateFromError(new Error("boom"));
    const html = renderToStaticMarkup(boundary.render() as never);
    expect(html).toContain('role="alert"');
    expect(html).toContain("curation");
    expect(html).toContain("boom");
  });
});
