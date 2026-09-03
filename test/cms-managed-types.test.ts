// @pramen/cms — a code-defined block/content type is READ-ONLY over RPC (GitHub #48).
//
// `cmsBootstrap` reconciles the rows it declares on every boot, and #46 pointed a product
// surface at the same rows. So an editor opened a code-declared type, added a field, got a
// 200 — and lost it at the next cold start when `upsertBySlug` patched `fieldsSchema` back
// to the literal in `app.ts`, orphaning any block content authored against it.
//
// The editor renders a `managed` row read-only; this is the other half — the curl, the stale
// tab, and any client that has not been updated. A 409 rather than a 403: the row exists and
// the edit is well-formed, the conflict is with a definition this request cannot reach.

import { describe, expect, test } from "bun:test";
import { assertNotManaged, createCmsHandlers } from "../packages/cms/src/index";
import type { HandlerContext } from "@pramen/server";

type Row = Record<string, unknown>;
type Query = { from: string; where?: Record<string, unknown>; limit?: number; select?: string[] };
type Mutation = { run: (c: HandlerContext, i: Row) => Promise<unknown> };

function stubCtx(rows: Row[]) {
  const updates: { table: string; id: string; patch: Row }[] = [];
  const queries: Query[] = [];
  const db = {
    // PROJECTS, like the real `Db.find`. That is the whole point of these tests: reads are
    // column-projected against the caller's policy, so a guard that reads a column the
    // handler did not ask for is a guard that disappears under a `fields`-restricted policy.
    find: async (q: Query) =>
      (queries.push(q), rows)
        .filter((r) => Object.entries(q.where ?? {}).every(([k, v]) => r[k] === v))
        .map((r) => (q.select ? Object.fromEntries(q.select.map((c) => [c, r[c]])) : r)),
    update: async (table: string, id: string, patch: Row) => {
      updates.push({ table, id, patch });
      return { id, ...patch };
    },
  };
  return { ctx: { db } as unknown as HandlerContext, updates, queries };
}

const h = (name: string) => (createCmsHandlers() as unknown as Record<string, Mutation>)[name]!;

describe("updateBlockType / updateContentType — code-defined rows", () => {
  test("a code-defined block type refuses the write and says where the definition lives", async () => {
    const { ctx, updates } = stubCtx([{ id: "b1", slug: "hero", managedBy: "cms", fieldsSchema: [] }]);
    await expect(h("updateBlockType").run(ctx, { id: "b1", name: "Hero (edited)" })).rejects.toThrow(/defineBlockType/);
    expect(updates).toHaveLength(0);
  });

  test("a code-defined content type refuses the write", async () => {
    const { ctx, updates } = stubCtx([{ id: "c1", slug: "article", managedBy: "cms", regions: [] }]);
    await expect(h("updateContentType").run(ctx, { id: "c1", name: "Article (edited)" })).rejects.toThrow(/defineContentType/);
    expect(updates).toHaveLength(0);
  });

  test("the refusal names the owning reconciler", async () => {
    const { ctx } = stubCtx([{ id: "b1", slug: "hero", managedBy: "my-plugin", fieldsSchema: [] }]);
    await expect(h("updateBlockType").run(ctx, { id: "b1", name: "x" })).rejects.toThrow(/my-plugin/);
  });

  // The guard gates ONLY code-defined rows. An editor-authored type is the ordinary case and
  // has to keep working exactly as it did — this is the regression that would make the fix
  // worse than the bug.
  test("an editor-authored type still saves", async () => {
    const { ctx, updates } = stubCtx([{ id: "b2", slug: "quote", managedBy: null, fieldsSchema: [] }]);
    await h("updateBlockType").run(ctx, { id: "b2", name: "Quote" });
    expect(updates).toEqual([{ table: "cms_block_types", id: "b2", patch: { name: "Quote" } }]);
  });

  // The guard reads `managedBy` off a COLUMN-PROJECTED read. Written as "absent means
  // editable" it disarmed itself for any deployment with a `fields`-restricted read policy —
  // the save then landed and was reverted at the next cold start, i.e. #48 reproduced in the
  // deployment that installed the fix. The handler asks for the column explicitly (an
  // unreadable one is a 403 before this runs); if it ever stops asking, this fails loudly
  // rather than silently opening.
  test("the guard fails CLOSED when the column was not selected", () => {
    expect(() => assertNotManaged({ id: "b1", slug: "hero" }, "block type", "defineBlockType")).toThrow(/fail open/);
  });

  test("the lookup selects the column the guard needs", async () => {
    const { ctx, queries } = stubCtx([{ id: "b1", slug: "hero", managedBy: null, fieldsSchema: [] }]);
    await h("updateBlockType").run(ctx, { id: "b1", name: "x" });
    expect(queries[0]!.select).toContain("managedBy");
  });
});
