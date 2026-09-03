// @pramen/cms — Block Kit: custom admin pages described as JSON (GitHub #33, #44 tier 3).
//
// The contract these tests hold is narrow and worth stating: Block Kit removes the browser
// CODE from a project's admin screen, not the boundary around it. A page's `render` is an
// ordinary handler body with the caller's own ctx, the registry is keyed server-side so a
// client cannot name what runs, and the response is checked on the way out for the one
// thing in it that is not text.

import { describe, expect, test } from "bun:test";
import {
  adminPage,
  createAdminPageHandlers,
  MAX_ADMIN_BLOCK_DEPTH,
  NAV_ORDER,
  normalizeAdminResponse,
  validateAdminPages,
  type AdminBlock,
  type AdminPageInteraction,
  type AdminPageMeta,
  type AdminPageResponse,
} from "../packages/cms/src/index";
import type { HandlerContext } from "@pramen/server";

const ctxAs = (...roles: string[]) => ({ identity: { roles } }) as unknown as HandlerContext;

const page = (over: Partial<Parameters<typeof adminPage>[1]> = {}) =>
  adminPage("dispatch", {
    label: "Dispatch",
    render: () => ({ blocks: [{ type: "header", text: "Today" }] }),
    ...over,
  });

type Handlers = {
  listAdminPages: { run: (c: HandlerContext) => AdminPageMeta[] };
  adminPageInteract: { run: (c: HandlerContext, i: AdminPageInteraction) => Promise<AdminPageResponse>; input: (raw: unknown) => AdminPageInteraction };
};
const H = (...pages: ReturnType<typeof adminPage>[]) => createAdminPageHandlers(pages) as unknown as Handlers;

describe("the registry", () => {
  test("a slug must be routable — it is served at /apps/:slug", () => {
    expect(() => validateAdminPages([adminPage("My Page", { label: "x", render: () => ({ blocks: [] }) })])).toThrow(/URL segment/);
    expect(() => validateAdminPages([adminPage("my_page", { label: "x", render: () => ({ blocks: [] }) })])).toThrow(/URL segment/);
  });

  test("duplicate slugs are refused — the slug IS the registry's key", () => {
    expect(() => validateAdminPages([page(), page()])).toThrow(/duplicate admin page slug/);
  });

  test("an empty label would render an unnamed nav entry", () => {
    expect(() => validateAdminPages([adminPage("x", { label: "  ", render: () => ({ blocks: [] }) })])).toThrow(/empty label/);
  });

  test("the registry is validated at handler-construction time, not on first open", () => {
    expect(() => createAdminPageHandlers([page(), page()])).toThrow(/duplicate/);
  });
});

describe("who sees and who may open", () => {
  test("the listing is FILTERED, not annotated — a nav entry that 403s is worse than none", () => {
    const h = H(page(), adminPage("finance", { label: "Finance", roles: ["admin"], render: () => ({ blocks: [] }) }));
    expect(h.listAdminPages.run(ctxAs("editor")).map((p) => p.slug)).toEqual(["dispatch"]);
    expect(h.listAdminPages.run(ctxAs("admin")).map((p) => p.slug)).toEqual(["dispatch", "finance"]);
  });

  test("a page carries its nav position, defaulting beside the other project surfaces", () => {
    const h = H(page(), adminPage("finance", { label: "Finance", navOrder: 150, render: () => ({ blocks: [] }) }));
    const [dispatch, finance] = h.listAdminPages.run(ctxAs("editor"));
    expect(dispatch!.navOrder).toBe(NAV_ORDER.adminPages);
    expect(finance!.navOrder).toBe(150);
  });

  test("the listing never carries the role list or the render function", () => {
    const h = H(adminPage("finance", { label: "Finance", roles: ["admin"], render: () => ({ blocks: [] }) }));
    expect(Object.keys(h.listAdminPages.run(ctxAs("admin"))[0]!).sort()).toEqual(["icon", "label", "navOrder", "slug"]);
  });

  test("an unknown slug and a forbidden one answer the same way", async () => {
    // Deliberately identical: a distinct "you may not open that" tells an unauthorized
    // caller which pages exist.
    const h = H(adminPage("finance", { label: "Finance", roles: ["admin"], render: () => ({ blocks: [] }) }));
    await expect(h.adminPageInteract.run(ctxAs("editor"), { page: "finance", type: "page_load" })).rejects.toThrow(/unknown admin page/);
    await expect(h.adminPageInteract.run(ctxAs("editor"), { page: "nope", type: "page_load" })).rejects.toThrow(/unknown admin page/);
  });

  test("a forbidden page's render never runs", async () => {
    let ran = false;
    const h = H(adminPage("finance", { label: "Finance", roles: ["admin"], render: () => { ran = true; return { blocks: [] }; } }));
    await expect(h.adminPageInteract.run(ctxAs("editor"), { page: "finance", type: "page_load" })).rejects.toThrow();
    expect(ran).toBe(false);
  });
});

describe("the interaction envelope", () => {
  test("an unknown interaction type is refused", () => {
    const h = H(page());
    expect(() => h.adminPageInteract.input({ page: "dispatch", type: "eval" })).toThrow(/unknown interaction type/);
    expect(h.adminPageInteract.input({ page: "dispatch" }).type).toBe("page_load");
  });

  test("`values` must be an object, not an array a page would spread", () => {
    const h = H(page());
    expect(() => h.adminPageInteract.input({ page: "dispatch", type: "form_submit", values: [1, 2] })).toThrow(/must be an object/);
  });

  test("the interaction reaches render intact", async () => {
    let seen: AdminPageInteraction | null = null;
    const h = H(adminPage("dispatch", { label: "D", render: (_c, i) => { seen = i; return { blocks: [] }; } }));
    await h.adminPageInteract.run(ctxAs("editor"), h.adminPageInteract.input({ page: "dispatch", type: "form_submit", action_id: "save", block_id: "settings", values: { url: "x" } }));
    expect(seen).toEqual({ page: "dispatch", type: "form_submit", action_id: "save", block_id: "settings", values: { url: "x" } });
  });

  test("render gets the CALLER's ctx — Block Kit removes the browser code, not the ACL", async () => {
    let seen: HandlerContext | null = null;
    const h = H(adminPage("dispatch", { label: "D", render: (c) => { seen = c; return { blocks: [] }; } }));
    const ctx = ctxAs("editor");
    await h.adminPageInteract.run(ctx, { page: "dispatch", type: "page_load" });
    expect(seen).toBe(ctx);
  });
});

describe("the response is checked on the way out", () => {
  test("an image url goes through the same allow-list a rich-text link does", () => {
    // Server-authored is not the same as trustworthy: a page builds blocks from data, so a
    // url can come out of a row or an external API.
    expect(() => normalizeAdminResponse({ blocks: [{ type: "image", url: "javascript:alert(1)" }] })).toThrow(/not an allowed href/);
    expect(normalizeAdminResponse({ blocks: [{ type: "image", url: " /media/x.png " }] }).blocks[0]).toEqual({ type: "image", url: "/media/x.png" });
  });

  test("a form needs a block_id, because that is what keys its local values", () => {
    // Two forms sharing one would share their state, so the second would submit the first's.
    expect(() => normalizeAdminResponse({ blocks: [{ type: "form", block_id: "", fields: [], submit: { label: "Go", action_id: "go" } }] })).toThrow(/needs a block_id/);
  });

  test("nesting is capped, because rendering is recursive", () => {
    let deep: AdminBlock = { type: "section", text: "leaf" };
    for (let i = 0; i < MAX_ADMIN_BLOCK_DEPTH; i++) deep = { type: "accordion", title: `a${i}`, blocks: [deep] };
    expect(() => normalizeAdminResponse({ blocks: [deep] })).toThrow(/nest deeper than/);
  });

  test("a page that returns the wrong shape is named, not silently blank", () => {
    expect(() => normalizeAdminResponse(undefined as unknown as AdminPageResponse)).toThrow(/must return \{ blocks/);
  });

  test("a nested image is checked too", () => {
    expect(() => normalizeAdminResponse({
      blocks: [{ type: "columns", columns: [[{ type: "image", url: "data:text/html,<script>" }]] }],
    })).toThrow(/not an allowed href/);
  });

  test("a toast rides back alongside the blocks", async () => {
    const h = H(adminPage("dispatch", { label: "D", render: () => ({ blocks: [], toast: { text: "Saved", tone: "success" } }) }));
    const res = await h.adminPageInteract.run(ctxAs("editor"), { page: "dispatch", type: "block_action" });
    expect(res.toast).toEqual({ text: "Saved", tone: "success" });
  });
});
