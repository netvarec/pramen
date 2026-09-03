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
import { createCmsHandlers } from "../packages/cms/src/index";
import type { HandlerContext } from "@pramen/server";

type Row = Record<string, unknown>;
type Query = { from: string; where?: Record<string, unknown>; limit?: number };
type Mutation = { run: (c: HandlerContext, i: Row) => Promise<unknown> };

function stubCtx(rows: Row[]) {
  const updates: { table: string; id: string; patch: Row }[] = [];
  const db = {
    find: async (q: Query) =>
      rows.filter((r) => Object.entries(q.where ?? {}).every(([k, v]) => r[k] === v)),
    update: async (table: string, id: string, patch: Row) => {
      updates.push({ table, id, patch });
      return { id, ...patch };
    },
  };
  return { ctx: { db } as unknown as HandlerContext, updates };
}

const h = (name: string) => (createCmsHandlers() as unknown as Record<string, Mutation>)[name]!;

describe("updateBlockType / updateContentType — code-defined rows", () => {
  test("a managed block type refuses the write and says where the definition lives", async () => {
    const { ctx, updates } = stubCtx([{ id: "b1", slug: "hero", managed: true, fieldsSchema: [] }]);
    await expect(h("updateBlockType").run(ctx, { id: "b1", name: "Hero (edited)" })).rejects.toThrow(/defineBlockType/);
    expect(updates).toHaveLength(0);
  });

  test("a managed content type refuses the write", async () => {
    const { ctx, updates } = stubCtx([{ id: "c1", slug: "article", managed: true, regions: [] }]);
    await expect(h("updateContentType").run(ctx, { id: "c1", name: "Article (edited)" })).rejects.toThrow(/defineContentType/);
    expect(updates).toHaveLength(0);
  });

  // The flag gates ONLY code-defined rows. An editor-authored type is the ordinary case and
  // has to keep working exactly as it did — this is the regression that would make the fix
  // worse than the bug.
  test("an editor-authored type still saves", async () => {
    const { ctx, updates } = stubCtx([{ id: "b2", slug: "quote", managed: false, fieldsSchema: [] }]);
    await h("updateBlockType").run(ctx, { id: "b2", name: "Quote" });
    expect(updates).toEqual([{ table: "cms_block_types", id: "b2", patch: { name: "Quote" } }]);
  });

  // A store migrated before the column existed reads it as NULL, not false.
  test("a row with no `managed` value at all is treated as editable", async () => {
    const { ctx, updates } = stubCtx([{ id: "b3", slug: "legacy", fieldsSchema: [] }]);
    await h("updateBlockType").run(ctx, { id: "b3", name: "Legacy" });
    expect(updates).toHaveLength(1);
  });
});
