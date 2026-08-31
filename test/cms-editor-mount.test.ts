// @pramen/cms-editor — the mount seam (`src/mount.ts`).
//
// The editor is served by a shell that stamps the mount prefix onto the mount node, so
// these cover both halves: the normalization rules, and — with a REAL Router over buzola's
// memory adapter — that a prefixed mount actually routes, and that it does not swallow the
// host site it is co-hosted with. The second half is the point: the prefix is a one-line
// wiring change whose failure modes all live in the router, where a string test cannot see
// them.

import { Router, buildRouteTree, createMemoryNavigationAdapter, type RouteConfig } from "@buzola/router";
import { describe, expect, test } from "bun:test";
import { isWithinBasePath, readBackend, readBasePath, resolveBasePath, scopeToBasePath } from "../packages/cms-editor/src/mount";

const BASE = "/_pramen/admin";

/** The shape that matters from `buzola.gen.ts`: a layout, a couple of pages, and the
 * catch-all `_404.tsx` registers — which is what makes EVERY same-origin path match. */
const noop = () => null;
const routes = buildRouteTree([
  {
    path: "/",
    component: noop,
    isLayout: true,
    children: [
      { path: "/home", matchPath: "/", component: noop },
      { path: "/media", component: noop },
      { path: "/:__notFound+", component: noop },
    ],
  },
] satisfies RouteConfig[]);
const pageRegistry = { home: "/", media: "/media" };

/** A router mounted under `BASE`, wired exactly as `main.tsx` wires it. */
function mount(initialURL: string) {
  const inner = createMemoryNavigationAdapter({ initialURL });
  const router = new Router({ routes, adapter: scopeToBasePath(inner, BASE), pageRegistry, basePath: BASE });
  return { inner, router, stop: router.start() };
}

/** The memory adapter runs an intercept handler asynchronously, like the real one. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("cms-editor mount path", () => {
  test("nothing declared means the origin root, as the editor has always been served", () => {
    expect(resolveBasePath()).toBe("");
    expect(resolveBasePath(undefined)).toBe("");
    expect(resolveBasePath(null)).toBe("");
    expect(resolveBasePath("")).toBe("");
    expect(resolveBasePath("   ")).toBe("");
    // "/" is the root spelled out, not a prefix — treating it as one would prepend a slash
    // to every already-absolute route.
    expect(resolveBasePath("/")).toBe("");
  });

  test("a prefix is normalized to buzola's shape: leading slash, no trailing one", () => {
    expect(resolveBasePath(BASE)).toBe(BASE);
    expect(resolveBasePath(`${BASE}/`)).toBe(BASE);
    expect(resolveBasePath(`${BASE}///`)).toBe(BASE);
    expect(resolveBasePath(`  ${BASE}/  `)).toBe(BASE);
  });

  // Each of these routes every link in the app somewhere unintended, and buzola would take
  // them verbatim: `//host` prepends an origin, a query swallows the rest of every href,
  // and a backslash resolves off-site while looking local.
  test("a value that is not a rooted path is refused, not mounted", () => {
    for (const bad of ["//cdn.example.com", "//admin", "/admin?x=1", "/admin#x", "/admin\\evil", "https://host/admin", "admin", "_pramen/admin"]) {
      expect(resolveBasePath(bad)).toBe("");
    }
  });

  // Every comparison against a mount path — here and in buzola's own `stripBasePath` — is a
  // raw `startsWith` against a percent-ENCODED `URL.pathname`. A mount written in characters
  // the parser encodes can therefore never match: `/správa` vs `/spr%C3%A1va/media`, and
  // every in-prefix url reads as off-prefix.
  test("a mount path that would not survive URL parsing is refused", () => {
    for (const bad of ["/správa", "/admin panel", "/café", "/a^b", "/a{b}", "/a`b", '/a"b', "/a<b"]) {
      expect(resolveBasePath(bad)).toBe("");
    }
    // The encoded form of the same mount is fine — it is what the pathname will look like.
    expect(resolveBasePath("/spr%C3%A1va")).toBe("/spr%C3%A1va");
  });

  test("a value that is only slashes is the root, not a malformed path", () => {
    expect(resolveBasePath("//")).toBe("");
    expect(resolveBasePath("///")).toBe("");
  });

  test("it reads the prefix off the mount node the shell rendered", () => {
    expect(readBasePath({ dataset: { basePath: `${BASE}/` } as DOMStringMap })).toBe(BASE);
    expect(readBasePath({ dataset: {} as DOMStringMap })).toBe("");
    expect(readBasePath(null)).toBe("");
  });

  // buzola's own `stripBasePath` is a bare `startsWith`, so without a boundary check a
  // prefix of "/cms" claims the host's "/cmsmedia" and renders the Media library there.
  test("containment is anchored at a segment boundary", () => {
    expect(isWithinBasePath("/cms", "/cms")).toBe(true);
    expect(isWithinBasePath("/cms/media", "/cms")).toBe(true);
    expect(isWithinBasePath("/cmsmedia", "/cms")).toBe(false);
    expect(isWithinBasePath("/cms-guide", "/cms")).toBe(false);
    expect(isWithinBasePath("/blog", "/cms")).toBe(false);
    // No prefix: the editor IS the origin, and everything is in scope.
    expect(isWithinBasePath("/anything", "")).toBe(true);
  });
});

describe("cms-editor mounted under a prefix", () => {
  test("in-app links resolve under the prefix", () => {
    const { router, stop } = mount(`http://host${BASE}/`);
    expect(router.buildPagePath("media")).toBe(`${BASE}/media`);
    expect(router.buildPagePath("home")).toBe(`${BASE}/`);
    stop();
  });

  test("a deep link inside the prefix matches the route it names", () => {
    const { router, stop } = mount(`http://host${BASE}/media`);
    expect(router.getState().matches.at(-1)?.node.path).toBe("/media");
    stop();
  });

  test("navigating within the prefix is handled by the editor", async () => {
    const { inner, router, stop } = mount(`http://host${BASE}/`);
    inner.navigate(`${BASE}/media`);
    await settle();
    expect(router.getState().location.pathname).toBe(`${BASE}/media`);
    stop();
  });

  // The bug this seam exists to prevent. `_404.tsx` registers `/:__notFound+`, so every
  // same-origin path matches — un-scoped, a click on the co-hosted site's own /blog is
  // cancelled by `event.intercept` and renders the editor's "Nothing lives here" while the
  // address bar still reads /blog.
  test("navigating OUTSIDE the prefix is left to the browser", async () => {
    const { inner, router, stop } = mount(`http://host${BASE}/`);
    for (const outside of ["/blog", "/media", "/_pramen/adminmedia", "/"]) {
      inner.navigate(outside);
      await settle();
      expect(router.getState().location.pathname).toBe(`${BASE}/`);
    }
    stop();
  });

  test("the scoped adapter removes the listener it added", () => {
    const inner = createMemoryNavigationAdapter({ initialURL: `http://host${BASE}/` });
    const seen: string[] = [];
    const handler = (e: { destination: { url: string } }) => seen.push(e.destination.url);
    const scoped = scopeToBasePath(inner, BASE);
    scoped.addEventListener("navigate", handler);
    inner.navigate(`${BASE}/media`);
    expect(seen).toHaveLength(1);
    // Without wrapper bookkeeping this would be a no-op and the listener would leak past
    // `Router.start()`'s teardown.
    scoped.removeEventListener("navigate", handler);
    inner.navigate(`${BASE}/users`);
    expect(seen).toHaveLength(1);
  });

  test("an unprefixed mount is passed through untouched", () => {
    const inner = createMemoryNavigationAdapter({ initialURL: "http://host/" });
    expect(scopeToBasePath(inner, "")).toBe(inner);
  });
});

describe("cms-editor declared backend", () => {
  test("absent when the shell declares none — the Setup screen asks for it", () => {
    expect(readBackend(undefined)).toBeUndefined();
    expect(readBackend({})).toBeUndefined();
    expect(readBackend({ PRAMEN_CMS_EDITOR: {} })).toBeUndefined();
    expect(readBackend({ PRAMEN_CMS_EDITOR: { backend: {} } })).toBeUndefined();
    expect(readBackend({ PRAMEN_CMS_EDITOR: { backend: { url: 123 } } })).toBeUndefined();
  });

  test("a declared url is normalized, and the tenant defaults to main", () => {
    expect(readBackend({ PRAMEN_CMS_EDITOR: { backend: { url: "https://cms.example.dev/" } } })).toEqual({ url: "https://cms.example.dev", tenant: "main" });
    expect(readBackend({ PRAMEN_CMS_EDITOR: { backend: { url: "https://cms.example.dev", tenant: " acme " } } })).toEqual({ url: "https://cms.example.dev", tenant: "acme" });
    expect(readBackend({ PRAMEN_CMS_EDITOR: { backend: { url: "https://x.dev", tenant: 7 } } })).toEqual({ url: "https://x.dev", tenant: "main" });
  });

  // The same-origin case, and the reason this tests for the STRING rather than truthiness:
  // "" is a real declaration ("the CMS is right here"), not a missing one.
  test('an empty url is a declaration, not an absence', () => {
    expect(readBackend({ PRAMEN_CMS_EDITOR: { backend: { url: "" } } })).toEqual({ url: "", tenant: "main" });
  });
});
