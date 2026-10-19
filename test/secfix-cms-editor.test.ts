// Security regressions for @pramen/cms-editor and the option-source allowlist behind it:
//  - a sign-out with no external sign-in page forgets the token in STORAGE, not only in state;
//  - a field's `optionsFrom`/`referenceFrom` is dispatched under the VIEWER's token, so the
//    editor calls only server-declared sources, and editor-authored schemas cannot name others.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { forgetSession } from "../packages/cms-editor/src/app-context";
import { Api, loadConfig, saveConfig } from "../packages/cms-editor/src/api";
import { matchesScreen } from "../packages/cms-editor/src/components";
import { createCmsHandlers, collection, createCollectionHandlers, normalizeFieldSchema } from "../packages/cms/src/index";
import { mutation, query } from "../packages/server/src";
import { defineSchema, Entity, generated, primaryKey } from "../packages/server/src/sdk/schema";

const LS_KEY = "pramen.cmsEditor";

describe("signing out forgets the stored token", () => {
  let store: Map<string, string>;
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  beforeEach(() => {
    store = new Map();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  });

  test("after sign-out the next load has no token, so Setup shows instead of the last user", () => {
    saveConfig({ baseUrl: "https://cms.test", tenant: "main", token: "user-a.jwt" });
    expect(loadConfig().token).toBe("user-a.jwt");
    const next = forgetSession({ baseUrl: "https://cms.test", tenant: "main", token: "user-a.jwt" });
    expect(next.token).toBe("");
    expect(loadConfig().token).toBe("");
    expect(store.get(LS_KEY) ?? "").not.toContain("user-a.jwt");
    // The backend it pointed at is not a credential and is kept.
    expect(loadConfig().baseUrl).toBe("https://cms.test");
  });
});

describe("the editor dispatches only declared option sources", () => {
  const originalFetch = globalThis.fetch;
  let hits: string[];
  beforeEach(() => {
    hits = [];
    globalThis.fetch = (async (url: string) => {
      hits.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: [] }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("an undeclared name is refused without a request; a declared one is called", async () => {
    const api = new Api({ baseUrl: "https://cms.test", tenant: "main", token: "admin.jwt" });
    api.declareOptionSources(["lookupCampaigns"]);
    await expect(api.callOptionSource("pruneAnalytics")).rejects.toThrow(/pruneAnalytics/);
    expect(hits).toEqual([]);
    await api.callOptionSource("lookupCampaigns", { ids: ["x"] });
    expect(hits).toEqual(["https://cms.test/rpc/lookupCampaigns"]);
  });

  test("an older server (no declaration) means no source is called", async () => {
    const api = new Api({ baseUrl: "https://cms.test", tenant: "main", token: "admin.jwt" });
    api.declareOptionSources(undefined);
    await expect(api.callOptionSource("lookupCampaigns")).rejects.toThrow();
    expect(hits).toEqual([]);
  });
});

describe("the server declares, validates and registers option sources", () => {
  const lookupCampaigns = query(() => ({ items: [] }));

  test("an editor-authored schema may name only a declared source", () => {
    const h = createCmsHandlers({ optionSources: { lookupCampaigns } }) as unknown as Record<string, { input: (r: unknown) => unknown }>;
    const parse = (fieldsSchema: unknown) => h.createBlockType!.input({ name: "Promo", slug: "promo", fieldsSchema });
    expect(() => parse([{ name: "campaign", type: "select", optionsFrom: "pruneAnalytics" }])).toThrow(/not a declared option source/);
    expect(() => parse([{ name: "g", type: "group", fields: [{ name: "c", type: "reference", referenceFrom: "pruneAnalytics" }] }])).toThrow(/not a declared option source/);
    expect(parse([{ name: "campaign", type: "select", optionsFrom: "lookupCampaigns" }])).toBeTruthy();
    // The same rule through the exported validator.
    expect(() => normalizeFieldSchema([{ name: "c", type: "select", optionsFrom: "x" }], "f", new Set())).toThrow(/not a declared/);
  });

  test("the declared sources are registered and reported", async () => {
    const h = createCmsHandlers({ optionSources: { lookupCampaigns } }) as unknown as Record<string, { run: (c: unknown, i: unknown) => unknown }>;
    expect(h.lookupCampaigns).toBe(lookupCampaigns as never);
    const caps = (await h.listCmsCapabilities!.run({ identity: null } as never, {})) as { optionSources: string[] };
    expect(caps.optionSources).toEqual(["lookupCampaigns"]);
    expect(((await (createCmsHandlers() as unknown as typeof h).listCmsCapabilities!.run({ identity: null } as never, {})) as { optionSources: string[] }).optionSources).toEqual([]);
  });

  test("a mutation, or a name clashing with a CMS handler, is refused at construction", () => {
    expect(() => createCmsHandlers({ optionSources: { prune: mutation(() => null) } })).toThrow(/must be a query handler/);
    expect(() => createCmsHandlers({ optionSources: { getPage: query(() => null) } })).toThrow(/clashes/);
  });

  test("a collection field naming an undeclared source fails at construction", () => {
    const schema = defineSchema({ gigs: Entity((t) => ({ id: primaryKey(generated(t.uuid())), campaign: t.text() })) });
    const c = collection("gigs", { entity: "gigs", label: "Gig", fields: [{ name: "campaign", type: "select", optionsFrom: "lookupCampaigns" }] });
    expect(() => createCollectionHandlers([c], { schema })).toThrow(/not in optionSources/);
    expect(() => createCollectionHandlers([c], { schema, optionSources: { lookupCampaigns } })).not.toThrow();
  });
});

describe("approve compares the screen with the server's current page", () => {
  const block = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: "pb1", block_type: "text", title: null, fields, is_shared: false, ...extra }) as never;
  const page = { id: "p1", title: "T", slug: "t", locale: "cs", fields: { a: 1, b: 2 }, seo: { title: "S" } };
  const fresh = (p: Record<string, unknown>, regions: Record<string, unknown[]>) => ({ page: p, regions, contentHash: "h" }) as never;

  test("a round trip that reorders JSON keys, or changes only status/updatedAt, still matches", () => {
    const f = fresh({ ...page, fields: { b: 2, a: 1 }, status: "review", updatedAt: "later", translations: [] }, { main: [block({ y: { q: 2, p: 1 }, x: "1" })] });
    expect(matchesScreen(f, { ...page, status: "draft" }, { main: [block({ x: "1", y: { p: 1, q: 2 } })] })).toBe(true);
  });

  test("anything else the hash covers that differs is a mismatch, nested SEO and block properties included", () => {
    const screen = { main: [block({ x: "1" })] };
    expect(matchesScreen(fresh(page, { main: [block({ x: "2" })] }), page, screen)).toBe(false);
    expect(matchesScreen(fresh({ ...page, title: "Other" }, screen), page, screen)).toBe(false);
    expect(matchesScreen(fresh({ ...page, seo: { title: "Changed" } }, screen), page, screen)).toBe(false);
    expect(matchesScreen(fresh({ ...page, contentType: { slug: "x" } }, screen), page, screen)).toBe(false);
    expect(matchesScreen(fresh(page, { main: [block({ x: "1" }, { is_shared: true })] }), page, screen)).toBe(false);
    expect(matchesScreen(fresh(page, { main: [block({ x: "1" }), { ...block({}), id: "pb2" }] }), page, screen)).toBe(false);
    expect(matchesScreen(fresh(page, { main: [block({ x: "1" })], aside: [block({})] }), page, screen)).toBe(false);
  });
});
