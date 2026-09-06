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
  contractRefusal,
  getPanel,
  loadPanelBundles,
  PANEL_RUNTIME_CONTRACT,
  PANEL_RUNTIME_REACT_MAJOR,
  panelBundleUrl,
  panelRefusal,
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
    registerPanel({ slug: "curation", contract: PANEL_RUNTIME_CONTRACT, render: Screen });
    expect(getPanel("curation")?.render).toBe(Screen);
    expect(getPanel("nope")).toBeUndefined();
  });

  test("a registration bumps the version the route subscribes to", () => {
    const before = panelsVersion();
    let woken = 0;
    const stop = subscribePanels(() => void (woken += 1));
    registerPanel({ slug: "curation", contract: PANEL_RUNTIME_CONTRACT, render: Screen });
    expect(woken).toBe(1);
    expect(panelsVersion()).toBeGreaterThan(before);
    stop();
    registerPanel({ slug: "rota", contract: PANEL_RUNTIME_CONTRACT, render: Screen });
    // Unsubscribed means unsubscribed: a torn-down route must not be woken.
    expect(woken).toBe(1);
  });

  test("a slug is trimmed, so a stray space in app.ts does not orphan the component", () => {
    registerPanel({ slug: "  curation  ", contract: PANEL_RUNTIME_CONTRACT, render: Screen });
    expect(getPanel("curation")?.slug).toBe("curation");
  });

  test("only the slug and the component are kept", () => {
    // A bundle that declares a label or a position is asserting placement with nothing to
    // check it against — those are the server's, and they stay the server's.
    registerPanel({ slug: "curation", contract: PANEL_RUNTIME_CONTRACT, render: Screen, label: "Mine", navOrder: 1 } as never);
    expect(Object.keys(getPanel("curation")!).sort()).toEqual(["render", "slug"]);
  });

  test("a registration with no slug is refused, loudly", () => {
    const { warn, seen } = sink();
    registerPanel({ slug: "   ", contract: PANEL_RUNTIME_CONTRACT, render: Screen }, warn);
    registerPanel({ render: Screen, contract: PANEL_RUNTIME_CONTRACT } as never, warn);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/no slug/);
  });

  test("a registration whose render is not a function is refused", () => {
    const { warn, seen } = sink();
    registerPanel({ slug: "curation", contract: PANEL_RUNTIME_CONTRACT, render: "<div/>" } as never, warn);
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
    registerPanel({ slug: "curation", contract: PANEL_RUNTIME_CONTRACT, render: Screen }, warn);
    registerPanel({ slug: "curation", contract: PANEL_RUNTIME_CONTRACT, render: Other }, warn);
    expect(getPanel("curation")?.render).toBe(Other);
    expect(seen[0]).toMatch(/registered twice/);
  });
});

// --- the runtime contract ----------------------------------------------------------------
//
// A panel bundle is compiled at the consumer's build, against whichever React they had, and
// linked at runtime against the React THIS editor loaded. Nothing in the loading path notices
// a mismatch: the import map resolves, the shims hand over a perfectly good React, and the
// failure arrives as a missing export or a differently-behaving hook inside a stranger's
// minified bundle. The contract number is the only fact about the build that survives into
// the bundle, so it is the only thing there is to check — and the check is worth as much as
// the sentence it produces, which is why the wording is asserted and not just the refusal.

describe("the runtime contract", () => {
  const ahead = PANEL_RUNTIME_CONTRACT + 1;

  test("a bundle built against this editor registers", () => {
    const { warn, seen } = sink();
    registerPanel({ slug: "curation", contract: PANEL_RUNTIME_CONTRACT, render: Screen }, warn);
    expect(getPanel("curation")?.render).toBe(Screen);
    expect(seen).toEqual([]);
    expect(panelRefusal("curation")).toBeUndefined();
  });

  test("a bundle BEHIND this editor is refused, and told to rebuild", () => {
    // Exercised through `contractRefusal` with the implemented number handed in, because at
    // contract 1 there is no legal number below ours — and this is the branch the whole
    // mechanism was built for, so it must not ship with a typecheck as its only evidence.
    const message = contractRefusal("curation", 1, 2);
    // Everything a reader needs to act: which panel, which two numbers, and the two steps —
    // rebuild the bundle, then move the literal. A message missing the second sends someone
    // to edit the number alone, which is the one fix that changes nothing.
    expect(message).toContain("'curation'");
    expect(message).toContain("contract 1");
    expect(message).toContain("implements 2");
    expect(message).toMatch(/Rebuild the bundle/);
    expect(message).toContain("contract: 2");
    // …and the same number is fine against an editor that implements it.
    expect(contractRefusal("curation", 2, 2)).toBeUndefined();
  });

  test("a bundle AHEAD of this editor is refused too, and the fix is the other one", () => {
    // Not a bundle that is wrong — a deployment that is. The panel was built for a newer
    // editor than the shell is serving, and rendering it would link it against a runtime
    // missing whatever the newer contract added. Waving it through because "newer is
    // probably fine" is how a version check becomes decorative.
    const { warn, seen } = sink();
    registerPanel({ slug: "curation", contract: ahead, render: Screen } as never, warn);
    expect(getPanel("curation")).toBeUndefined();
    expect(seen).toHaveLength(1);
    // The console half carries the package prefix; the screen half does not — same sentence,
    // two readers, and the prefix is a log convention rather than something to show a person
    // looking at the admin.
    expect(seen[0]!.startsWith("pramen/cms-editor: The 'curation' panel")).toBe(true);
    expect(seen[0]).toContain(`contract ${ahead}`);
    expect(seen[0]).toMatch(/Upgrade @pramen\/cms-editor/);
    expect(seen[0]).toContain(`implementing contract ${ahead}`);
  });

  test("a bundle that states nothing is refused — the default that would have waved it through", () => {
    // The whole set the check exists for: every bundle built before the field existed says
    // nothing here. Defaulting an absent contract to the current one would admit exactly
    // those, which is to say all of the ones that are actually stale.
    const { warn, seen } = sink();
    registerPanel({ slug: "curation", render: Screen } as never, warn);
    expect(getPanel("curation")).toBeUndefined();
    expect(seen[0]).toMatch(/did not state which panel runtime contract/);
    expect(seen[0]).toContain(`contract: ${PANEL_RUNTIME_CONTRACT}`);
    expect(seen[0]).toContain(`React ${PANEL_RUNTIME_REACT_MAJOR}`);
  });

  test("a contract that is not a whole positive number states nothing either", () => {
    // `"1"` is what a hand-edited config produces, `1.5` and `0` are what a clever
    // interpolation produces, and `NaN` is what `Number(undefined)` produces. None of them is
    // a version, and each would otherwise slip past a bare `<` / `>` comparison: `NaN` fails
    // both, and `"1"` coerces to the right answer for the wrong reason.
    for (const bad of [undefined, null, "1", 1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(contractRefusal("curation", bad)).toMatch(/did not state which panel runtime contract/);
    }
    expect(contractRefusal("curation", PANEL_RUNTIME_CONTRACT)).toBeUndefined();
  });

  test("the refusal is readable where the panel should have been, not only in the console", () => {
    // `/apps/curation` would otherwise say "no panel is registered — check that the bundle is
    // listed and calls registerPanel", every clause of which is false here: it is listed, it
    // loaded, it ran, and it called. The route reads this and shows it instead.
    const { warn } = sink();
    registerPanel({ slug: "curation", contract: ahead, render: Screen } as never, warn);
    expect(panelRefusal("curation")).toContain("'curation'");
    expect(panelRefusal("curation")).not.toContain("pramen/cms-editor:");
    expect(panelRefusal("rota")).toBeUndefined();
  });

  test("a refusal wakes the route, which is otherwise still showing a spinner", () => {
    const { warn } = sink();
    let woken = 0;
    subscribePanels(() => void (woken += 1));
    registerPanel({ slug: "curation", contract: ahead, render: Screen } as never, warn);
    expect(woken).toBe(1);
    expect(panelsVersion()).toBeGreaterThan(0);
  });

  test("a later good registration clears the refusal — a dev loop must not keep the old message", () => {
    const { warn } = sink();
    registerPanel({ slug: "curation", contract: ahead, render: Screen } as never, warn);
    registerPanel({ slug: "curation", contract: PANEL_RUNTIME_CONTRACT, render: Screen }, warn);
    expect(getPanel("curation")?.render).toBe(Screen);
    expect(panelRefusal("curation")).toBeUndefined();
  });

  test("a render that is not a component is recorded the same way", () => {
    // Same class of mistake as a bad contract — the bundle ran and was turned away — so it
    // gets the same treatment, and the route stops claiming nothing registered.
    const { warn } = sink();
    registerPanel({ slug: "curation", contract: PANEL_RUNTIME_CONTRACT, render: "<div/>" } as never, warn);
    expect(panelRefusal("curation")).toMatch(/must be a React component, and this one is of type string/);
  });

  test("resetPanels clears refusals, or one test's bad bundle is every later test's", () => {
    const { warn } = sink();
    registerPanel({ slug: "curation", contract: ahead, render: Screen } as never, warn);
    resetPanels();
    expect(panelRefusal("curation")).toBeUndefined();
  });

  test("the number is pinned, because every deployed bundle has it typed into its source", async () => {
    // The one constant in this package a consumer COPIES rather than imports. Moving it
    // invalidates every panel bundle in the field at once — they are all refused until each
    // is rebuilt — so it must not be possible to move it as a passing edit. And the two
    // places that tell people what to type are checked against it, since a doc that still
    // says `contract: 1` after a bump hands every reader the number that will be refused.
    expect(PANEL_RUNTIME_CONTRACT).toBe(1);
    for (const doc of ["../docs/src/content/docs/cms.md", "../packages/cms-editor/README.md"]) {
      const text = await Bun.file(new URL(doc, import.meta.url)).text();
      expect(text).toContain(`contract: ${PANEL_RUNTIME_CONTRACT},`);
      expect(text).not.toMatch(new RegExp(`contract: (?!${PANEL_RUNTIME_CONTRACT},)\\d`));
    }
  });

  test("the contract records which React major it stands for, and the manifest cannot drift from it", async () => {
    // The rule that gets missed. A React major upgrade is a line in package.json, nowhere
    // near panels.ts, done for reasons that have nothing to do with panels — and it moves
    // every panel bundle ever built onto a React it was not compiled against. So the number
    // the contract stands for is written down and pinned HERE: bump react and this goes red,
    // which is the only place the decision to bump the contract can be forced.
    const manifest = (await import("../packages/cms-editor/package.json")) as { default: { dependencies: Record<string, string> } };
    const range = manifest.default.dependencies.react!;
    const major = Number(/(\d+)/.exec(range)?.[1]);
    expect(major).toBe(PANEL_RUNTIME_REACT_MAJOR);
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
      registerPanel({ slug: "curation", contract: PANEL_RUNTIME_CONTRACT, render: Screen });
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
        registerPanel({ slug: "curation", contract: PANEL_RUNTIME_CONTRACT, render: Screen });
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
      contract: PANEL_RUNTIME_CONTRACT,
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
