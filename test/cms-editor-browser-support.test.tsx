// @pramen/cms-editor: a browser without the Navigation API gets a notice, not a blank page.
//
// buzola's browser adapter throws where the API is missing (Safari before 26.2), and the
// editor builds its own router, so buzola's `BuzolaProvider` notice never fires for it. These
// pin the editor's own guard: that it uses buzola's detection (including the Chromium releases
// a bare `"navigation" in window` check would let through), and that the notice speaks the
// deployment's language with advice a reader can act on, iPhone and iPad included.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RequireNavigationApi } from "../packages/cms-editor/src/browser-support";
import { configureI18n } from "../packages/cms-editor/src/i18n";

const host = globalThis as { window?: unknown; NavigateEvent?: unknown };

// Saved and put back, not deleted: a DOM preload added later must find its globals intact.
const saved = (["window", "NavigateEvent"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);

beforeEach(() => {
  host.window = {};
  delete host.NavigateEvent;
});

afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete host[name];
  }
  configureI18n({});
});

const render = () =>
  renderToStaticMarkup(
    <RequireNavigationApi>
      <div id="editor">editor</div>
    </RequireNavigationApi>,
  );

describe("RequireNavigationApi", () => {
  test("renders the notice instead of the editor where there is no Navigation API", () => {
    const html = render();
    expect(html).not.toContain('id="editor"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("update Safari to version 26.2");
    expect(html).toContain("Chrome, Edge or Firefox");
    expect(html).toContain("update iOS or iPadOS to version 26.2");
  });

  test("renders the editor where the Navigation API is present", () => {
    host.window = { navigation: {} };
    expect(render()).toContain('<div id="editor">editor</div>');
  });

  test("treats a Navigation API without NavigateEvent.intercept as unsupported", () => {
    // Chromium 102–104 shipped `transitionWhile()` where the router calls `intercept()`. Kept
    // although it is buzola's rule: it is what proves the guard delegates rather than checks
    // for `window.navigation` itself, which would let those browsers through to the throw.
    host.window = { navigation: {} };
    host.NavigateEvent = class {};
    expect(render()).toContain('role="alert"');
  });

  test("speaks Czech when the deployment is configured for it", () => {
    configureI18n({ locale: "cs" });
    const html = render();
    expect(html).toContain("aktualizujte Safari na verzi 26.2");
    expect(html).toContain("Chrome, Edge či Firefox");
    expect(html).toContain("iOS nebo iPadOS");
  });
});
