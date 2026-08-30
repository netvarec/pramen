// @pramen/cms-editor — the mount prefix (`window.PRAMEN_CMS_EDITOR.basePath`).
//
// The SPA's routes are authored from "/", so a host that serves it under a prefix (an Astro
// site putting the editor at /admin, so site and CMS share one origin) needs the router to
// prepend that. These pin the normalization rules — above all that configuring nothing
// behaves exactly as it did before the seam existed, and that a junk value degrades to the
// root rather than routing every link through a stray prefix.

import { describe, expect, test } from "bun:test";
import { BASE_PATH, readBasePath, resolveBasePath } from "../packages/cms-editor/src/base-path";

describe("cms-editor basePath", () => {
  test("unconfigured mounts at the root, as before the option existed", () => {
    expect(resolveBasePath()).toBe("");
    expect(resolveBasePath(undefined)).toBe("");
    expect(readBasePath()).toBe("");
    expect(readBasePath({})).toBe("");
    expect(readBasePath({ PRAMEN_CMS_EDITOR: {} })).toBe("");
  });

  test("a prefix is normalized to buzola's shape: leading slash, no trailing one", () => {
    expect(resolveBasePath("/admin")).toBe("/admin");
    expect(resolveBasePath("admin")).toBe("/admin");
    expect(resolveBasePath("/admin/")).toBe("/admin");
    expect(resolveBasePath("admin/")).toBe("/admin");
    expect(resolveBasePath("  /admin/  ")).toBe("/admin");
    expect(resolveBasePath("/admin///")).toBe("/admin");
  });

  test("a nested prefix keeps its inner slashes", () => {
    expect(resolveBasePath("/cms/admin/")).toBe("/cms/admin");
  });

  // "/" is the root spelled out, not a prefix — treating it as one would prepend a slash to
  // every already-absolute route.
  test("meaningless values degrade to the root rather than a stray prefix", () => {
    expect(resolveBasePath("/")).toBe("");
    expect(resolveBasePath("")).toBe("");
    expect(resolveBasePath("   ")).toBe("");
  });

  test("it reads through the host object the same way the global is read", () => {
    expect(readBasePath({ PRAMEN_CMS_EDITOR: { basePath: "admin/" } })).toBe("/admin");
  });

  // Resolved at module load, and the test environment has no such global.
  test("BASE_PATH resolves with no host config present", () => {
    expect(BASE_PATH).toBe("");
  });
});
