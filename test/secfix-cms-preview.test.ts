// Security regressions for preview links: a redeemed link reads AS ITS MINTER (never as the
// configured viewer-role union), dies with the minter's sessions (the KV denylist), and lives
// no longer than a session unless the deployment opts in.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema, Entity, defaultTo, expr, primaryKey, generated } from "../packages/server/src/sdk/schema";
import { policy, role, type Identity, type Policy } from "../packages/server/src/sdk/acl";
import { compileAcl, type AclContext } from "../packages/server/src/runtime/acl";
import { migrate } from "../packages/server/src/runtime/migrate";
import { dispatch } from "../packages/server/src/runtime/dispatch";
import { Kv, denySession } from "../packages/server/src/runtime/kv";
import { bunSqliteDriver } from "./sqlite-driver";
import {
  cmsSchema, collection, createCollectionHandlers, createCmsHandlers, collectionPolicies, cmsPolicies,
  cmsRoutes, COLLECTION_PREVIEW_PATH, PREVIEW_PATH,
} from "../packages/cms/src/index";

const SECRET = "secfix-dummy-secret-at-least-16-chars";
const schema = defineSchema({
  ...cmsSchema,
  gigs: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    title: t.text(),
    budget: defaultTo(t.text(), ""),
    ownerId: t.text(),
    status: defaultTo(t.text(), "draft"),
    publishedAt: t.text(),
    createdAt: defaultTo(t.text(), expr.now()),
  })),
});
const gigs = collection("gigs", {
  entity: "gigs", label: "Gig", titleField: "title", supports: ["drafts", "preview"],
  fields: [{ name: "title", type: "text", required: true }, { name: "budget", type: "text" }],
});
const handlerOpts = { previewTtlSeconds: 3600 };
const H = { ...createCmsHandlers(handlerOpts), ...createCollectionHandlers([gigs], { schema, ...handlerOpts }) } as Record<string, any>;

// The editor's scope is NARROWER than admin's: no `budget`, and page blocks in `main` only.
const edCms: Policy[] = cmsPolicies({ prefix: "ed" }).editor.map((p) =>
  p.entity === "cms_page_blocks" && p.action === "read" ? policy(p.name, p.entity, "read", { where: { region: "main" } }) : p);
const acl = compileAcl([
  role("admin", [...cmsPolicies().editor, ...collectionPolicies([gigs])]),
  role("reviewer", [...cmsPolicies({ prefix: "rv" }).editor, ...collectionPolicies([gigs], { prefix: "rv" })]),
  role("editor", [
    ...edCms,
    policy("ed:gigs:read", "gigs", "read", { fields: ["id", "title", "ownerId", "status", "publishedAt", "createdAt"] }),
  ]),
]);
const GIG = "22222222-2222-4222-8222-222222222222";
const PAGE = "33333333-3333-4333-8333-333333333333";

/** A KVNamespace over a Map, enough for the denylist. */
function memoryKv(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
}

async function fresh() {
  const d = bunSqliteDriver(new Database(":memory:"));
  await migrate(d, schema);
  await d.exec("INSERT INTO gigs (id,title,budget,ownerId,status) VALUES (?,?,?,?,?)", [GIG, "Dummy gig", "DUMMY-BUDGET-42", "edA", "draft"]);
  await d.exec("INSERT INTO cms_content_types (id,name,slug) VALUES ('ct1','Doc','doc')", []);
  await d.exec("INSERT INTO cms_block_types (id,name,slug) VALUES ('bt1','Text','text')", []);
  await d.exec(`INSERT INTO cms_blocks (id,typeId,title,fields) VALUES ('b1','bt1','pub','{"t":"visible"}'),('b2','bt1','int','{"t":"DUMMY-INTERNAL-NOTE"}')`, []);
  await d.exec("INSERT INTO cms_pages (id,typeId,title,slug) VALUES (?,?,?,?)", [PAGE, "ct1", "Dummy page", "dummy"]);
  await d.exec("INSERT INTO cms_page_blocks (id,pageId,blockId,region,position) VALUES ('pb1',?, 'b1','main',0),('pb2',?,'b2','internal',0)", [PAGE, PAGE]);
  return d;
}

const env = (kv: KVNamespace, extra: Record<string, unknown> = {}) => ({ AUTH_SECRET: SECRET, KV: kv, ...extra });

const call = async (d: any, identity: Identity, name: string, input: unknown, e: Record<string, unknown> = { AUTH_SECRET: SECRET }) => {
  const a = { acl, identity, schema, tenant: "main", partition: undefined } as unknown as AclContext;
  return (await dispatch(H as any, schema, d, {} as any, {} as any, e as any, a, name, input as any)).result as any;
};

/** Redeem through the real route, with a `callPrivileged` that builds the identity exactly
 * from what the route passes (`roles` + `userId`), as both stores do. */
const redeem = async (d: any, kv: KVNamespace, path: string, url: string) => {
  const route = cmsRoutes().find((r) => r.path === path)!;
  let presented: { roles?: string[]; userId?: string } | undefined;
  const ctx = {
    callPrivileged: async (o: { name: string; input?: unknown; roles?: string[]; userId?: string }) => {
      presented = { roles: o.roles, userId: o.userId };
      const identity = { roles: o.roles ?? ["admin"], ...(o.userId !== undefined ? { userId: o.userId } : {}) };
      try {
        return new Response(JSON.stringify({ ok: true, result: await call(d, identity, o.name, o.input ?? null) }));
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 400 });
      }
    },
  };
  const orig = console.error;
  console.error = () => {};
  try {
    const res = await route.handler(new Request(`https://x.test${url}`), env(kv) as never, ctx as never);
    return { status: res.status, presented, body: (await res.json()) as any };
  } finally {
    console.error = orig;
  }
};
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString());
const edA: Identity = { userId: "edA", roles: ["editor"] };

describe("a redeemed preview link reads as its minter", () => {
  test("collection: a field the minter cannot read stays out of the redeemed values", async () => {
    const d = await fresh();
    const kv = memoryKv();
    const m = await call(d, edA, "signCollectionPreview", { collection: "gigs", id: GIG });
    expect(payloadOf(m.token)).toMatchObject({ u: "edA", ro: ["editor"] });
    const r = await redeem(d, kv, COLLECTION_PREVIEW_PATH, m.url);
    expect(r.presented).toEqual({ roles: ["editor"], userId: "edA" });
    expect(r.status).toBe(200);
    expect(r.body.values.budget).toBeUndefined();
    expect(r.body.values.title).toBe("Dummy gig");
  });

  test("page: a region the minter cannot read stays out of the redeemed page", async () => {
    const d = await fresh();
    const kv = memoryKv();
    const m = await call(d, edA, "signPagePreview", { pageId: PAGE });
    const r = await redeem(d, kv, PREVIEW_PATH, m.url);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.regions)).toEqual(["main"]);
  });

  test("a token with no minter (the pre-fix shape) is refused", async () => {
    const d = await fresh();
    const kv = memoryKv();
    const { signToken } = await import("../packages/server/src/runtime/token");
    const legacy = await signToken({ t: "main", p: PAGE, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
    const r = await redeem(d, kv, PREVIEW_PATH, `${PREVIEW_PATH}?token=${encodeURIComponent(legacy)}`);
    expect(r.status).toBe(404);
    expect(r.presented).toBeUndefined();
  });

  test("an identity with no userId cannot mint a link", async () => {
    const d = await fresh();
    await expect(call(d, { roles: ["editor"] }, "signPagePreview", { pageId: PAGE })).rejects.toThrow(/signed-in user/);
  });
});

describe("a preview link dies with its minter's sessions", () => {
  test("a denylisted (deactivated or deleted) minter's link 404s", async () => {
    const d = await fresh();
    const kv = memoryKv();
    const m = await call(d, edA, "signCollectionPreview", { collection: "gigs", id: GIG });
    expect((await redeem(d, kv, COLLECTION_PREVIEW_PATH, m.url)).status).toBe(200);
    await denySession(new Kv(kv), "edA", 3600);
    const r = await redeem(d, kv, COLLECTION_PREVIEW_PATH, m.url);
    expect(r.status).toBe(404);
    expect(r.presented).toBeUndefined();
  });

  test("a demoted minter's link fails the handler gate (roles are the minter's)", async () => {
    const d = await fresh();
    const kv = memoryKv();
    // Minted while the minter held no CMS role at all: the presented roles say so.
    const { signToken } = await import("../packages/server/src/runtime/token");
    const t = await signToken({ t: "main", c: "gigs", r: GIG, exp: Math.floor(Date.now() / 1000) + 600, u: "edA", ro: [] }, SECRET);
    const r = await redeem(d, kv, COLLECTION_PREVIEW_PATH, `${COLLECTION_PREVIEW_PATH}?token=${encodeURIComponent(t)}`);
    expect(r.status).toBe(404);
  });

  test("a link lives no longer than a session unless the deployment opts in", async () => {
    const d = await fresh();
    const thirtyDays = 30 * 24 * 3600;
    const capped = await call(d, edA, "signPagePreview", { pageId: PAGE, expiresIn: thirtyDays }, { AUTH_SECRET: SECRET, AUTH_SESSION_TTL_SECONDS: "900" });
    expect(payloadOf(capped.token).exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(900);
    const defaulted = await call(d, edA, "signPagePreview", { pageId: PAGE, expiresIn: thirtyDays });
    expect(payloadOf(defaulted.token).exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3600);
    // Opt-in: a deployment that raises the ceiling gets longer links.
    const longer = createCmsHandlers({ maxPreviewTtlSeconds: 7 * 24 * 3600 }) as Record<string, any>;
    const a = { acl, identity: edA, schema, tenant: "main", partition: undefined } as unknown as AclContext;
    const res = (await dispatch(longer as any, schema, d, {} as any, {} as any, { AUTH_SECRET: SECRET } as any, a, "signPagePreview", { pageId: PAGE, expiresIn: thirtyDays })).result as any;
    expect(payloadOf(res.token).exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(6 * 24 * 3600);
  });
});
