// Security regressions for the @pramen/cms handlers: media registration and purge, the
// published-only public reads, the review gate on scheduling and approval, and a scheduled
// takedown surviving trash + restore. Real handlers, real ACL, real Db over bun:sqlite, and
// the handler gate applied exactly as runtime/dispatch.ts applies it.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema } from "../packages/server/src/sdk/schema";
import { role } from "../packages/server/src/sdk/acl";
import { authorizeHandler } from "../packages/server/src/sdk/handlers";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { createFiles, handleFileRequest, MemoryAdapter } from "../packages/server/src/runtime/storage";
import { bunSqliteDriver } from "./sqlite-driver";
import { cmsSchema, cmsPolicies, createCmsHandlers, cmsTasks } from "../packages/cms/src/index";

type H = { run: (c: unknown, i: unknown) => Promise<any>; auth?: unknown; input?: (raw: unknown) => unknown };
const SECRET = "secfix-dummy-secret-0123456789";
const BASE = "https://dummy.test";
const EDITOR = { userId: "ed", roles: ["editor"] };
const REVIEWER = { userId: "rev", roles: ["reviewer"] };

class FailingDeleteAdapter extends MemoryAdapter {
  failDeletes = false;
  override async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error("dummy storage outage");
    return super.delete(key);
  }
}

async function setup() {
  const schema = defineSchema({ ...cmsSchema });
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const pol = cmsPolicies();
  // `editor` reads drafts (cmsPolicies().editor), which is what a site's deployer token with
  // an editor role reads as.
  const acl = compileAcl([role("anonymous", pol.public), role("editor", pol.editor), role("reviewer", pol.editor)]);
  const adapter = new FailingDeleteAdapter();
  const files = createFiles({ tenant: "main", secret: SECRET, adapter });
  const enqueued: { kind: string; payload: any; delayMs?: number }[] = [];
  const mk = (identity: any, system = false) => ({
    db: new Db(driver, { acl, identity, schema, system } as never, schema),
    env: {},
    identity,
    tenant: "main",
    files,
    tasks: { enqueue: async (t: any) => void enqueued.push(t) },
  });
  const handlers = createCmsHandlers() as unknown as Record<string, H>;
  const call = async (name: string, ctx: any, raw: unknown) => {
    const h = handlers[name]!;
    if (h.auth !== undefined && !authorizeHandler(h.auth as never, ctx.identity)) throw new Error("forbidden");
    return h.run(ctx, h.input ? h.input(raw) : raw);
  };
  return { mk, call, enqueued, adapter, files, driver };
}

async function basePage(call: any, ed: any, slug: string, body: string) {
  await call("createBlockType", ed, { name: "Text", slug: "text", fieldsSchema: [{ name: "body", type: "text" }] }).catch(() => {});
  const types = await ed.db.find({ from: "cms_content_types", where: { slug: "page" }, limit: 1 });
  const ct = types[0] ?? (await call("createContentType", ed, { name: "Page", slug: "page", regions: [{ name: "main" }] }));
  const page = await call("createPage", ed, { typeId: ct.id, title: "T", slug });
  const { block } = await call("addBlock", ed, { pageId: page.id, blockTypeSlug: "text", region: "main", fields: { body } });
  return { page, block };
}

const upload = async (files: any, adapter: any, opts: { prefix?: string }) => {
  const signed = await files.signUpload({ contentType: "image/png", filename: "x.png", maxSize: 100, ...opts });
  const bytes = "DUMMY-BYTES";
  const put = await handleFileRequest(
    new Request(BASE + signed.url, { method: "PUT", body: bytes, headers: { "content-length": String(bytes.length) } }),
    { adapter, secret: SECRET },
  );
  expect(put!.status).toBe(200);
  return signed.ref;
};

describe("createMedia registers only a media upload, once", () => {
  test("an app-private key in the same tenant is refused", async () => {
    const { mk, call, files, adapter } = await setup();
    const ref = await upload(files, adapter, {}); // `<tenant>/<rand>`: what an app's signUpload mints
    await expect(call("createMedia", mk(EDITOR), { ref })).rejects.toThrow(/not a media upload/);
  });

  test("a media upload registers, and registering the same blob twice is refused", async () => {
    const { mk, call, files, adapter } = await setup();
    const ref = await upload(files, adapter, { prefix: "media" });
    const row = await call("createMedia", mk(EDITOR), { ref });
    expect(row.id).toBeTruthy();
    await expect(call("createMedia", mk(EDITOR), { ref })).rejects.toThrow(/already in the media library/);
  });
});

describe("purgeMedia never reports a takedown that did not happen", () => {
  test("a failed object delete fails the purge and keeps the row in the trash", async () => {
    const { mk, call, files, adapter } = await setup();
    const ref = await upload(files, adapter, { prefix: "media" });
    const media = await call("createMedia", mk(EDITOR), { ref });
    await call("deleteMedia", mk(EDITOR), { id: media.id });
    adapter.failDeletes = true;
    await expect(call("purgeMedia", mk(REVIEWER), { id: media.id })).rejects.toThrow(/dummy storage outage/);
    const trash = await call("listTrash", mk(REVIEWER), {});
    expect(trash.media.map((m: any) => m.id)).toContain(media.id);
    // The retry, once storage is back, finishes the job.
    adapter.failDeletes = false;
    await call("purgeMedia", mk(REVIEWER), { id: media.id });
    expect(await adapter.head(ref.key)).toBeNull();
  });
});

describe("public reads are published-only whoever calls them", () => {
  test("getPage without preview 404s a draft, even for a caller whose scope reads drafts", async () => {
    const { mk, call } = await setup();
    const ed = mk(EDITOR);
    await basePage(call, ed, "draft-x", "DUMMY-DRAFT");
    await expect(call("getPage", ed, { slug: "draft-x" })).rejects.toThrow(/not found/);
    // Preview stays the way to see a draft.
    const preview = await call("getPage", ed, { slug: "draft-x", preview: true });
    expect(preview.regions.main[0].fields.body).toBe("DUMMY-DRAFT");
  });

  test("an unpublished page's old snapshot is not served", async () => {
    const { mk, call } = await setup();
    const ed = mk(EDITOR);
    const { page } = await basePage(call, ed, "recalled-x", "DUMMY-RECALLED");
    await call("publishPage", mk(REVIEWER), { pageId: page.id });
    expect((await call("getPage", mk(null), { slug: "recalled-x" })).page.status).toBe("published");
    await call("unpublishPage", ed, { pageId: page.id });
    await expect(call("getPage", ed, { slug: "recalled-x" })).rejects.toThrow(/not found/);
  });

  test("listPagesByTerm lists published pages only", async () => {
    const { mk, call, driver } = await setup();
    const ed = mk(EDITOR);
    const { page: draft } = await basePage(call, ed, "draft-t", "x");
    const { page: live } = await basePage(call, ed, "live-t", "y");
    await call("publishPage", mk(REVIEWER), { pageId: live.id });
    const tax = "11111111-1111-4111-8111-111111111111";
    const term = "22222222-2222-4222-8222-222222222222";
    await driver.exec("INSERT INTO cms_taxonomies (id, slug, label) VALUES (?, 'topic', 'Topic')", [tax]);
    await driver.exec("INSERT INTO cms_terms (id, taxonomyId, slug, label) VALUES (?, ?, 'news', 'News')", [term, tax]);
    for (const [i, p] of [draft, live].entries()) {
      await driver.exec("INSERT INTO cms_page_terms (id, pageId, termId) VALUES (?, ?, ?)", [`3333333${i}-3333-4333-8333-333333333333`, p.id, term]);
    }
    const listed = await call("listPagesByTerm", ed, { taxonomy: "topic", term: "news" });
    expect(listed.map((p: any) => p.slug)).toEqual(["live-t"]);
  });
});

describe("a scheduled publish publishes what the reviewer scheduled", () => {
  test("an editor's write after scheduling does not go live with the schedule", async () => {
    const { mk, call, enqueued } = await setup();
    const ed = mk(EDITOR), sys = mk(null, true);
    const { page, block } = await basePage(call, ed, "promo", "COPY-REVIEWER-SAW");
    await call("schedulePage", mk(REVIEWER), { pageId: page.id, publishAt: Date.now() + 5000 });
    await call("updateBlock", ed, { blockId: block.id, fields: { body: "COPY-NO-REVIEWER-SAW" } });
    await cmsTasks["cms:publish"](sys as never, enqueued.find((t) => t.kind === "cms:publish")!.payload);
    const pub = await call("getPage", mk(null), { slug: "promo" });
    expect(pub.regions.main[0].fields.body).toBe("COPY-REVIEWER-SAW");
  });

  test("a stale expectedContentHash refuses the schedule", async () => {
    const { mk, call } = await setup();
    const ed = mk(EDITOR);
    const { page } = await basePage(call, ed, "promo2", "x");
    await expect(call("schedulePage", mk(REVIEWER), { pageId: page.id, publishAt: Date.now() + 5000, expectedContentHash: "0".repeat(64) })).rejects.toThrow(/changed since you reviewed/);
  });

  test("a scheduled publish of a trashed page publishes nothing", async () => {
    const { mk, call, enqueued } = await setup();
    const ed = mk(EDITOR), sys = mk(null, true);
    const { page } = await basePage(call, ed, "trashed-sched", "x");
    await call("schedulePage", mk(REVIEWER), { pageId: page.id, publishAt: Date.now() });
    await call("deletePage", ed, { pageId: page.id });
    await cmsTasks["cms:publish"](sys as never, enqueued.find((t) => t.kind === "cms:publish")!.payload);
    const row = (await sys.db.find({ from: "cms_pages", where: { id: page.id }, limit: 1 }))[0] as any;
    expect(row.status).not.toBe("published");
  });
});

describe("approve is bound to the content the reviewer saw", () => {
  test("an edit made while the page sat in review is refused at approval", async () => {
    const { mk, call } = await setup();
    const ed = mk(EDITOR), rev = mk(REVIEWER);
    const { page, block } = await basePage(call, ed, "rv", "IN-REVIEW-V1");
    await call("submitForReview", ed, { pageId: page.id });
    const seen = await call("getPage", rev, { slug: "rv", preview: true });
    expect(typeof seen.contentHash).toBe("string");
    await call("updateBlock", ed, { blockId: block.id, fields: { body: "IN-REVIEW-V2" } });
    await expect(call("approve", rev, { pageId: page.id, expectedContentHash: seen.contentHash })).rejects.toThrow(/changed since you reviewed/);
    await expect(call("approve", rev, { pageId: page.id })).rejects.toThrow(/expectedContentHash is required/);
    const now = await call("getPage", rev, { slug: "rv", preview: true });
    const ok = await call("approve", rev, { pageId: page.id, expectedContentHash: now.contentHash });
    expect(ok.page.status).toBe("published");
    expect((await call("getPage", mk(null), { slug: "rv" })).regions.main[0].fields.body).toBe("IN-REVIEW-V2");
  });
});

describe("a scheduled takedown survives trash and restore", () => {
  test("restore keeps the takedown, and it still archives the page", async () => {
    const { mk, call, enqueued } = await setup();
    const ed = mk(EDITOR), rev = mk(REVIEWER), sys = mk(null, true);
    const { page } = await basePage(call, ed, "sale", "X");
    await call("publishPage", rev, { pageId: page.id });
    const now = Date.now();
    await call("schedulePage", rev, { pageId: page.id, publishAt: now, unpublishAt: now + 1000 });
    await cmsTasks["cms:publish"](sys as never, enqueued.find((t) => t.kind === "cms:publish")!.payload);
    await call("deletePage", ed, { pageId: page.id });
    const restored = await call("restorePage", ed, { pageId: page.id });
    expect(restored.scheduleCleared).toBe(false);
    await cmsTasks["cms:unpublish"](sys as never, enqueued.find((t) => t.kind === "cms:unpublish")!.payload);
    await expect(call("getPage", mk(null), { slug: "sale" })).rejects.toThrow(/not found/);
  });

  test("a takedown that fires while the page is trashed still archives it", async () => {
    const { mk, call, enqueued } = await setup();
    const ed = mk(EDITOR), rev = mk(REVIEWER), sys = mk(null, true);
    const { page } = await basePage(call, ed, "sale2", "X");
    await call("publishPage", rev, { pageId: page.id });
    await call("schedulePage", rev, { pageId: page.id, publishAt: Date.now() + 10_000, unpublishAt: Date.now() + 20_000 });
    await call("deletePage", ed, { pageId: page.id });
    await cmsTasks["cms:unpublish"](sys as never, enqueued.find((t) => t.kind === "cms:unpublish")!.payload);
    await call("restorePage", ed, { pageId: page.id });
    await expect(call("getPage", mk(null), { slug: "sale2" })).rejects.toThrow(/not found/);
  });

  test("a publish that came due while trashed is dropped on restore, and SAID so", async () => {
    const { mk, call } = await setup();
    const ed = mk(EDITOR);
    const { page } = await basePage(call, ed, "missed", "X");
    await call("schedulePage", mk(REVIEWER), { pageId: page.id, publishAt: Date.now() - 1000 });
    await call("deletePage", ed, { pageId: page.id });
    const restored = await call("restorePage", ed, { pageId: page.id });
    expect(restored.scheduleCleared).toBe(true);
  });
});
