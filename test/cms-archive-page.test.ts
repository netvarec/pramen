// `archivePage`: archiving a page by hand, from the editor's page menu. Off the site like
// `unpublishPage`, filed as `archived` like a scheduled takedown, pending schedules cancelled,
// and reversible by publishing again. Same harness as secfix-cms-handlers.test.ts: real
// handlers, real ACL, real Db over bun:sqlite, the handler gate applied as dispatch applies it.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema } from "../packages/server/src/sdk/schema";
import { role } from "../packages/server/src/sdk/acl";
import { authorizeHandler } from "../packages/server/src/sdk/handlers";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";
import { cmsSchema, cmsPolicies, createCmsHandlers, cmsTasks } from "../packages/cms/src/index";

type H = { run: (c: unknown, i: unknown) => Promise<any>; auth?: unknown; input?: (raw: unknown) => unknown };
const EDITOR = { userId: "ed", roles: ["editor"] };
const REVIEWER = { userId: "rev", roles: ["reviewer"] };

async function setup() {
  const schema = defineSchema({ ...cmsSchema });
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const pol = cmsPolicies();
  const acl = compileAcl([role("anonymous", pol.public), role("editor", pol.editor), role("reviewer", pol.editor)]);
  const enqueued: { kind: string; payload: any }[] = [];
  const mk = (identity: any, system = false) => ({
    db: new Db(driver, { acl, identity, schema, system } as never, schema),
    env: {},
    identity,
    tenant: "main",
    tasks: { enqueue: async (t: any) => void enqueued.push(t) },
  });
  const handlers = createCmsHandlers() as unknown as Record<string, H>;
  const call = async (name: string, ctx: any, raw: unknown) => {
    const h = handlers[name]!;
    if (h.auth !== undefined && !authorizeHandler(h.auth as never, ctx.identity)) throw new Error("forbidden");
    return h.run(ctx, h.input ? h.input(raw) : raw);
  };
  const ed = mk(EDITOR);
  await call("createBlockType", ed, { name: "Text", slug: "text", fieldsSchema: [{ name: "body", type: "text" }] });
  const ct = await call("createContentType", ed, { name: "Page", slug: "page", regions: [{ name: "main" }] });
  const page = await call("createPage", ed, { typeId: ct.id, title: "Loňská akce", slug: "lonska" });
  await call("addBlock", ed, { pageId: page.id, blockTypeSlug: "text", region: "main", fields: { body: "x" } });
  return { mk, call, enqueued, page, ed };
}

describe("archivePage", () => {
  test("a live page goes off the site, filed as archived, with an audit row", async () => {
    const { mk, call, page, ed } = await setup();
    await call("publishPage", mk(REVIEWER), { pageId: page.id });
    expect((await call("getPage", mk(null), { slug: "lonska" })).page.title).toBe("Loňská akce");
    const r = await call("archivePage", ed, { pageId: page.id });
    expect(r.page.status).toBe("archived");
    await expect(call("getPage", mk(null), { slug: "lonska" })).rejects.toThrow(/not found/);
    const audit = (await mk(null, true).db.find({ from: "cms_audit", where: { pageId: page.id } })) as any[];
    expect(audit.at(-1)).toMatchObject({ action: "archive", fromStatus: "published", toStatus: "archived", actor: "ed" });
  });

  test("it cancels a pending scheduled publish", async () => {
    const { mk, call, enqueued, page, ed } = await setup();
    await call("schedulePage", mk(REVIEWER), { pageId: page.id, publishAt: Date.now() });
    await call("archivePage", ed, { pageId: page.id });
    await cmsTasks["cms:publish"](mk(null, true) as never, enqueued.find((t) => t.kind === "cms:publish")!.payload);
    await expect(call("getPage", mk(null), { slug: "lonska" })).rejects.toThrow(/not found/);
  });

  test("publishing brings an archived page back", async () => {
    const { mk, call, page, ed } = await setup();
    await call("archivePage", ed, { pageId: page.id });
    await call("publishPage", mk(REVIEWER), { pageId: page.id });
    expect((await call("getPage", mk(null), { slug: "lonska" })).page.status).toBe("published");
  });

  test("an editor may archive, an anonymous caller may not; an unknown page is 404", async () => {
    const { mk, call, page, ed } = await setup();
    await expect(call("archivePage", mk(null), { pageId: page.id })).rejects.toThrow(/forbidden/);
    await expect(call("archivePage", ed, { pageId: "missing" })).rejects.toThrow(/not found/);
    await expect(call("archivePage", ed, {})).rejects.toThrow(/pageId is required/);
  });
});
