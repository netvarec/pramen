// @pramen/cms-editor: a browser without the Navigation API gets a notice, not a blank page.
//
// buzola's browser adapter throws where the API is missing (Safari before 26.2), and the
// editor builds its own router, so buzola's `BuzolaProvider` notice never fires for it. These
// pin the editor's own guard: that it uses buzola's detection (the bun test runtime has no
// `window`, which is exactly "unsupported" to it), and that the notice speaks the deployment's
// language with advice a reader can act on.

import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RequireNavigationApi } from "../packages/cms-editor/src/browser-support";
import { configureI18n } from "../packages/cms-editor/src/i18n";

const host = globalThis as { window?: unknown; NavigateEvent?: unknown };

afterEach(() => {
  delete host.window;
  delete host.NavigateEvent;
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
    expect(html).not.toContain("editor</div>");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Safari to version 26.2");
    expect(html).toContain("Chrome or Edge");
  });

  test("renders the editor where the Navigation API is present", () => {
    host.window = { navigation: {} };
    expect(render()).toContain('<div id="editor">editor</div>');
  });

  test("treats a Navigation API without NavigateEvent.intercept as unsupported", () => {
    // Chromium 102–104 shipped `transitionWhile()` where the router calls `intercept()`.
    host.window = { navigation: {} };
    host.NavigateEvent = class {};
    expect(render()).toContain('role="alert"');
  });

  test("speaks Czech when the deployment is configured for it", () => {
    configureI18n({ locale: "cs" });
    const html = render();
    expect(html).toContain("Aktualizujte Safari na verzi 26.2");
    expect(html).toContain("Chrome či Edge");
  });
});
