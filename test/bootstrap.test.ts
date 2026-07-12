// app.bootstrap / @pramen/cms code-defined types. `cmsBootstrap` upserts block + content
// types by slug into a freshly-migrated store — insert when missing, update on drift, no-op
// when identical. This is what lets a repo declare its content types in code and have a
// fresh / reprovisioned database converge to them on boot (no manual createContentType).
//
// Runs the reconciler directly over a bun:sqlite Driver (the same seam the DO/Worker boot
// uses) with a SYSTEM-scoped Db. The wiring that calls app.bootstrap after migrate on boot is
// covered end-to-end by the cms e2e suite (test/suites/cms.ts, seeded via example/app.ts).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema } from "../packages/server/src/sdk/schema";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";
import { cmsSchema, cmsBootstrap, defineBlockType, defineContentType } from "../packages/cms/src/index";
import type { Driver } from "../packages/server/src/runtime/driver";

const schema = defineSchema({ ...cmsSchema });

// A SYSTEM-scoped Db (ACL bypassed) — the same context the boot paths build for bootstrap.
function sysDb(driver: Driver): any {
  return new Db(driver, { acl: compileAcl([]), identity: { roles: ["admin"] }, system: true, schema }, schema);
}
function ctx(driver: Driver): any {
  return { db: sysDb(driver), driver, schema, partition: "default" };
}
async function freshStore(): Promise<Driver> {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  return driver;
}

const richText = defineBlockType("rich_text", [{ name: "body", type: "richtext" }] as const, { name: "Text" });
const image = defineBlockType("image", [{ name: "image", type: "media" }, { name: "caption", type: "text" }] as const, { name: "Image" });
const article = defineContentType("article", {
  name: "Article",
  fields: [{ name: "perex", type: "textarea" }, { name: "date", type: "date" }],
  regions: [{ name: "content", allowedTypes: ["rich_text", "image"] }],
});

describe("cmsBootstrap — code-defined content/block type reconcile", () => {
  test("inserts missing block + content types on a fresh store", async () => {
    const driver = await freshStore();
    await cmsBootstrap({ blockTypes: [richText, image], contentTypes: [article] })(ctx(driver));

    const db = sysDb(driver);
    const bts = (await db.find({ from: "cms_block_types" })) as any[];
    expect(bts.map((b) => b.slug).sort()).toEqual(["image", "rich_text"]);
    const rich = bts.find((b) => b.slug === "rich_text");
    expect(rich.name).toBe("Text");
    expect(rich.fieldsSchema).toEqual([{ name: "body", type: "richtext" }]);

    const cts = (await db.find({ from: "cms_content_types" })) as any[];
    expect(cts.length).toBe(1);
    expect(cts[0].slug).toBe("article");
    expect(cts[0].regions).toEqual([{ name: "content", allowedTypes: ["rich_text", "image"] }]);
    expect(cts[0].fieldsSchema).toEqual([{ name: "perex", type: "textarea" }, { name: "date", type: "date" }]);
  });

  test("is idempotent — re-running does not duplicate", async () => {
    const driver = await freshStore();
    const boot = cmsBootstrap({ blockTypes: [richText, image], contentTypes: [article] });
    await boot(ctx(driver));
    await boot(ctx(driver));
    await boot(ctx(driver));

    const db = sysDb(driver);
    expect(((await db.find({ from: "cms_block_types" })) as any[]).length).toBe(2);
    expect(((await db.find({ from: "cms_content_types" })) as any[]).length).toBe(1);
  });

  test("updates a drifted definition in place — same row, no duplicate", async () => {
    const driver = await freshStore();
    await cmsBootstrap({ contentTypes: [article] })(ctx(driver));
    const before = ((await sysDb(driver).find({ from: "cms_content_types", where: { slug: "article" }, limit: 1 })) as any[])[0];

    const articleV2 = defineContentType("article", {
      name: "Article (v2)",
      fields: [{ name: "perex", type: "textarea" }, { name: "date", type: "date" }, { name: "tag", type: "text" }],
      regions: [{ name: "content", allowedTypes: ["rich_text", "image"] }],
    });
    await cmsBootstrap({ contentTypes: [articleV2] })(ctx(driver));

    const rows = (await sysDb(driver).find({ from: "cms_content_types" })) as any[];
    expect(rows.length).toBe(1); // updated in place, not a second row
    expect(rows[0].id).toBe(before.id); // same row (matched by slug)
    expect(rows[0].name).toBe("Article (v2)");
    expect((rows[0].fieldsSchema as any[]).map((f) => f.name)).toEqual(["perex", "date", "tag"]);
  });

  test("an unchanged definition is a no-op (no update churn)", async () => {
    const driver = await freshStore();
    await cmsBootstrap({ contentTypes: [article] })(ctx(driver));
    const first = ((await sysDb(driver).find({ from: "cms_content_types", where: { slug: "article" }, limit: 1 })) as any[])[0];
    await cmsBootstrap({ contentTypes: [article] })(ctx(driver)); // identical → should not rewrite
    const second = ((await sysDb(driver).find({ from: "cms_content_types", where: { slug: "article" }, limit: 1 })) as any[])[0];
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
  });
});
