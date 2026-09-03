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

// GitHub #48 — bootstrap converges these rows on every boot, and the editor authors the same
// rows. Without a marker the two are indistinguishable, so an editor's save returned 200 and
// was reverted at the next cold start. `managedBy` is what makes them different things — an
// OWNER id rather than a flag, so two reconcilers in one `app.bootstrap` compose.
describe("cmsBootstrap — code-defined types carry an owner", () => {
  test("declared types are stamped with the owner; a hand-created one is not", async () => {
    const driver = await freshStore();
    const db = sysDb(driver);
    await db.insert("cms_block_types", { name: "Hand made", slug: "hand_made", fieldsSchema: [] });
    await cmsBootstrap({ blockTypes: [richText], contentTypes: [article] })(ctx(driver));

    const bts = (await db.find({ from: "cms_block_types" })) as any[];
    expect(bts.find((b) => b.slug === "rich_text").managedBy).toBe("cms");
    expect(bts.find((b) => b.slug === "hand_made").managedBy).toBe(null);
    expect(((await db.find({ from: "cms_content_types" })) as any[])[0].managedBy).toBe("cms");
  });

  test("a type dropped from the declaration is RELEASED back to the editor", async () => {
    const driver = await freshStore();
    const db = sysDb(driver);
    await cmsBootstrap({ blockTypes: [richText, image] })(ctx(driver));
    // `image` leaves the repo. Its row stays (blocks are built out of it) but nothing
    // converges it any more, so a read-only builder would be a lock with nothing behind it.
    await cmsBootstrap({ blockTypes: [richText] })(ctx(driver));

    const bts = (await db.find({ from: "cms_block_types" })) as any[];
    expect(bts.length).toBe(2);
    expect(bts.find((b) => b.slug === "rich_text").managedBy).toBe("cms");
    expect(bts.find((b) => b.slug === "image").managedBy).toBe(null);
  });

  test("an ABSENT key says nothing about that table; an EMPTY array declares none and sweeps", async () => {
    const driver = await freshStore();
    const db = sysDb(driver);
    const owned = async () => ((await db.find({ from: "cms_block_types", where: { slug: "rich_text" }, limit: 1 })) as any[])[0].managedBy;

    await cmsBootstrap({ blockTypes: [richText], contentTypes: [article] })(ctx(driver));
    await cmsBootstrap({ contentTypes: [article] })(ctx(driver)); // no `blockTypes` key at all
    expect(await owned()).toBe("cms");

    // `blockTypes: []` is a DECLARATION of none — which is also the in-band way to hand every
    // code-defined type back to the editor when the reconciler itself is being removed.
    await cmsBootstrap({ blockTypes: [], contentTypes: [article] })(ctx(driver));
    expect(await owned()).toBe(null);
  });

  // The reason for an owner id rather than a boolean: `app.bootstrap` is an ARRAY, and with a
  // flag the sweep could not tell "not mine" from "no longer declared", so two calls released
  // each other's rows on every boot and half the types silently fell back to editable.
  test("two reconcilers in one app.bootstrap do not release each other's rows", async () => {
    const driver = await freshStore();
    const db = sysDb(driver);
    const a = cmsBootstrap({ blockTypes: [richText] }, { owner: "app" });
    const b = cmsBootstrap({ blockTypes: [image] }, { owner: "plugin" });
    for (let boot = 0; boot < 2; boot++) { await a(ctx(driver)); await b(ctx(driver)); }

    const bts = (await db.find({ from: "cms_block_types" })) as any[];
    expect(bts.find((x) => x.slug === "rich_text").managedBy).toBe("app");
    expect(bts.find((x) => x.slug === "image").managedBy).toBe("plugin");
  });

  // The mirror image of #48: the reconciler silently overwrote an editor-authored row of the
  // same slug — name and schema replaced, then LOCKED, so the editor could not put back what
  // it had just lost. `createBlockType` refuses this collision at the RPC edge.
  test("an editor-authored row of the same slug is left alone, not adopted", async () => {
    const driver = await freshStore();
    const db = sysDb(driver);
    await db.insert("cms_block_types", { name: "Editor made", slug: "rich_text", fieldsSchema: [{ name: "custom", type: "text" }] });
    await cmsBootstrap({ blockTypes: [richText] })(ctx(driver));

    const row = ((await db.find({ from: "cms_block_types", where: { slug: "rich_text" }, limit: 1 })) as any[])[0];
    expect(row.name).toBe("Editor made");
    expect(row.fieldsSchema).toEqual([{ name: "custom", type: "text" }]);
    expect(row.managedBy).toBe(null);
  });

  // One bad definition must not skip every later type AND both sweeps: the boot runner only
  // LOGS a throwing reconciler, so an aborted pass leaves the store half-converged for that
  // isolate's whole lifetime with nothing to retry it.
  test("a failing row does not abort the rest of the reconcile", async () => {
    const driver = await freshStore();
    const db = sysDb(driver);
    // `rich_text` is editor-owned, so its reconcile is refused; `image` must still land.
    await db.insert("cms_block_types", { name: "Editor made", slug: "rich_text", fieldsSchema: [] });
    await cmsBootstrap({ blockTypes: [richText, image], contentTypes: [article] })(ctx(driver));

    expect(((await db.find({ from: "cms_block_types", where: { slug: "image" }, limit: 1 })) as any[])[0].managedBy).toBe("cms");
    expect(((await db.find({ from: "cms_content_types" })) as any[]).length).toBe(1);
  });
});

// The editor validates an authored field schema (`normalizeFieldSchema`). A code-declared type
// went straight into the store unchecked, so a bad one could store a schema the builder would
// then REFUSE to save — the only surface reporting the problem being the one that cannot fix
// it, and the row is then locked, so it cannot be repaired through the product at all.
//
// The check lives on `cmsBootstrap`, not on `defineBlockType`: those helpers are OPTIONAL, and
// `BlockTypeDef` is a structural interface, so an object literal or a `.map` reaches the store
// without going near them. Guarding the helper guards the convenient path and leaves the sink.
describe("cmsBootstrap — validates the definitions it will write", () => {
  test("a select with no options is refused", () => {
    expect(() => cmsBootstrap({ blockTypes: [defineBlockType("card", [{ name: "variant", type: "select" }] as const)] }))
      .toThrow(/needs either `options` or an `optionsFrom` handler/);
  });

  test("a duplicate field name is refused", () => {
    expect(() => cmsBootstrap({ blockTypes: [defineBlockType("dup", [{ name: "a", type: "text" }, { name: "a", type: "text" }] as const)] }))
      .toThrow(/declares 'a' twice/);
  });

  test("a default block naming an undeclared region is refused", () => {
    expect(() => cmsBootstrap({ contentTypes: [defineContentType("post", {
      regions: [{ name: "content" }],
      defaultBlocks: [{ region: "sidebar", blockTypeSlug: "rich_text" }],
    })] })).toThrow(/targets region 'sidebar'/);
  });

  test("a bad slug is refused, and is checked BEFORE the regions", () => {
    // Ordering matters: validating regions first produced an error that never mentioned the
    // slug, so you fixed the regions, redeployed, and met a second boot failure.
    expect(() => cmsBootstrap({ contentTypes: [defineContentType("Bad Slug", { regions: [] })] }))
      .toThrow(/content type slug must be a key/);
  });

  // A plain object literal — no helper anywhere. This is the path the check exists for.
  test("an object literal that never touched define* is validated too", () => {
    expect(() => cmsBootstrap({ blockTypes: [{ slug: "Bad Slug", name: "x", fieldsSchema: [] }] }))
      .toThrow(/block type slug must be a key/);
  });

  test("a slug declared twice in one call is refused, not silently last-wins", () => {
    expect(() => cmsBootstrap({ blockTypes: [
      defineBlockType("cta", [{ name: "a", type: "text" }] as const, { name: "CTA (marketing)" }),
      defineBlockType("cta", [{ name: "b", type: "text" }] as const, { name: "CTA (product)" }),
    ] })).toThrow(/declared twice/);
  });

  test("every problem is reported at once, not one deploy at a time", () => {
    let msg = "";
    try {
      cmsBootstrap({
        blockTypes: [defineBlockType("card", [{ name: "v", type: "select" }] as const), { slug: "Bad Slug", name: "x", fieldsSchema: [] }],
        contentTypes: [defineContentType("post", { regions: [] })],
      });
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/3 invalid type definition\(s\)/);
    expect(msg).toContain("card");
    expect(msg).toContain("Bad Slug");
    expect(msg).toContain("post");
  });

  test("what it writes is CANONICALIZED — the row matches what the editor would have saved", async () => {
    const driver = await freshStore();
    await cmsBootstrap({ contentTypes: [defineContentType("post", { regions: [{ name: "content" }] })] })(ctx(driver));
    const row = ((await sysDb(driver).find({ from: "cms_content_types", where: { slug: "post" }, limit: 1 })) as any[])[0];
    // `allowedTypes` omitted means "any" — stored as an explicit null, exactly as
    // `createContentType` would have written it, so it does not read as drift.
    expect(row.regions).toEqual([{ name: "content", allowedTypes: null }]);
    expect(row.fieldsSchema).toEqual([]);
    expect(row.defaultBlocks).toEqual([]);
  });

  // Canonicalization happens at the SINK, so the helper stays a pure constructor and
  // `BlockFieldsOf<typeof def>` still describes the array it returned.
  test("defineBlockType returns its input untouched", () => {
    const fields = [{ name: "  body  ", type: "text" }] as const;
    expect(defineBlockType("x", fields).fieldsSchema).toBe(fields);
  });
});
