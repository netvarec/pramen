// @pramen/cms collections — the generic "edit an arbitrary pramen entity in the CMS
// editor" API. Drives the handlers built by createCollectionHandlers directly against a
// real ACL'd Db over bun:sqlite: registry lookup rejects an unknown/spoofed collection,
// the write whitelist blocks columns the collection didn't declare, field validation
// rejects bad types, CRUD round-trips, and the row ACL still scopes every call (the
// handlers go through ctx.db).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema, Entity, defaultTo, expr, hidden, primaryKey, generated } from "../packages/server/src/sdk/schema";
import { allow, policy, role, type Identity } from "../packages/server/src/sdk/acl";
import { compileAcl, type AclContext } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";
import { collection, createCollectionHandlers, collectionPolicies } from "../packages/cms/src/index";

// A user-defined entity edited as a collection. `secret` is hidden() and NOT in the
// collection's fields — the write whitelist must never let a caller set it.
const schema = defineSchema({
  lectures: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    title: t.text(),
    speaker: defaultTo(t.text(), ""),
    date: defaultTo(t.text(), ""),
    slides: t.json(),
    secret: hidden(defaultTo(t.text(), "")),
    createdAt: defaultTo(t.text(), expr.now()),
  })),
});

const lectures = collection("lectures", {
  entity: "lectures",
  label: "Lecture",
  titleField: "title",
  list: ["title", "speaker", "date"],
  orderBy: { column: "date", dir: "desc" },
  fields: [
    { name: "title", type: "text", required: true },
    { name: "speaker", type: "text" },
    { name: "date", type: "date" },
    { name: "slides", type: "repeater", fields: [{ name: "url", type: "url" }] },
  ],
});

const H = createCollectionHandlers([lectures]);

// Invoke a handler the way dispatch does — always awaited — so a SYNC throw (registry
// lookup, field validation) surfaces as a rejection just like an async one, and both are
// assertable with `.rejects`. (Calling `.run` bare would let a sync throw escape .rejects.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (h: { run: (c: any, i: any) => unknown }, ctx: unknown, input: unknown) => Promise.resolve().then(() => h.run(ctx, input));

// An editor identity granted CRUD over `lectures` via collectionPolicies.
const editorRoles = [role("editor", collectionPolicies([lectures]))];
const editor: Identity = { userId: "ed", roles: ["editor"] };

function editorCtx(driver: ReturnType<typeof bunSqliteDriver>) {
  const acl: AclContext = { acl: compileAcl(editorRoles), identity: editor, schema, partition: undefined };
  return { db: new Db(driver, acl, schema) } as never;
}
function systemCtx(driver: ReturnType<typeof bunSqliteDriver>) {
  const acl: AclContext = { acl: compileAcl([]), identity: null, schema, system: true, partition: undefined };
  return { db: new Db(driver, acl, schema) } as never;
}

async function fresh() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  return driver;
}

describe("collections — registry + whitelist", () => {
  test("listCollections returns the meta with defaults filled (no server-only fields)", () => {
    const metas = (H.listCollections.run as (c: unknown, i: unknown) => never)(null, {}) as unknown as Array<Record<string, unknown>>;
    expect(metas).toHaveLength(1);
    const m = metas[0];
    expect(m.slug).toBe("lectures");
    expect(m.pluralLabel).toBe("Lectures"); // defaulted from label
    expect(m.list).toEqual(["title", "speaker", "date"]);
    expect(m.titleField).toBe("title");
    expect(m.idField).toBe("id"); // PK column name — the editor reads a row's id from it
    expect("entity" in m).toBe(false); // server-only (table name), not leaked
  });

  test("an unknown collection slug is a 400, never a raw table reference", async () => {
    const driver = await fresh();
    const ctx = systemCtx(driver);
    await expect(run(H.collectionList, ctx, { collection: "sqlite_master" })).rejects.toThrow(/unknown collection/);
    await expect(run(H.collectionCreate, ctx, { collection: "nope", values: {} })).rejects.toThrow(/unknown collection/);
  });

  test("create whitelists to declared fields — an undeclared column is dropped", async () => {
    const driver = await fresh();
    const ctx = systemCtx(driver);
    // secret is a real (hidden) column but NOT in the collection's fields → must be ignored.
    const row = (await H.collectionCreate.run(ctx, {
      collection: "lectures",
      values: { title: "Intro", speaker: "Ada", secret: "leaked", bogus: "x" },
    })) as Record<string, unknown>;
    const id = row.id as string;
    // Read the raw column (hidden() is stripped from ORM reads) to prove it stayed at its default.
    const [raw] = await driver.exec("SELECT secret FROM lectures WHERE id = ?", [id]);
    expect(raw.secret).toBe(""); // untouched by the whitelisted write
  });

  test("field validation rejects a bad type before touching the db", async () => {
    const driver = await fresh();
    const ctx = systemCtx(driver);
    await expect(
      run(H.collectionCreate, ctx, { collection: "lectures", values: { title: "T", date: "not-a-date" } }),
    ).rejects.toThrow(/date/);
    await expect(
      run(H.collectionCreate, ctx, { collection: "lectures", values: { speaker: "no title" } }),
    ).rejects.toThrow(/required/); // title required on create
    expect((await driver.exec("SELECT count(*) AS n FROM lectures", []))[0].n).toBe(0);
  });
});

describe("collections — CRUD round-trip", () => {
  test("create → get → update → delete over the entity", async () => {
    const driver = await fresh();
    const ctx = systemCtx(driver);
    const created = (await H.collectionCreate.run(ctx, {
      collection: "lectures",
      values: { title: "One", speaker: "Ada", date: "2026-01-02", slides: [{ url: "https://x/1" }] },
    })) as Record<string, unknown>;
    const id = created.id as string;
    expect(typeof id).toBe("string");

    const got = (await H.collectionGet.run(ctx, { collection: "lectures", id })) as Record<string, unknown>;
    expect(got.title).toBe("One");
    expect(got.slides).toEqual([{ url: "https://x/1" }]); // json column round-trips as a value

    const updated = (await H.collectionUpdate.run(ctx, {
      collection: "lectures",
      id,
      values: { title: "One (edited)", speaker: "Grace" },
    })) as Record<string, unknown>;
    expect(updated.title).toBe("One (edited)");

    const missing = await H.collectionGet.run(ctx, { collection: "lectures", id: "does-not-exist" });
    expect(missing).toBe(null);

    const del = (await H.collectionDelete.run(ctx, { collection: "lectures", id })) as { ok: boolean };
    expect(del.ok).toBe(true);
    expect((await driver.exec("SELECT count(*) AS n FROM lectures", []))[0].n).toBe(0);

    await expect(H.collectionUpdate.run(ctx, { collection: "lectures", id, values: { title: "x" } })).rejects.toThrow(/not found/);
    await expect(H.collectionDelete.run(ctx, { collection: "lectures", id })).rejects.toThrow(/not found/);
  });

  test("list honors the collection's orderBy", async () => {
    const driver = await fresh();
    const ctx = systemCtx(driver);
    for (const [t, d] of [["A", "2026-01-01"], ["B", "2026-03-01"], ["C", "2026-02-01"]] as const) {
      await H.collectionCreate.run(ctx, { collection: "lectures", values: { title: t, date: d } });
    }
    const rows = (await H.collectionList.run(ctx, { collection: "lectures" })) as Record<string, unknown>[];
    expect(rows.map((r) => r.title)).toEqual(["B", "C", "A"]); // date desc
  });
});

describe("collections — the row ACL still applies (handlers go through ctx.db)", () => {
  test("an editor granted the entity can CRUD; the collection handler respects the ACL", async () => {
    const driver = await fresh();
    const ctx = editorCtx(driver);
    const row = (await H.collectionCreate.run(ctx, { collection: "lectures", values: { title: "Ed made this" } })) as Record<string, unknown>;
    expect(row.title).toBe("Ed made this");
    const got = (await H.collectionGet.run(ctx, { collection: "lectures", id: row.id as string })) as Record<string, unknown>;
    expect(got.title).toBe("Ed made this");
  });

  test("a role WITHOUT the entity grant is denied by the ACL, not silently served", async () => {
    const driver = await fresh();
    // seed via system so there is data to (fail to) read
    await H.collectionCreate.run(systemCtx(driver), { collection: "lectures", values: { title: "secret data" } });
    const strangerRoles = [role("stranger", [policy("s:other", "lectures", "read", { where: { id: "never" } })])];
    const acl: AclContext = { acl: compileAcl(strangerRoles), identity: { userId: "s", roles: ["stranger"] }, schema, partition: undefined };
    const ctx = { db: new Db(driver, acl, schema) } as never;
    // create isn't granted at all → denied
    await expect(H.collectionCreate.run(ctx, { collection: "lectures", values: { title: "x" } })).rejects.toThrow();
    // read is scoped to id="never" → the seeded row is invisible
    const rows = (await H.collectionList.run(ctx, { collection: "lectures" })) as unknown[];
    expect(rows).toHaveLength(0);
  });
});
