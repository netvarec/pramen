// @pramen/cms — `listPages` scoped to one content type.
//
// A CMS holding two content types (pages AND articles) pooled them into one list: same
// column, same rows, nothing but the slug to tell a landing page from a news item. The
// editor now gives each type its own tab, and each tab asks for its own type BY SLUG.
//
// The filtering has to happen HERE and not in the editor. `listPages` caps at 100 rows, so a
// client narrowing a pooled fetch would be narrowing an already-truncated list and would
// silently lose the tail of every type once a deployment passes that cap.

import { describe, expect, test } from "bun:test";
import { createCmsHandlers } from "../packages/cms/src/index";
import type { HandlerContext } from "@pramen/server";

type Query = { from: string; where?: Record<string, unknown>; limit?: number; orderBy?: unknown };

const TYPES = [
  { id: "t-page", slug: "page" },
  { id: "t-article", slug: "article" },
];
const PAGES = [
  { id: "p1", typeId: "t-page", title: "O projektu" },
  { id: "a1", typeId: "t-article", title: "Novinka" },
  { id: "a2", typeId: "t-article", title: "Další novinka" },
];

/** A ctx whose `db.find` answers like the real store and records what was asked. */
function stubCtx() {
  const queries: Query[] = [];
  const db = {
    find: async (q: Query) => {
      queries.push(q);
      if (q.from === "cms_content_types") return TYPES.filter((t) => t.slug === q.where?.slug);
      if (q.from === "cms_pages") {
        const typeId = q.where?.typeId;
        return typeId === undefined ? PAGES : PAGES.filter((p) => p.typeId === typeId);
      }
      return [];
    },
  };
  return { ctx: { db } as unknown as HandlerContext, queries };
}

const handler = () => (createCmsHandlers() as unknown as {
  listPages: {
    run: (c: HandlerContext, i: { contentType?: string }) => Promise<Record<string, unknown>[]>;
    input: (raw: unknown) => { contentType?: string };
  };
}).listPages;

describe("listPages", () => {
  test("no filter lists every type — the behaviour every existing deployment has", async () => {
    const { ctx, queries } = stubCtx();
    expect(await handler().run(ctx, {})).toHaveLength(3);
    expect(queries).toHaveLength(1);
    expect(queries[0].where).toBeUndefined();
    expect(queries[0].limit).toBe(100);
  });

  test("a content-type slug narrows the list to that type", async () => {
    const { ctx } = stubCtx();
    const rows = await handler().run(ctx, { contentType: "article" });
    expect(rows.map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  test("the slug is resolved to an id, and the page query carries it — not the slug", async () => {
    const { ctx, queries } = stubCtx();
    await handler().run(ctx, { contentType: "page" });
    expect(queries[0].from).toBe("cms_content_types");
    expect(queries[1].from).toBe("cms_pages");
    expect(queries[1].where).toEqual({ typeId: "t-page" });
  });

  // The one that matters: falling back to the unfiltered list would put every article under
  // a tab labelled "Pages" the moment a slug was misspelled or a type was renamed.
  test("an unknown slug returns nothing, and never reads the pages table at all", async () => {
    const { ctx, queries } = stubCtx();
    expect(await handler().run(ctx, { contentType: "nope" })).toEqual([]);
    expect(queries.map((q) => q.from)).toEqual(["cms_content_types"]);
  });

  describe("input parsing", () => {
    test("absent or null means unfiltered, not an empty-string slug that matches nothing", () => {
      expect(handler().input({})).toEqual({});
      expect(handler().input({ contentType: null })).toEqual({});
      expect(handler().input(undefined)).toEqual({});
    });

    test("a non-string slug is rejected rather than coerced", () => {
      expect(() => handler().input({ contentType: 42 })).toThrow();
      expect(() => handler().input({ contentType: ["article"] })).toThrow();
    });

    test("a string passes through", () => {
      expect(handler().input({ contentType: "article" })).toEqual({ contentType: "article" });
    });
  });
});
