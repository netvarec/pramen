// @pramen/cms — `listPages` scoped to one content type.
//
// A CMS holding two content types (pages AND articles) pooled them into one list: same
// column, same rows, nothing but the slug to tell a landing page from a news item. The
// editor now gives each type its own tab, and each tab asks for its own type BY SLUG.
//
// The filtering has to happen HERE and not in the editor. `listPages` caps its result, so a
// client narrowing a pooled fetch would be narrowing an already-truncated list and would
// silently lose the tail of every type once a deployment passes that cap. The same argument
// makes the CAP itself part of the contract: these tests assert the limit, the ordering and
// the projection on the FILTERED branch too, not just the unfiltered one.

import { describe, expect, test } from "bun:test";
import { createCmsHandlers, PAGE_LIST_LIMIT, PAGE_LIST_MAX_LIMIT } from "../packages/cms/src/index";
import type { HandlerContext } from "@pramen/server";

type Query = { from: string; where?: Record<string, unknown>; limit?: number; offset?: number; orderBy?: unknown; select?: readonly string[] };

const TYPES = [
  { id: "t-page", slug: "page" },
  { id: "t-article", slug: "article" },
];
const PAGES = [
  { id: "p1", typeId: "t-page", title: "O projektu" },
  { id: "a1", typeId: "t-article", title: "Novinka" },
  { id: "a2", typeId: "t-article", title: "Další novinka" },
];

/** A ctx whose `db.find` answers like the real store and records what was asked.
 *
 * It understands `where: { type: { slug } }` — the relation traversal the handler compiles
 * to — because that is the whole point: the slug is resolved by a subquery, in ONE query,
 * rather than by a round trip through `cms_content_types` that also throws for a policy set
 * granting cms_pages but not the types table. */
function stubCtx() {
  const queries: Query[] = [];
  const db = {
    find: async (q: Query) => {
      queries.push(q);
      if (q.from === "cms_content_types") return TYPES.filter((t) => t.slug === q.where?.slug);
      if (q.from === "cms_pages") {
        const rel = q.where?.type as { slug?: string } | undefined;
        if (rel === undefined) return PAGES;
        const type = TYPES.find((t) => t.slug === rel.slug);
        return type ? PAGES.filter((p) => p.typeId === type.id) : [];
      }
      return [];
    },
  };
  return { ctx: { db } as unknown as HandlerContext, queries };
}

const handler = () => (createCmsHandlers() as unknown as {
  listPages: {
    run: (c: HandlerContext, i: { contentType?: string; limit?: number; offset?: number; select?: string[] }) => Promise<Record<string, unknown>[]>;
    input: (raw: unknown) => Record<string, unknown>;
    auth?: readonly string[];
  };
}).listPages;

describe("listPages", () => {
  test("no filter lists every type — the behaviour every existing deployment has", async () => {
    const { ctx, queries } = stubCtx();
    expect(await handler().run(ctx, {})).toHaveLength(3);
    expect(queries).toHaveLength(1);
    expect(queries[0].where).toBeUndefined();
    expect(queries[0].limit).toBe(PAGE_LIST_LIMIT);
  });

  test("a content-type slug narrows the list to that type", async () => {
    const { ctx } = stubCtx();
    const rows = await handler().run(ctx, { contentType: "article" });
    expect(rows.map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  // ONE query, via the `type` belongsTo the schema already declares. A hand-rolled
  // slug→id lookup costs a second sequential round trip and THROWS (rather than returning
  // nothing) for a caller who may read cms_pages but not cms_content_types.
  test("the slug is resolved by traversing the declared relation, in a single query", async () => {
    const { ctx, queries } = stubCtx();
    await handler().run(ctx, { contentType: "page" });
    expect(queries.map((q) => q.from)).toEqual(["cms_pages"]);
    expect(queries[0].where).toEqual({ type: { slug: "page" } });
  });

  // The cap and the ordering are the contract, not an implementation detail: the editor's
  // header reports the row count, and "newest first" is what makes a capped list useful.
  // Asserted on the FILTERED branch too — that is the branch every per-type tab takes.
  test("the filtered branch carries the same cap, ordering and projection as the pooled one", async () => {
    const { ctx, queries } = stubCtx();
    await handler().run(ctx, { contentType: "article", select: ["id", "title"] });
    expect(queries[0].limit).toBe(PAGE_LIST_LIMIT);
    expect(queries[0].orderBy).toEqual({ column: "createdAt", dir: "desc" });
    expect(queries[0].select).toEqual(["id", "title"]);
  });

  test("limit and offset page the list, and a caller cannot ask for more than the ceiling", async () => {
    const { ctx, queries } = stubCtx();
    await handler().run(ctx, { limit: 50, offset: 100 });
    expect(queries[0].limit).toBe(50);
    expect(queries[0].offset).toBe(100);

    const big = stubCtx();
    await handler().run(big.ctx, { limit: 100_000 });
    expect(big.queries[0].limit).toBe(PAGE_LIST_MAX_LIMIT);
  });

  // The one that matters: falling back to the unfiltered list would put every article under
  // a tab labelled "Pages" the moment a slug was misspelled or a type was renamed.
  test("an unknown slug returns nothing, never everything", async () => {
    const { ctx } = stubCtx();
    expect(await handler().run(ctx, { contentType: "nope" })).toEqual([]);
  });

  // …and an EMPTY slug is an unknown slug, not "no filter". A falsy check here read as
  // "unfiltered" and handed back every type's pages — the exact inverse of the rule above,
  // and reachable, since a content type's slug is caller-supplied.
  test("an empty slug matches nothing — it is not a synonym for unfiltered", async () => {
    const { ctx, queries } = stubCtx();
    expect(await handler().run(ctx, { contentType: "" })).toEqual([]);
    expect(queries[0].where).toEqual({ type: { slug: "" } });
  });

  // Full page rows: schedule stamps, the revision pointer, every SEO column, the whole
  // `fields` bag. That is the editing surface; `listPublishedPages` is the public one.
  test("is viewer-gated, not open to anonymous callers", () => {
    expect(handler().auth).toEqual(["editor", "admin", "reviewer"]);
  });

  describe("input parsing", () => {
    test("the validator exists and rejects with a 400, not a TypeError", () => {
      const parse = handler().input;
      expect(typeof parse).toBe("function");
      // A bare `.toThrow()` would pass on `input is not a function` if the validator were
      // ever deleted, so assert the STATUS the caller actually receives.
      for (const bad of [{ contentType: 42 }, { contentType: ["article"] }, { limit: "10" }, { limit: -1 }, { limit: 1.5 }, { select: "id" }, { select: [1] }]) {
        expect(() => parse(bad)).toThrow(expect.objectContaining({ status: 400 }));
      }
    });

    test("absent or null means unfiltered, not an empty-string slug that matches nothing", () => {
      expect(handler().input({})).toEqual({});
      expect(handler().input({ contentType: null })).toEqual({});
      expect(handler().input(undefined)).toEqual({});
    });

    test("a string passes through — including the empty one, which is a real (unmatchable) slug", () => {
      expect(handler().input({ contentType: "article" })).toEqual({ contentType: "article" });
      expect(handler().input({ contentType: "" })).toEqual({ contentType: "" });
    });

    // The PARSED value is what the ACL sees: dispatch hands it to `Db` as `input`, which is
    // what `$input("path")` policy markers resolve against. Rebuilding an object from the
    // keys this handler knows silently collapsed any such policy's scope to nothing.
    test("unrecognised keys survive — policy `$input()` markers resolve against this value", () => {
      expect(handler().input({ contentType: "article", capabilityKey: "abc" })).toEqual({ contentType: "article", capabilityKey: "abc" });
      expect(handler().input({ tenantScope: "acme" })).toEqual({ tenantScope: "acme" });
    });
  });
});
