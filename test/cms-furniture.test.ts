// @pramen/cms — site furniture: menus, redirects, taxonomies, widget areas (GitHub #32).
//
// Everything here is a WRITE-path or READ-path rule that the editor's UI happens to also
// enforce, and that is exactly why it is tested at the handler: the editor is not the only
// writer. Every one of these shapes is reachable with a curl, and three of them —
// a `javascript:` menu href, a term cycle, an unsanitized widget document — are the kind of
// input the front end renders straight into the page.

import { describe, expect, test } from "bun:test";
import { createCmsHandlers, cmsPolicies, MAX_MENU_DEPTH, normalizeRedirectPath } from "../packages/cms/src/index";
import type { HandlerContext } from "@pramen/server";

type Row = Record<string, unknown>;
type Query = { from: string; where?: Record<string, unknown>; select?: readonly string[]; limit?: number; orderBy?: unknown };

/**
 * A ctx over an in-memory table map.
 *
 * Deliberately dumb about `where`: it supports equality and `{ in: [...] }`, which is every
 * predicate these handlers use. Anything cleverer would be testing the stub.
 */
function stubCtx(tables: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = { ...tables };
  const match = (row: Row, where?: Record<string, unknown>): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const op = v as { in?: unknown[]; isNull?: boolean };
        if (Array.isArray(op.in)) return op.in.includes(row[k]);
        if (op.isNull === false) return row[k] != null;
        if (op.isNull === true) return row[k] == null;
      }
      return row[k] === v;
    });
  };
  const db = {
    find: async (q: Query) => (store[q.from] ?? []).filter((r) => match(r, q.where)).slice(0, q.limit ?? Infinity),
    insert: async (table: string, values: Row) => {
      const row = { id: `${table}-${(store[table] ?? []).length + 1}`, ...values };
      (store[table] ??= []).push(row);
      return row;
    },
    update: async (table: string, id: string, patch: Row) => {
      const row = (store[table] ?? []).find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      return row;
    },
    delete: async (table: string, id: string) => {
      const list = store[table] ?? [];
      const i = list.findIndex((r) => r.id === id);
      if (i < 0) return false;
      list.splice(i, 1);
      return true;
    },
    exec: async () => [],
  };
  return { ctx: { db, identity: { roles: ["admin"] } } as unknown as HandlerContext, store };
}

type Handler = { run: (c: HandlerContext, i: never) => unknown; input?: (raw: unknown) => unknown; auth?: readonly string[] };
const H = (opts?: Parameters<typeof createCmsHandlers>[0]) => createCmsHandlers(opts) as unknown as Record<string, Handler>;

/** Run a handler the way dispatch does: parse the input, then run. */
async function call(h: Record<string, Handler>, name: string, raw: unknown, ctx: HandlerContext): Promise<unknown> {
  const handler = h[name];
  if (!handler) throw new Error(`no handler ${name}`);
  const input = handler.input ? handler.input(raw) : raw;
  return handler.run(ctx, input as never);
}

// --- menus ---------------------------------------------------------------------------

describe("menus", () => {
  test("a custom item's url goes through the same allow-list a rich-text link does", async () => {
    const h = H();
    const { ctx } = stubCtx();
    // The menu is rendered into an `<a href>` on every page of the site, so this is the
    // hole `isSafeHref` exists to close — and the editor is not the only writer.
    await expect(call(h, "createMenu", { name: "primary", label: "Primary", items: [{ label: "x", url: "javascript:alert(1)" }] }, ctx)).rejects.toThrow(/valid url/);
    await expect(call(h, "createMenu", { name: "primary", label: "Primary", items: [{ label: "x", url: "/about" }] }, ctx)).resolves.toBeTruthy();
  });

  test("an item is REBUILT, so nothing the client invented is stored", async () => {
    const h = H();
    const { ctx, store } = stubCtx();
    await call(h, "createMenu", { name: "primary", label: "Primary", items: [{ label: "About", url: "/about", evil: "<script>", onclick: "x" }] }, ctx);
    const item = (store.cms_menus![0]!.items as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(item).sort()).toEqual(["id", "kind", "label", "url"]);
  });

  test("a reference item needs a ref, and a custom item needs a url", async () => {
    const h = H();
    const { ctx } = stubCtx();
    await expect(call(h, "createMenu", { name: "m", label: "M", items: [{ label: "x", kind: "page" }] }, ctx)).rejects.toThrow(/needs a `ref`/);
    await expect(call(h, "createMenu", { name: "m", label: "M", items: [{ label: "x", kind: "custom" }] }, ctx)).rejects.toThrow(/valid url/);
  });

  test("the tree is depth-capped", async () => {
    const h = H();
    const { ctx } = stubCtx();
    let deep: Record<string, unknown> = { label: "leaf", url: "/" };
    for (let i = 0; i < MAX_MENU_DEPTH; i++) deep = { label: `l${i}`, url: "/", children: [deep] };
    await expect(call(h, "createMenu", { name: "m", label: "M", items: [deep] }, ctx)).rejects.toThrow(/nest at most/);
  });

  test("a target other than a browsing-context keyword is refused", async () => {
    const h = H();
    const { ctx } = stubCtx();
    await expect(call(h, "createMenu", { name: "m", label: "M", items: [{ label: "x", url: "/", target: "someWindow" }] }, ctx)).rejects.toThrow(/unsupported target/);
  });

  test("getMenu resolves a page reference to a path — and DROPS one that no longer resolves", async () => {
    const h = H();
    const { ctx } = stubCtx({
      cms_menus: [{
        id: "m1", name: "primary", label: "Primary",
        items: [
          { id: "a", label: "About", kind: "page", ref: "p1" },
          // The page read goes through `ctx.db`, so for an anonymous caller the public
          // policy (published, not trashed) is what decides this. A menu link to an
          // unpublished page must not render, and a nav entry with no href is a dead link
          // on every page of the site — so the item goes, and its subtree with it.
          { id: "b", label: "Gone", kind: "page", ref: "missing", children: [{ id: "c", label: "Child", kind: "custom", url: "/c" }] },
        ],
      }],
      cms_pages: [{ id: "p1", slug: "about", locale: "en" }],
    });
    const menu = await call(h, "getMenu", { name: "primary" }, ctx) as { items: Array<{ id: string; url: string }> };
    expect(menu.items.map((i) => i.id)).toEqual(["a"]);
    expect(menu.items[0]!.url).toBe("/about");
  });

  test("the locale segment appears only where the deployment declares more than one", async () => {
    const store = {
      cms_menus: [{ id: "m1", name: "primary", label: "P", items: [{ id: "a", label: "About", kind: "page", ref: "p1" }] }],
      cms_pages: [{ id: "p1", slug: "about", locale: "cs" }],
    };
    const mono = await call(H({ locales: ["cs"] }), "getMenu", { name: "primary" }, stubCtx(structuredClone(store)).ctx) as { items: Array<{ url: string }> };
    expect(mono.items[0]!.url).toBe("/about");
    const multi = await call(H({ locales: ["cs", "en"] }), "getMenu", { name: "primary" }, stubCtx(structuredClone(store)).ctx) as { items: Array<{ url: string }> };
    expect(multi.items[0]!.url).toBe("/cs/about");
  });

  test("`menuHref` is the seam a deployment routes through", async () => {
    const h = H({ menuHref: (t) => (t.kind === "page" ? `/clanky/${t.slug}` : "/") });
    const { ctx } = stubCtx({
      cms_menus: [{ id: "m1", name: "primary", label: "P", items: [{ id: "a", label: "About", kind: "page", ref: "p1" }] }],
      cms_pages: [{ id: "p1", slug: "about", locale: "en" }],
    });
    const menu = await call(h, "getMenu", { name: "primary" }, ctx) as { items: Array<{ url: string }> };
    expect(menu.items[0]!.url).toBe("/clanky/about");
  });

  test("an unknown menu is null, not a 404 — a layout asking for one not yet created is normal", async () => {
    expect(await call(H(), "getMenu", { name: "primary" }, stubCtx().ctx)).toBeNull();
  });
});

// --- redirects -----------------------------------------------------------------------

describe("redirects", () => {
  test("a path is canonicalized, because matching is an exact lookup on a unique column", () => {
    // "/old" and "/old/" are the same URL to a visitor and would be two rows, the second of
    // which could never match.
    expect(normalizeRedirectPath("/old/")).toBe("/old");
    expect(normalizeRedirectPath("/old?x=1#f")).toBe("/old");
    expect(normalizeRedirectPath("/")).toBe("/");
    expect(() => normalizeRedirectPath("old")).toThrow(/rooted path/);
    expect(() => normalizeRedirectPath("//evil.example/x")).toThrow(/rooted path/);
    expect(() => normalizeRedirectPath("https://evil.example/x")).toThrow(/rooted path/);
  });

  test("a target may be a rooted path or an absolute http(s) url, and nothing else", async () => {
    const h = H();
    const { ctx } = stubCtx();
    await expect(call(h, "createRedirect", { fromPath: "/a", toPath: "mailto:x@y.z" }, ctx)).rejects.toThrow(/rooted path or an absolute/);
    await expect(call(h, "createRedirect", { fromPath: "/a", toPath: "https://example.com/b" }, ctx)).resolves.toBeTruthy();
  });

  test("only real redirect statuses are accepted", async () => {
    const h = H();
    const { ctx } = stubCtx();
    await expect(call(h, "createRedirect", { fromPath: "/a", toPath: "/b", status: 200 }, ctx)).rejects.toThrow(/status must be one of/);
  });

  test("a redirect cannot point at itself, and a duplicate source is a 409", async () => {
    const h = H();
    const { ctx } = stubCtx();
    await expect(call(h, "createRedirect", { fromPath: "/a", toPath: "/a" }, ctx)).rejects.toThrow(/point at itself/);
    // …but a TRAILING-SLASH redirect is not a loop, it is the canonicalization everyone
    // eventually writes — which is why only `fromPath` is slash-canonicalized, not `toPath`.
    await expect(call(h, "createRedirect", { fromPath: "/a", toPath: "/a/" }, ctx)).resolves.toBeTruthy();
    await expect(call(h, "createRedirect", { fromPath: "/a", toPath: "/c" }, ctx)).rejects.toThrow(/already exists/);
  });

  test("resolveRedirect answers with the destination, and is a READ", async () => {
    const h = H();
    const { ctx } = stubCtx({ cms_redirects: [{ id: "r1", fromPath: "/old", toPath: "/new", status: 301, enabled: true }] });
    // Canonicalized on the way in, so a request for "/old/" hits the row stored as "/old".
    expect(await call(h, "resolveRedirect", { path: "/old/" }, ctx)).toEqual({ to: "/new", status: 301 });
    expect(await call(h, "resolveRedirect", { path: "/nope" }, ctx)).toBeNull();
    // No `auth` — this is what a front end calls on every 404, as anonymous traffic.
    expect(H().resolveRedirect.auth).toBeUndefined();
  });

  test("the public read scope hides a disabled redirect, not just the one handler that filters", () => {
    const scope = cmsPolicies().public.find((p) => p.name.endsWith("redirects:read"));
    expect(scope).toBeTruthy();
    expect(JSON.stringify(scope)).toContain("enabled");
  });
});

// --- taxonomies ----------------------------------------------------------------------

describe("taxonomies", () => {
  const vocab = (hierarchical: boolean) => ({
    cms_taxonomies: [{ id: "tx1", slug: "category", label: "Category", hierarchical }],
    cms_terms: [
      { id: "t1", taxonomyId: "tx1", slug: "news", label: "News", parentId: null, position: 0 },
      { id: "t2", taxonomyId: "tx1", slug: "local", label: "Local", parentId: "t1", position: 0 },
    ],
  });

  test("a flat vocabulary refuses a parent rather than storing one nothing renders", async () => {
    const h = H();
    const { ctx } = stubCtx(vocab(false));
    await expect(call(h, "createTerm", { taxonomy: "category", slug: "x", label: "X", parentId: "t1" }, ctx)).rejects.toThrow(/flat/);
  });

  test("a term cannot be moved under its own descendant", async () => {
    // The FK keeps `parentId` pointing at a real row but says nothing about shape:
    // `t1.parent = t2` while `t2.parent = t1` is two legal writes that together make the
    // tree unreachable and any recursive renderer loop. Only preventable on write.
    const h = H();
    const { ctx } = stubCtx(vocab(true));
    await expect(call(h, "updateTerm", { id: "t1", parentId: "t2" }, ctx)).rejects.toThrow(/its own descendants/);
    await expect(call(h, "updateTerm", { id: "t1", parentId: "t1" }, ctx)).rejects.toThrow(/its own parent/);
  });

  test("getTermTree folds the rows so every consumer does not", async () => {
    const h = H();
    const { ctx } = stubCtx(vocab(true));
    const tree = await call(h, "getTermTree", { taxonomy: "category" }, ctx) as Array<{ id: string; children: Array<{ id: string }> }>;
    expect(tree.map((t) => t.id)).toEqual(["t1"]);
    expect(tree[0]!.children.map((c) => c.id)).toEqual(["t2"]);
  });

  test("a vocabulary cannot be flattened while terms still nest under one another", async () => {
    const h = H();
    const { ctx } = stubCtx(vocab(true));
    await expect(call(h, "updateTaxonomy", { id: "tx1", hierarchical: false }, ctx)).rejects.toThrow(/nested terms/);
  });

  test("setPageTerms replaces the selection, and leaves surviving links alone", async () => {
    const h = H();
    const { ctx, store } = stubCtx({
      ...vocab(true),
      cms_pages: [{ id: "p1" }],
      cms_page_terms: [{ id: "link-old", pageId: "p1", termId: "t1" }],
    });
    await call(h, "setPageTerms", { pageId: "p1", termIds: ["t1", "t2"] }, ctx);
    const links = store.cms_page_terms!;
    expect(links.map((l) => l.termId).sort()).toEqual(["t1", "t2"]);
    // The row that survived is the SAME row — not deleted and reinserted.
    expect(links.find((l) => l.termId === "t1")!.id).toBe("link-old");
    await call(h, "setPageTerms", { pageId: "p1", termIds: [] }, ctx);
    expect(store.cms_page_terms).toEqual([]);
  });

  test("setPageTerms refuses an id that is not a term", async () => {
    const h = H();
    const { ctx } = stubCtx({ ...vocab(true), cms_pages: [{ id: "p1" }], cms_page_terms: [] });
    await expect(call(h, "setPageTerms", { pageId: "p1", termIds: ["nope"] }, ctx)).rejects.toThrow(/not terms/);
  });
});

// --- widget areas ---------------------------------------------------------------------

describe("widget areas", () => {
  test("a content widget's rich text goes through the same allow-list a block field does", async () => {
    const h = H();
    const { ctx, store } = stubCtx();
    await call(h, "createWidgetArea", {
      name: "sidebar",
      label: "Sidebar",
      widgets: [{ type: "content", content: { type: "doc", content: [{ type: "evilNode", attrs: { onclick: "x" } }, { type: "paragraph", content: [{ type: "text", text: "hi" }] }] } }],
    }, ctx);
    const doc = (store.cms_widget_areas![0]!.widgets as Array<{ content: { content: Array<{ type: string }> } }>)[0]!.content;
    // The unknown node is dropped by `normalizeRichText`, exactly as it is on a block field.
    expect(doc.content.map((n) => n.type)).toEqual(["paragraph"]);
  });

  test("a component widget's props must be an object, not an array or a scalar", async () => {
    const h = H();
    const { ctx } = stubCtx();
    await expect(call(h, "createWidgetArea", { name: "s", label: "S", widgets: [{ type: "component", componentId: "x", componentProps: [1, 2] }] }, ctx)).rejects.toThrow(/must be an object/);
  });

  test("an unknown widget type is refused", async () => {
    const h = H();
    const { ctx } = stubCtx();
    await expect(call(h, "createWidgetArea", { name: "s", label: "S", widgets: [{ type: "iframe" }] }, ctx)).rejects.toThrow(/unknown type/);
  });

  test("getWidgetArea resolves a menu widget inline, so a layout renders a sidebar in one call", async () => {
    const h = H();
    const { ctx } = stubCtx({
      cms_widget_areas: [{ id: "w1", name: "sidebar", label: "Sidebar", description: null, widgets: [{ id: "x", type: "menu", menuName: "footer" }, { id: "y", type: "menu", menuName: "gone" }] }],
      cms_menus: [{ id: "m1", name: "footer", label: "Footer", items: [] }],
    });
    const area = await call(h, "getWidgetArea", { name: "sidebar" }, ctx) as { widgets: Array<{ menu: { name: string } | null }> };
    expect(area.widgets[0]!.menu!.name).toBe("footer");
    // A menu that no longer exists leaves an EMPTY widget rather than being dropped: unlike
    // a menu item, an empty widget is a visible hole an editor can see and fix.
    expect(area.widgets[1]!.menu).toBeNull();
  });
});

// --- gating ----------------------------------------------------------------------------

describe("who may call what", () => {
  test("reads that a site renders are public; every write is editor-gated", () => {
    const h = H();
    for (const name of ["getMenu", "resolveRedirect", "listTaxonomies", "listTerms", "getTermTree", "listPageTerms", "listPagesByTerm", "getWidgetArea"]) {
      expect(h[name]!.auth, `${name} should be public`).toBeUndefined();
    }
    for (const name of ["createMenu", "updateMenu", "deleteMenu", "createRedirect", "updateRedirect", "deleteRedirect", "createTaxonomy", "updateTaxonomy", "deleteTaxonomy", "createTerm", "updateTerm", "deleteTerm", "setPageTerms", "createWidgetArea", "updateWidgetArea", "deleteWidgetArea"]) {
      expect(h[name]!.auth, `${name} should be editor-gated`).toEqual(["editor", "admin"]);
    }
  });

  test("the editor ACL fragment covers every furniture table", () => {
    const names = cmsPolicies().editor.map((p) => p.name).join(" ");
    for (const table of ["cms_menus", "cms_redirects", "cms_taxonomies", "cms_terms", "cms_page_terms", "cms_widget_areas"]) {
      expect(names, `${table} needs an editor grant`).toContain(table);
    }
  });
});
