// @pramen/cms-editor — `extraNav[].target`.
//
// The links default to a new tab because an UNMOUNTED editor's catch-all route
// (`/:__notFound+`) matches every same-origin path, so a same-tab click would land on the
// in-app 404 instead of the tool. A MOUNTED editor filters navigation through
// `scopeToBasePath`, which forwards only in-prefix paths to the router — so an off-prefix
// path reaches the browser normally and the new tab is just clutter.
//
// These pin the two conditions under which `_self` is honoured, because getting either wrong
// strands the user on a 404 rather than merely opening an extra tab.

import { describe, expect, test } from "bun:test";
import { isWithinBasePath, resolveBasePath } from "../packages/cms-editor/src/mount";

/** Mirrors `opensInSameTab` in routes/_layout.tsx. */
const opensInSameTab = (href: string, target: string | undefined, basePath: string): boolean => {
  if (target !== "_self" || !basePath) return false;
  try {
    return !isWithinBasePath(new URL(href, "https://site.example").pathname, basePath);
  } catch {
    return false;
  }
};

const MOUNT = resolveBasePath("/_pramen/admin");

describe("cms-editor extraNav target", () => {
  test("the default is unchanged — no target means a new tab", () => {
    expect(opensInSameTab("/admin/venues", undefined, MOUNT)).toBe(false);
    expect(opensInSameTab("/admin/venues", "_blank", MOUNT)).toBe(false);
  });

  test("`_self` is honoured for an off-prefix path on a mounted editor", () => {
    expect(opensInSameTab("/admin/venues", "_self", MOUNT)).toBe(true);
    expect(opensInSameTab("https://site.example/admin/venues", "_self", MOUNT)).toBe(true);
  });

  // Unmounted, scopeToBasePath is a pass-through and the catch-all claims every same-origin
  // path — the 404 case the default exists to avoid.
  test("`_self` is ignored when the editor is not mounted", () => {
    expect(opensInSameTab("/admin/venues", "_self", "")).toBe(false);
  });

  // An in-prefix path IS the router's, so it must never be released to the browser.
  test("`_self` is ignored for a path inside the mount", () => {
    expect(opensInSameTab("/_pramen/admin/media", "_self", MOUNT)).toBe(false);
    expect(opensInSameTab("/_pramen/admin", "_self", MOUNT)).toBe(false);
  });

  // Containment is anchored at a segment boundary, so a sibling that merely shares the
  // prefix string is off-prefix and may open in the same tab.
  test("a sibling path sharing the prefix string is not inside the mount", () => {
    expect(opensInSameTab("/_pramen/adminate", "_self", MOUNT)).toBe(true);
  });

  test("a malformed href degrades to the safe default", () => {
    expect(opensInSameTab("http://[", "_self", MOUNT)).toBe(false);
  });
});
