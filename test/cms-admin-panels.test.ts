// @pramen/cms — custom admin PANELS: a project's own React screen inside the editor's chrome.
//
// The contract worth holding here is that a panel is a REGISTRY entry first and a bundle
// second. Everything a nav entry is made of — the slug, the label, the icon, the position
// and, above all, who may open it — is a server fact declared with `adminPanel()`, exactly
// as it is for a Block Kit page. The browser bundle supplies the component and nothing else.
//
// That is what makes role filtering mean something. If a panel were registered only in the
// browser, "who may see this screen" would be a decision made by code the caller's own
// browser downloaded — which is not a decision at all. So the tests below are mostly about
// the two kinds being indistinguishable at the gate.

import { describe, expect, test } from "bun:test";
import {
  adminPage,
  adminPanel,
  createAdminPageHandlers,
  isAdminPanel,
  ADMIN_PAGE_KINDS,
  NAV_ORDER,
  validateAdminPages,
  type AdminPageInteraction,
  type AdminPageMeta,
  type AdminPageResponse,
} from "../packages/cms/src/index";
import type { HandlerContext } from "@pramen/server";

/** A caller holding these roles. `identity` is whatever the app's auth put there, so the
 * handlers read it defensively; the tests supply the two shapes they accept. */
const asCaller = (identity: { roles?: string[]; role?: string }): HandlerContext => ({ identity }) as HandlerContext;
const ctxAs = (...roles: string[]) => asCaller({ roles });

const blocks = (slug: string, roles?: string[]) => adminPage(slug, { label: slug, roles, render: () => ({ blocks: [] }) });

interface Handlers {
  listAdminPages: { run: (c: HandlerContext) => AdminPageMeta[] };
  adminPageInteract: { run: (c: HandlerContext, i: AdminPageInteraction) => Promise<AdminPageResponse> };
}
type Screen = Parameters<typeof createAdminPageHandlers>[0][number];
const H = (...screens: Screen[]) => createAdminPageHandlers(screens) as Handlers;

describe("declaring a panel", () => {
  test("`adminPanel` stamps the discriminant, so a half-declared object is a type error", () => {
    const p = adminPanel("curation", { label: "Curation" });
    expect(p).toEqual({ kind: "panel", slug: "curation", label: "Curation" });
    expect(isAdminPanel(p)).toBe(true);
    expect(isAdminPanel(blocks("dispatch"))).toBe(false);
  });

  test("a panel carries no render — and is not mistaken for a page that forgot one", () => {
    // The check `validateAdminPages` makes for a Block Kit page is exactly "no render
    // function", so a panel has to be told apart by its discriminant rather than by the
    // absence of the thing being checked for.
    expect(() => validateAdminPages([adminPanel("curation", { label: "Curation" })])).not.toThrow();
    expect(() => validateAdminPages([{ slug: "broken", label: "Broken" } as never])).toThrow(/no render function/);
  });

  test("a panel's slug is held to the same routing rule — it is served at /apps/:slug", () => {
    expect(() => validateAdminPages([adminPanel("My Panel", { label: "x" })])).toThrow(/URL segment/);
    expect(() => validateAdminPages([adminPanel("cur", { label: "  " })])).toThrow(/empty label/);
  });

  test("a panel and a page cannot share a slug — one route, one registry", () => {
    // They share `/apps/:slug`, so a collision is a collision whatever the kinds; which one
    // would win is decided by Map insertion order, and that is not a thing to leave to
    // chance in a deployment where one of the two is role-gated and the other is not.
    expect(() => validateAdminPages([blocks("desk"), adminPanel("desk", { label: "Desk" })])).toThrow(/duplicate admin page slug/);
    expect(() => createAdminPageHandlers([adminPanel("desk", { label: "A" }), adminPanel("desk", { label: "B" })])).toThrow(/duplicate/);
  });
});

describe("who sees a panel", () => {
  test("the listing is filtered by role, exactly as a Block Kit page's is", () => {
    const h = H(adminPanel("curation", { label: "Curation" }), adminPanel("finance", { label: "Finance", roles: ["admin"] }));
    expect(h.listAdminPages.run(ctxAs("editor")).map((p) => p.slug)).toEqual(["curation"]);
    expect(h.listAdminPages.run(ctxAs("admin")).map((p) => p.slug)).toEqual(["curation", "finance"]);
  });

  test("a caller with no role at all sees none of them", () => {
    const h = H(adminPanel("curation", { label: "Curation" }), blocks("dispatch"));
    expect(h.listAdminPages.run(ctxAs())).toEqual([]);
    expect(h.listAdminPages.run(asCaller({}))).toEqual([]);
  });

  test("a single `role` string is honoured, not only a `roles` array", () => {
    const h = H(adminPanel("finance", { label: "Finance", roles: ["admin"] }));
    expect(h.listAdminPages.run(asCaller({ role: "admin" })).map((p) => p.slug)).toEqual(["finance"]);
    expect(h.listAdminPages.run(asCaller({ role: "editor" }))).toEqual([]);
  });

  test("the two kinds are listed together, in declaration order, and say which they are", () => {
    // One list, because they are one nav band and one route. The `kind` is what the editor
    // switches on to decide whether to render blocks or to look for a registered component.
    const h = H(blocks("dispatch"), adminPanel("curation", { label: "Curation" }));
    expect(h.listAdminPages.run(ctxAs("editor"))).toEqual([
      { slug: "dispatch", label: "dispatch", icon: undefined, navOrder: NAV_ORDER.adminPages, kind: "blocks" },
      { slug: "curation", label: "Curation", icon: undefined, navOrder: NAV_ORDER.adminPages, kind: "panel" },
    ]);
  });

  test("a panel places itself in the nav like anything else", () => {
    const h = H(adminPanel("curation", { label: "Curation", icon: "🎛", navOrder: NAV_ORDER.media + 10 }));
    const [entry] = h.listAdminPages.run(ctxAs("editor"));
    expect(entry!.navOrder).toBe(NAV_ORDER.media + 10);
    expect(entry!.icon).toBe("🎛");
  });

  test("the listing still never carries the role list", () => {
    const h = H(adminPanel("finance", { label: "Finance", roles: ["admin"] }));
    expect(Object.keys(h.listAdminPages.run(ctxAs("admin"))[0]!).sort()).toEqual(["icon", "kind", "label", "navOrder", "slug"]);
  });

  test("`editorRoles` is the default gate for a panel too — one deployment, one answer", () => {
    const h = createAdminPageHandlers([adminPanel("curation", { label: "Curation" })], { editorRoles: ["author"] }) as Handlers;
    expect(h.listAdminPages.run(ctxAs("author")).map((p) => p.slug)).toEqual(["curation"]);
    expect(h.listAdminPages.run(ctxAs("editor"))).toEqual([]);
  });
});

describe("interacting with a panel", () => {
  test("a forbidden panel answers exactly as an unknown slug does", async () => {
    // Same reasoning as for a page: a distinct 'you may not open that' tells an
    // unauthorized caller which screens exist.
    const h = H(adminPanel("finance", { label: "Finance", roles: ["admin"] }));
    await expect(h.adminPageInteract.run(ctxAs("editor"), { page: "finance", type: "page_load" })).rejects.toThrow(/unknown admin page/);
    await expect(h.adminPageInteract.run(ctxAs("editor"), { page: "nope", type: "page_load" })).rejects.toThrow(/unknown admin page/);
  });

  test("a panel the caller MAY open says plainly that it has no server render", async () => {
    // Not folded into 'unknown admin page'. This caller passed the gate, so there is nothing
    // to hide from them — and hiding it would send whoever wired the call hunting for a
    // registration mistake that is not there.
    const h = H(adminPanel("curation", { label: "Curation" }));
    await expect(h.adminPageInteract.run(ctxAs("editor"), { page: "curation", type: "page_load" })).rejects.toThrow(/is a panel/);
  });
});

describe("the kinds", () => {
  test("are a closed set the editor mirrors", () => {
    expect([...ADMIN_PAGE_KINDS]).toEqual(["blocks", "panel"]);
  });
});
