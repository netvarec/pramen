import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema, role, type HandlerContext } from "@pramen/server";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { cmsSchema, cmsPolicies, createCmsHandlers } from "../packages/cms/src";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = defineSchema(cmsSchema);
const handlers = createCmsHandlers();
const stores: Database[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

async function setup(initialSchema = schema) {
  const store = new Database(":memory:");
  stores.push(store);
  const driver = bunSqliteDriver(store);
  await migrate(driver, initialSchema);
  const db = new Db(driver, { acl: compileAcl([]), identity: { roles: ["editor"] }, system: true, schema }, schema);
  const ctx = { db } as HandlerContext;
  return { db, ctx, driver };
}

describe("type deletion", () => {
  for (const kind of ["content", "block"] as const) {
    const table = kind === "content" ? "cms_content_types" : "cms_block_types";
    const handler = kind === "content" ? handlers.deleteContentType : handlers.deleteBlockType;

    test(`${kind}: unused types delete, missing types and malformed IDs fail`, async () => {
      const { db, ctx } = await setup();
      const row = await db.insert(table, { name: "Scratch", slug: "scratch" });
      expect(await handler.run(ctx, { id: row.id })).toEqual({ ok: true });
      expect(await db.find({ from: table })).toHaveLength(0);
      await expect(handler.run(ctx, { id: row.id })).rejects.toThrow(/not found/i);
      for (const id of [undefined, "", " ", 2]) expect(() => handler.input!({ id })).toThrow(/id is required/);
      expect(handler.auth).toEqual(["editor", "admin"]);
    });

    test(`${kind}: managed types refuse deletion`, async () => {
      const { db, ctx } = await setup();
      const row = await db.insert(table, { name: "Owned", slug: "owned", managedBy: "app" });
      await expect(handler.run(ctx, { id: row.id })).rejects.toThrow(/defined in code/);
      expect(await db.find({ from: table })).toHaveLength(1);
    });

    test(`${kind}: rows using the type prevent deletion at both handler and DB levels`, async () => {
      const { db, ctx } = await setup();
      const row = await db.insert(table, { name: "Used", slug: "used" });
      if (kind === "content") await db.insert("cms_pages", { typeId: row.id, title: "Page", slug: "page", deletedAt: new Date().toISOString() });
      else await db.insert("cms_blocks", { typeId: row.id, isReusable: true });
      await expect(handler.run(ctx, { id: row.id })).rejects.toThrow(/in use/);
      await expect(db.delete(table, row.id)).rejects.toThrow(/FOREIGN KEY/);
      expect(await db.find({ from: table })).toHaveLength(1);
    });
  }

  test("trash hidden by the editor ACL still prevents deletion", async () => {
    const { db, driver } = await setup();
    const row = await db.insert("cms_content_types", { name: "Used", slug: "used" });
    await db.insert("cms_pages", { typeId: row.id, title: "Trash", slug: "trash", deletedAt: new Date().toISOString() });
    const editorDb = new Db(driver, { acl: compileAcl([role("editor", cmsPolicies().editor)]), identity: { roles: ["editor"] }, schema }, schema);
    expect(await editorDb.find({ from: "cms_pages" })).toHaveLength(0);
    await expect(handlers.deleteContentType.run({ db: editorDb } as HandlerContext, { id: row.id })).rejects.toThrow(/including trash/);
  });

  test("block types referenced only by defaults or region rules cannot be deleted", async () => {
    const { db, ctx } = await setup();
    const block = await db.insert("cms_block_types", { name: "Hero", slug: "hero" });
    const content = await db.insert("cms_content_types", { name: "Page", slug: "page", defaultBlocks: [{ region: "body", blockTypeSlug: "hero" }] });
    await expect(handlers.deleteBlockType.run(ctx, { id: block.id })).rejects.toThrow(/default blocks/);
    await db.update("cms_content_types", content.id, { defaultBlocks: [], regions: [{ name: "body", allowedTypes: ["hero"] }] });
    await expect(handlers.deleteBlockType.run(ctx, { id: block.id })).rejects.toThrow(/allow-lists/);
    await db.update("cms_content_types", content.id, { regions: [] });
    expect(await handlers.deleteBlockType.run(ctx, { id: block.id })).toEqual({ ok: true });
  });

  // The scan reads EVERY content type, so one unreadable row used to decide the fate of every
  // block-type deletion in the deployment: `json_each` raises `malformed JSON` for the whole
  // statement, and the caller got a raw SQL 500 where the answer was "nothing references this".
  // `''` is the value that does it, and it is what a hand-written row or a D1 import leaves.
  test("a content type with an unreadable defaultBlocks or regions does not break the scan", async () => {
    const { db, driver, ctx } = await setup();
    const block = await db.insert("cms_block_types", { name: "Hero", slug: "hero" });
    const broken = await db.insert("cms_content_types", { name: "Legacy", slug: "legacy" });
    // Written past the ORM on purpose: the `t.json()` codec is what stops this shape arriving
    // through `insert`, and the point is a row that predates it.
    for (const bad of ["", "not json", '"body"']) {
      await driver.exec("UPDATE cms_content_types SET defaultBlocks = ?, regions = ? WHERE id = ?", [bad, bad, broken.id]);
      expect(await handlers.deleteBlockType.run(ctx, { id: block.id })).toEqual({ ok: true });
      await db.insert("cms_block_types", { id: block.id, name: "Hero", slug: "hero" });
    }
    // A readable row beside the broken one is still honoured, so the tolerance did not turn
    // the check off.
    const used = await db.insert("cms_content_types", { name: "Page", slug: "page", regions: [{ name: "body", allowedTypes: ["hero"] }] });
    expect(used.id).toBeTruthy();
    await expect(handlers.deleteBlockType.run(ctx, { id: block.id })).rejects.toThrow(/allow-lists/);
  });

  test("the final delete enforces the caller's delete ACL", async () => {
    const { db, driver } = await setup();
    const row = await db.insert("cms_content_types", { name: "Keep", slug: "keep" });
    const policies = cmsPolicies().editor.filter((p) => !p.name.endsWith(":delete"));
    const restricted = new Db(driver, { acl: compileAcl([role("editor", policies)]), identity: { roles: ["editor"] }, schema }, schema);
    await expect(handlers.deleteContentType.run({ db: restricted } as HandlerContext, { id: row.id })).rejects.toThrow(/access denied/);
    expect(await db.find({ from: "cms_content_types" })).toHaveLength(1);
  });

  test("upgrading logical type relations preserves authored content and adds restrictions", async () => {
    const legacy = defineSchema({
      ...cmsSchema,
      cms_pages: { ...cmsSchema.cms_pages, relations: { ...cmsSchema.cms_pages.relations, type: { ...cmsSchema.cms_pages.relations.type, onDelete: undefined } } },
      cms_blocks: { ...cmsSchema.cms_blocks, relations: { ...cmsSchema.cms_blocks.relations, type: { ...cmsSchema.cms_blocks.relations.type, onDelete: undefined } } },
    });
    const { db, driver } = await setup(legacy);
    const ct = await db.insert("cms_content_types", { name: "Page", slug: "page" });
    const bt = await db.insert("cms_block_types", { name: "Hero", slug: "hero" });
    const page = await db.insert("cms_pages", { typeId: ct.id, title: "Keep", slug: "keep" });
    const block = await db.insert("cms_blocks", { typeId: bt.id, fields: { title: "Authored" } });
    const placement = await db.insert("cms_page_blocks", { pageId: page.id, blockId: block.id, region: "body", position: 0 });
    await migrate(driver, schema);
    expect((await db.find({ from: "cms_pages" }))[0].id).toBe(page.id);
    expect((await db.find({ from: "cms_blocks" }))[0].fields).toEqual({ title: "Authored" });
    expect((await db.find({ from: "cms_page_blocks" }))[0].id).toBe(placement.id);
    await expect(db.delete("cms_content_types", ct.id)).rejects.toThrow(/FOREIGN KEY/);
    await expect(db.delete("cms_block_types", bt.id)).rejects.toThrow(/FOREIGN KEY/);
  });
});
