// @pramen/cms-editor — `target` on a host-configured extraNav link.
//
// The default is a new tab because `_404.tsx`'s catch-all makes the router match every
// same-origin path, so a same-tab click would land on the in-app 404 instead of the tool.
// `_self` asks for the co-hosted case and is honoured only where that cannot happen.
//
// These import the REAL predicate. The first version of this file re-implemented it under a
// `Mirrors opensInSameTab in routes/_layout.tsx` comment, and the copy reproduced the
// resolution bug it was supposed to catch — six green tests that said nothing about the code
// that runs. That is why `opensInSameTab` lives in mount.ts and takes the document URL as a
// parameter: so the thing under test is the thing that ships.

import { describe, expect, test } from "bun:test";
import { opensInSameTab, resolveBasePath } from "../packages/cms-editor/src/mount";

const MOUNT = resolveBasePath("/__admin");
/** Where the editor happens to be when the link is clicked — several segments deep, which
 * is exactly where resolving against the origin instead of the document goes wrong. */
const DOC = `https://site.example${MOUNT}/pages/abc`;
const ROOT_DOC = "https://site.example/";

const sameTab = (href: string, target?: string, basePath = MOUNT, doc = DOC) => opensInSameTab(href, target, basePath, doc);

describe("extraNav target", () => {
  test("the default is a new tab, and only `_self` asks for anything else", () => {
    expect(sameTab("/curate")).toBe(false);
    expect(sameTab("/curate", undefined)).toBe(false);
    expect(sameTab("/curate", "_blank")).toBe(false);
    expect(sameTab("/curate", "_parent")).toBe(false);
  });

  test("a same-origin path outside the mount is left to the browser, so `_self` holds", () => {
    expect(sameTab("/curate", "_self")).toBe(true);
    expect(sameTab("https://site.example/curate", "_self")).toBe(true);
  });

  test("a url inside the mount is refused — the router would claim it", () => {
    expect(sameTab(`${MOUNT}/media`, "_self")).toBe(false);
    expect(sameTab(MOUNT, "_self")).toBe(false);
    expect(sameTab(`https://site.example${MOUNT}/pages/x`, "_self")).toBe(false);
  });

  test("containment is anchored, so a path merely sharing the prefix is outside", () => {
    expect(sameTab("/__adminate", "_self")).toBe(true);
  });

  // The bug the hand-copied predicate shared: `<a href>` is resolved by the browser against
  // the DOCUMENT, so judging it against the origin decides on a different url than the one
  // the click navigates to — off-prefix by the check, in-prefix in fact, straight to the 404.
  test("a relative href is judged against the document, as the browser will resolve it", () => {
    // Against the origin these read as /curate, /, / — all "outside the mount" and all wrong.
    expect(sameTab("curate", "_self")).toBe(false);
    expect(sameTab("../curate", "_self")).toBe(false);
    expect(sameTab("?tab=x", "_self")).toBe(false);
    expect(sameTab("#top", "_self")).toBe(false);
    // And one that genuinely does escape the mount when resolved relatively.
    expect(sameTab("../../../curate", "_self")).toBe(true);
  });

  // Cross-origin is the one case the catch-all cannot reach, so it is safe mounted OR not —
  // the opposite of what a bare "are we mounted?" check concludes.
  test("cross-origin is honoured even at the origin root", () => {
    expect(sameTab("https://tools.acme.com/curate", "_self", "", ROOT_DOC)).toBe(true);
    expect(sameTab("https://tools.acme.com/curate", "_self")).toBe(true);
  });

  test("at the origin root every same-origin url belongs to the router", () => {
    expect(sameTab("/curate", "_self", "", ROOT_DOC)).toBe(false);
    expect(sameTab("https://site.example/curate", "_self", "", ROOT_DOC)).toBe(false);
  });

  // `new URL` parses these happily and their `pathname` is an opaque string that fails any
  // containment test, so without an explicit scheme check they would take the same-tab
  // branch and shed the `rel` that used to confine them.
  test("a non-http scheme is never same-tab", () => {
    expect(sameTab("javascript:alert(1)", "_self")).toBe(false);
    expect(sameTab("data:text/html,<h1>x", "_self")).toBe(false);
    expect(sameTab("blob:https://site.example/abc", "_self")).toBe(false);
    expect(sameTab("mailto:a@b.c", "_self")).toBe(false);
  });

  // Protocol-relative resolves to another origin, which IS the cross-origin case — safe in
  // the same tab, and the `rel="noreferrer"` the layout keeps on both branches is what stops
  // it learning the admin url.
  test("protocol-relative is treated as the cross-origin url it is", () => {
    expect(sameTab("//evil.example/x", "_self")).toBe(true);
    expect(sameTab("//site.example/curate", "_self")).toBe(true);
    expect(sameTab(`//site.example${MOUNT}/media`, "_self")).toBe(false);
  });

  test("an unparseable href degrades to the safe default", () => {
    expect(sameTab("http://[", "_self")).toBe(false);
    // No document URL at all (no `window`) makes every href unparseable — the layout relies
    // on this rather than reading `window.location` unguarded during render.
    expect(sameTab("/curate", "_self", MOUNT, "")).toBe(false);
  });
});
