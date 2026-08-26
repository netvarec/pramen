// @pramen/cms collections — the `supports: [...]` workflow features (issue #28).
//
// The point of the feature is that publish state stops being a VALUE THE CLIENT SENDS.
// Before this, a collection went live via a `publish` FIELD, and `fields` is the write
// whitelist — so "is this row live?" was whatever the client last PUT. These tests pin the
// replacement: managed columns the CMS owns, a boot check that refuses to let one back into
// the whitelist, and a public read scope that is the actual access boundary.
//
// Driven directly against a real ACL'd Db over bun:sqlite, like collection.test.ts.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema, Entity, defaultTo, expr, primaryKey, generated } from "../packages/server/src/sdk/schema";
import { policy, role, type Identity } from "../packages/server/src/sdk/acl";
import { compileAcl, type AclContext } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";
import {
  cmsSchema,
  collection,
  createCollectionHandlers,
  createCollectionTasks,
  collectionPolicies,
  collectionPublicPolicies,
  validateCollections,
  COLLECTION_PREVIEW_PATH,
  TASK_COLLECTION_PUBLISH,
  TASK_COLLECTION_UNPUBLISH,
} from "../packages/cms/src/index";
import { verifyToken } from "../packages/server/src/runtime/token";
import type { CollectionPreviewToken } from "../packages/cms/src/index";
import type { HandlerContext, JsonValue, Row } from "@pramen/server";

// `talks` carries the managed columns for all four features. `internalNote` is a real
// column that the collection deliberately does NOT declare as a field — the pre-existing
// write-whitelist guarantee has to survive the new write paths (publish, restore).
const schema = defineSchema({
  ...cmsSchema,
  talks: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    title: t.text(),
    speaker: defaultTo(t.text(), ""),
    internalNote: defaultTo(t.text(), ""),
    // managed by `drafts` / `scheduling` — never in `fields`
    status: defaultTo(t.text(), "draft"),
    publishedAt: t.text(),
    scheduledAt: t.text(),
    unpublishAt: t.text(),
    createdAt: defaultTo(t.text(), expr.now()),
  })),
});

const talks = collection("talks", {
  entity: "talks",
  label: "Talk",
  titleField: "title",
  supports: ["drafts", "scheduling", "revisions", "preview"],
  fields: [
    { name: "title", type: "text", required: true },
    { name: "speaker", type: "text" },
  ],
});

const H = createCollectionHandlers([talks], { schema });
const TASKS = createCollectionTasks([talks]);

// Invoke a handler the way dispatch does: run its boundary `input` validator FIRST, then
// the body, all inside a promise so a SYNC throw from either surfaces as a rejection.
// Calling `.run` bare would skip the validators entirely — and half of what they guard
// (a non-finite publishAt, an unpublishAt before its publish) never reaches the body.
const run = (h: { run: (c: never, i: never) => unknown; input?: (raw: JsonValue) => unknown }, ctx: unknown, input: JsonValue) =>
  Promise.resolve().then(() => h.run(ctx as never, (h.input ? h.input(input) : input) as never));

const editor: Identity = { userId: "ed", roles: ["editor"] };
const editorRoles = [role("editor", collectionPolicies([talks]))];

async function fresh() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  return driver;
}
type Driver = Awaited<ReturnType<typeof fresh>>;

// A ctx with the extras the workflow handlers reach for: tasks (recorded, not run),
// tenant/store/env for preview.
function editorCtx(driver: Driver, enqueued: Row[] = []) {
  const acl: AclContext = { acl: compileAcl(editorRoles), identity: editor, schema, partition: undefined };
  return {
    db: new Db(driver, acl, schema),
    identity: editor,
    tenant: "acme",
    store: "do",
    env: { AUTH_SECRET: "a-sufficiently-long-test-secret" },
    tasks: { enqueue: (t: Row) => { enqueued.push(t); return Promise.resolve(); } },
  } as unknown as HandlerContext;
}
function systemCtx(driver: Driver) {
  const acl: AclContext = { acl: compileAcl([]), identity: null, schema, system: true, partition: undefined };
  return { db: new Db(driver, acl, schema), identity: null } as unknown as HandlerContext;
}
// Anonymous, holding only the public collection scope — the boundary under test.
function publicCtx(driver: Driver, cols = [talks]) {
  const acl: AclContext = { acl: compileAcl([role("anonymous", collectionPublicPolicies(cols))]), identity: null, schema, partition: undefined };
  return new Db(driver, acl, schema);
}

const create = async (ctx: HandlerContext, values: Record<string, unknown>) =>
  (await run(H.collectionCreate, ctx, { collection: "talks", values } as JsonValue)) as Row;
const rowOf = async (driver: Driver, id: string) =>
  (await driver.exec("SELECT * FROM talks WHERE id = ?", [id]))[0];

// ---------------------------------------------------------------------------

describe("supports — boot validation", () => {
  const mk = (over: Record<string, unknown>) =>
    collection("x", { entity: "talks", label: "X", fields: [{ name: "title", type: "text" }], ...over });

  test("declaring `supports` without a schema is a boot error, not a runtime 500", () => {
    expect(() => createCollectionHandlers([mk({ supports: ["drafts"] })])).toThrow(/needs the schema/);
  });

  test("a collection with NO features still needs no schema (unchanged wiring keeps working)", () => {
    expect(() => createCollectionHandlers([mk({})])).not.toThrow();
  });

  test("an unknown feature names the known set", () => {
    expect(() => validateCollections([mk({ supports: ["drafs"] as never })], schema)).toThrow(/unknown feature 'drafs'/);
  });

  test("`scheduling` without `drafts` is refused", () => {
    expect(() => validateCollections([mk({ supports: ["scheduling"] })], schema)).toThrow(/'scheduling', which needs 'drafts'/);
  });

  test("`preview` without `drafts` is refused", () => {
    expect(() => validateCollections([mk({ supports: ["preview"] })], schema)).toThrow(/'preview', which needs 'drafts'/);
  });

  test("a missing managed column names the collection, the feature AND the column", () => {
    const bare = defineSchema({ bare: Entity((t) => ({ id: primaryKey(generated(t.uuid())), title: t.text() })) });
    expect(() =>
      validateCollections([collection("b", { entity: "bare", label: "B", supports: ["drafts"], fields: [{ name: "title", type: "text" }] })], bare),
    ).toThrow(/collection 'b' declares 'drafts', which manages a `status` column on 'bare'/);
  });

  // THE security check. `fields` is the write whitelist, so a `status` field would let any
  // editor send values:{status:"published"} straight through collectionUpdate and skip the
  // publish gate entirely.
  test("a managed column declared as an editable field is refused", () => {
    expect(() =>
      validateCollections(
        [collection("t", { entity: "talks", label: "T", supports: ["drafts"], fields: [{ name: "title", type: "text" }, { name: "status", type: "text" }] })],
        schema,
      ),
    ).toThrow(/declares `status` as an editable field.*client-writable publish gate/s);
  });

  test("an entity missing from the schema is refused", () => {
    expect(() => validateCollections([mk({ entity: "ghosts", supports: ["drafts"] })], schema)).toThrow(/entity 'ghosts', which is not in the schema/);
  });

  test("`revisions` without the shared revisions table is refused", () => {
    const noCms = defineSchema({
      talks: Entity((t) => ({ id: primaryKey(generated(t.uuid())), title: t.text(), status: defaultTo(t.text(), "draft") })),
    });
    expect(() => validateCollections([mk({ supports: ["drafts", "revisions"] })], noCms)).toThrow(/cms_collection_revisions/);
  });

  test("duplicate slugs are refused (the registry is keyed by slug)", () => {
    expect(() => validateCollections([mk({}), mk({})])).toThrow(/duplicate collection slug 'x'/);
  });

  test("an idField that is not a column is refused", () => {
    expect(() => validateCollections([mk({ idField: "nope", supports: ["drafts"] })], schema)).toThrow(/idField 'nope', which is not a column/);
  });

  // Reads key on idField but db.update/db.delete key on the entity's real PK, so a non-PK
  // idField loads a row and then writes nothing — a 404 on a row just read.
  test("an idField that is a column but NOT the primary key is refused", () => {
    expect(() => validateCollections([mk({ idField: "speaker", supports: ["drafts"] })], schema)).toThrow(
      /idField 'speaker', but 'talks' has primary key 'id'/,
    );
  });

  // A DO cannot write across partitions, so this would pass boot and 500 on every snapshot.
  test("`revisions` on an entity in another partition is refused at boot", () => {
    const split = defineSchema({
      ...cmsSchema,
      talks: Entity(
        (t) => ({ id: primaryKey(generated(t.uuid())), title: t.text(), status: defaultTo(t.text(), "draft") }),
        undefined,
        { partition: "content" },
      ),
    });
    expect(() => validateCollections([mk({ entity: "talks", supports: ["drafts", "revisions"] })], split)).toThrow(
      /is in partition 'content' while `cms_collection_revisions` is in 'default'/,
    );
  });
});

describe("drafts", () => {
  test("a new row is seeded as a draft, never live-on-create", async () => {
    const d = await fresh();
    const row = await create(editorCtx(d), { title: "T" });
    expect(row.status).toBe("draft");
  });

  test("publish moves it live and stamps publishedAt; unpublish reverses both", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "T" });
    const pub = (await run(H.collectionPublish, ctx, { collection: "talks", id } as JsonValue)) as Row;
    expect(pub.status).toBe("published");
    expect(typeof pub.publishedAt).toBe("string");

    const un = (await run(H.collectionUnpublish, ctx, { collection: "talks", id } as JsonValue)) as Row;
    expect(un.status).toBe("draft");
    expect(un.publishedAt).toBeNull();
  });

  // The whitelist has to hold on the WORKFLOW columns specifically, or `supports` is
  // decoration over a client-set value — exactly the `publish`-field trap it replaces.
  test("collectionUpdate cannot set `status` — it is managed, not a field", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "T" });
    await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: "T2", status: "published" } } as JsonValue);
    expect((await rowOf(d, String(id))).status).toBe("draft");
  });

  // A takedown instant that has already passed is not "pending" — and since the public
  // scope enforces it, leaving one standing would make the republish a silent no-op.
  test("publishing clears a SPENT unpublishAt, so the row really does come back", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "back" });
    await (systemCtx(d).db as unknown as Db).update("talks", String(id), { unpublishAt: new Date(Date.now() - 3_600_000).toISOString() });
    await run(H.collectionPublish, ctx, { collection: "talks", id } as JsonValue);

    expect((await rowOf(d, String(id))).unpublishAt).toBeNull();
    expect((await publicCtx(d).find({ from: "talks", where: {} })) as Row[]).toHaveLength(1);
  });

  test("publishing does NOT clear a still-FUTURE takedown", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "T" });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await (systemCtx(d).db as unknown as Db).update("talks", String(id), { unpublishAt: future });
    await run(H.collectionPublish, ctx, { collection: "talks", id } as JsonValue);

    expect((await rowOf(d, String(id))).unpublishAt).toBe(future);
  });

  test("a workflow handler on a collection that never opted in is a 400, not a 500", async () => {
    const plain = collection("plain", { entity: "talks", label: "P", fields: [{ name: "title", type: "text" }] });
    const PH = createCollectionHandlers([plain], { schema });
    const d = await fresh();
    await expect(run(PH.collectionPublish, editorCtx(d), { collection: "plain", id: "x" } as JsonValue)).rejects.toThrow(/does not support 'drafts'/);
  });

  test("publish stamps publishedAt in the ISO-Z shape $now() compares against", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "T" });
    await run(H.collectionPublish, ctx, { collection: "talks", id } as JsonValue);
    // Not nowStamp()'s "YYYY-MM-DD HH:MM:SS" — that sorts against the ISO form as if hours
    // apart, which is the documented `publish`-vs-`datetime` trap.
    expect(String((await rowOf(d, String(id))).publishedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("the public read scope IS the access boundary", () => {
  test("anonymous sees a published row and never a draft", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const live = await create(ctx, { title: "live" });
    await create(ctx, { title: "hidden" });
    await run(H.collectionPublish, ctx, { collection: "talks", id: live.id } as JsonValue);

    const rows = (await publicCtx(d).find({ from: "talks", where: {} })) as Row[];
    expect(rows.map((r) => r.title)).toEqual(["live"]);
  });

  // The reason the scope is `publishedAt <= $now()` and not `isNull: false`.
  test("a row published with a FUTURE publishedAt stays hidden", async () => {
    const d = await fresh();
    const sys = systemCtx(d).db as unknown as Db;
    await sys.insert("talks", { title: "future", status: "published", publishedAt: new Date(Date.now() + 3_600_000).toISOString() });
    await sys.insert("talks", { title: "past", status: "published", publishedAt: new Date(Date.now() - 3_600_000).toISOString() });
    const rows = (await publicCtx(d).find({ from: "talks", where: {} })) as Row[];
    expect(rows.map((r) => r.title)).toEqual(["past"]);
  });

  test("a caller cannot widen the scope by asking for the hidden row by name", async () => {
    const d = await fresh();
    await create(editorCtx(d), { title: "hidden" });
    expect(await publicCtx(d).find({ from: "talks", where: { title: "hidden" } })).toHaveLength(0);
  });

  // The takedown side must not depend solely on the outbox task firing.
  test("a scheduled UNPUBLISH is enforced by the read scope, not only by the task", async () => {
    const d = await fresh();
    const sys = systemCtx(d).db as unknown as Db;
    const past = new Date(Date.now() - 3_600_000).toISOString();
    await sys.insert("talks", { title: "still-up", status: "published", publishedAt: past, unpublishAt: new Date(Date.now() + 3_600_000).toISOString() });
    // The task never ran (unwired, or a wedged drain) — the row is past its takedown.
    await sys.insert("talks", { title: "expired", status: "published", publishedAt: past, unpublishAt: past });

    const rows = (await publicCtx(d).find({ from: "talks", where: {} })) as Row[];
    expect(rows.map((r) => r.title)).toEqual(["still-up"]);
  });

  // The declared fields ARE the public surface; anything else on the entity is internal.
  test("the public grant exposes only the declared fields + the id", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "T" });
    await (systemCtx(d).db as unknown as Db).update("talks", String(id), { internalNote: "do not publish this" });
    await run(H.collectionPublish, ctx, { collection: "talks", id } as JsonValue);

    const [row] = (await publicCtx(d).find({ from: "talks", where: {} })) as Row[];
    expect(row.title).toBe("T");
    expect(row).not.toHaveProperty("internalNote"); // an undeclared column is NOT public
    expect(row).not.toHaveProperty("unpublishAt"); // nor the managed workflow columns
  });

  // `anonymous` is assigned ONLY to callers with no verified token, so spreading the public
  // grants into that role alone denies logged-IN users content logged-OUT visitors can read.
  test("an authenticated non-editor needs the grant too — `anonymous` does not cover them", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "live" });
    await run(H.collectionPublish, ctx, { collection: "talks", id } as JsonValue);

    const member: Identity = { userId: "m", roles: ["member"] };
    const withGrant = new Db(
      d,
      { acl: compileAcl([role("member", collectionPublicPolicies([talks]))]), identity: member, schema, partition: undefined },
      schema,
    );
    expect((await withGrant.find({ from: "talks", where: {} })) as Row[]).toHaveLength(1);

    // The same caller, when the grant lives only on `anonymous`: denied outright.
    const anonOnly = new Db(
      d,
      { acl: compileAcl([role("anonymous", collectionPublicPolicies([talks]))]), identity: member, schema, partition: undefined },
      schema,
    );
    await expect(anonOnly.find({ from: "talks", where: {} })).rejects.toThrow();
  });

  test("a collection without `drafts` gets NO public policy (its exposure stays the app's call)", () => {
    const plain = collection("plain", { entity: "talks", label: "P", fields: [{ name: "title", type: "text" }] });
    expect(collectionPublicPolicies([plain])).toHaveLength(0);
  });
});

describe("scheduling", () => {
  test("schedule stores ISO tokens and enqueues both tasks in the mutation", async () => {
    const d = await fresh();
    const enq: Row[] = [];
    const ctx = editorCtx(d, enq);
    const { id } = await create(ctx, { title: "T" });
    const at = Date.now() + 60_000;
    await run(H.collectionSchedule, ctx, { collection: "talks", id, publishAt: at, unpublishAt: at + 60_000 } as JsonValue);

    expect(enq.map((e) => e.kind)).toEqual([TASK_COLLECTION_PUBLISH, TASK_COLLECTION_UNPUBLISH]);
    expect(String((await rowOf(d, String(id))).scheduledAt)).toBe(new Date(at).toISOString());
  });

  test("the task publishes when its intent token still matches", async () => {
    const d = await fresh();
    const enq: Row[] = [];
    const ctx = editorCtx(d, enq);
    const { id } = await create(ctx, { title: "T" });
    await run(H.collectionSchedule, ctx, { collection: "talks", id, publishAt: Date.now() } as JsonValue);

    await TASKS[TASK_COLLECTION_PUBLISH](systemCtx(d), enq[0].payload);
    const row = await rowOf(d, String(id));
    expect(row.status).toBe("published");
    expect(row.scheduledAt).toBeNull();
  });

  // Superseded schedules are the whole reason for the token.
  test("a RESCHEDULE makes the first task a no-op", async () => {
    const d = await fresh();
    const enq: Row[] = [];
    const ctx = editorCtx(d, enq);
    const { id } = await create(ctx, { title: "T" });
    await run(H.collectionSchedule, ctx, { collection: "talks", id, publishAt: Date.now() + 1000 } as JsonValue);
    const stale = enq[0].payload;
    await run(H.collectionSchedule, ctx, { collection: "talks", id, publishAt: Date.now() + 5000 } as JsonValue);

    await TASKS[TASK_COLLECTION_PUBLISH](systemCtx(d), stale);
    expect((await rowOf(d, String(id))).status).toBe("draft");
  });

  test("a manual unpublish cancels a pending scheduled publish", async () => {
    const d = await fresh();
    const enq: Row[] = [];
    const ctx = editorCtx(d, enq);
    const { id } = await create(ctx, { title: "T" });
    await run(H.collectionSchedule, ctx, { collection: "talks", id, publishAt: Date.now() + 1000 } as JsonValue);
    await run(H.collectionUnpublish, ctx, { collection: "talks", id } as JsonValue);

    await TASKS[TASK_COLLECTION_PUBLISH](systemCtx(d), enq[0].payload);
    expect((await rowOf(d, String(id))).status).toBe("draft");
  });

  test("a duplicate delivery of an already-run task is a no-op, not a re-publish", async () => {
    const d = await fresh();
    const enq: Row[] = [];
    const ctx = editorCtx(d, enq);
    const { id } = await create(ctx, { title: "T" });
    await run(H.collectionSchedule, ctx, { collection: "talks", id, publishAt: Date.now() } as JsonValue);
    await TASKS[TASK_COLLECTION_PUBLISH](systemCtx(d), enq[0].payload);
    await run(H.collectionUnpublish, ctx, { collection: "talks", id } as JsonValue);
    await TASKS[TASK_COLLECTION_PUBLISH](systemCtx(d), enq[0].payload); // redelivered

    expect((await rowOf(d, String(id))).status).toBe("draft");
  });

  test("the unpublish task takes a live row back to draft", async () => {
    const d = await fresh();
    const enq: Row[] = [];
    const ctx = editorCtx(d, enq);
    const { id } = await create(ctx, { title: "T" });
    const at = Date.now();
    await run(H.collectionSchedule, ctx, { collection: "talks", id, publishAt: at, unpublishAt: at + 1000 } as JsonValue);
    await TASKS[TASK_COLLECTION_PUBLISH](systemCtx(d), enq[0].payload);
    await TASKS[TASK_COLLECTION_UNPUBLISH](systemCtx(d), enq[1].payload);

    const row = await rowOf(d, String(id));
    expect(row.status).toBe("draft");
    expect(row.publishedAt).toBeNull();
  });

  test("a task naming an unregistered collection is dropped, never run against a guessed table", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "T" });
    await TASKS[TASK_COLLECTION_PUBLISH](systemCtx(d), { collection: "not_registered", id, token: null });
    expect((await rowOf(d, String(id))).status).toBe("draft");
  });

  // Omitting the takedown must not revoke one: clearing the column also neutralizes the
  // enqueued task through the intent-token check, so the removal vanishes silently.
  test("rescheduling the publish date leaves an existing takedown alone", async () => {
    const d = await fresh();
    const enq: Row[] = [];
    const ctx = editorCtx(d, enq);
    const { id } = await create(ctx, { title: "T" });
    const at = Date.now() + 60_000;
    await run(H.collectionSchedule, ctx, { collection: "talks", id, publishAt: at, unpublishAt: at + 60_000 } as JsonValue);
    const takedown = (await rowOf(d, String(id))).unpublishAt;

    await run(H.collectionSchedule, ctx, { collection: "talks", id, publishAt: at + 10_000 } as JsonValue);
    expect((await rowOf(d, String(id))).unpublishAt).toBe(takedown);
  });

  test("an explicit `unpublishAt: null` DOES cancel the takedown", async () => {
    const d = await fresh();
    const enq: Row[] = [];
    const ctx = editorCtx(d, enq);
    const { id } = await create(ctx, { title: "T" });
    const at = Date.now() + 60_000;
    await run(H.collectionSchedule, ctx, { collection: "talks", id, publishAt: at, unpublishAt: at + 60_000 } as JsonValue);
    await run(H.collectionSchedule, ctx, { collection: "talks", id, publishAt: at, unpublishAt: null } as JsonValue);

    expect((await rowOf(d, String(id))).unpublishAt).toBeNull();
  });

  test("unpublishAt must be after publishAt, and both must be finite", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "T" });
    const base = { collection: "talks", id } as Record<string, unknown>;
    await expect(run(H.collectionSchedule, ctx, { ...base, publishAt: 1000, unpublishAt: 500 } as JsonValue)).rejects.toThrow(/must be after publishAt/);
    await expect(run(H.collectionSchedule, ctx, { ...base, publishAt: "soon" } as JsonValue)).rejects.toThrow(/finite epoch ms/);
  });
});

describe("revisions", () => {
  test("an edit snapshots the PRIOR state, and restore reverses it", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "v1", speaker: "alice" });
    await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: "v2", speaker: "alice" } } as JsonValue);

    const revs = (await run(H.collectionListRevisions, ctx, { collection: "talks", id } as JsonValue)) as Row[];
    expect(revs).toHaveLength(1);
    expect((revs[0].snapshot as Row).title).toBe("v1");

    const back = (await run(H.collectionRestoreRevision, ctx, { collection: "talks", id, revisionId: revs[0].id } as JsonValue)) as Row;
    expect(back.title).toBe("v1");
  });

  test("a restore is itself snapshotted, so it can be undone", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "v1" });
    await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: "v2" } } as JsonValue);
    const [first] = (await run(H.collectionListRevisions, ctx, { collection: "talks", id } as JsonValue)) as Row[];
    await run(H.collectionRestoreRevision, ctx, { collection: "talks", id, revisionId: first.id } as JsonValue);

    const revs = (await run(H.collectionListRevisions, ctx, { collection: "talks", id } as JsonValue)) as Row[];
    expect(revs.map((r) => (r.snapshot as Row).title)).toContain("v2");
  });

  // The revisions table is shared by every collection, so a revision id is a global handle.
  test("a revision belonging to a DIFFERENT row cannot be restored over this one", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const a = await create(ctx, { title: "a1" });
    const b = await create(ctx, { title: "b1" });
    await run(H.collectionUpdate, ctx, { collection: "talks", id: a.id, values: { title: "a2" } } as JsonValue);
    const [aRev] = (await run(H.collectionListRevisions, ctx, { collection: "talks", id: a.id } as JsonValue)) as Row[];

    await expect(
      run(H.collectionRestoreRevision, ctx, { collection: "talks", id: b.id, revisionId: aRev.id } as JsonValue),
    ).rejects.toThrow(/revision not found/);
    expect((await rowOf(d, String(b.id))).title).toBe("b1");
  });

  test("a delete PURGES the row's revisions — nothing else ever collects them", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "v1" });
    await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: "v2" } } as JsonValue);
    expect((await run(H.collectionListRevisions, ctx, { collection: "talks", id } as JsonValue)) as Row[]).toHaveLength(1);

    await run(H.collectionDelete, ctx, { collection: "talks", id } as JsonValue);
    expect((await run(H.collectionListRevisions, ctx, { collection: "talks", id } as JsonValue)) as Row[]).toHaveLength(0);
  });

  // A collection PK may be a caller-chosen textId, so an id CAN come back. If the dead
  // row's history survived, restoring it would write the deleted content over the new row.
  test("a row recreated with a reused id does not inherit the dead row's history", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "v1" });
    await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: "v2" } } as JsonValue);
    await run(H.collectionDelete, ctx, { collection: "talks", id } as JsonValue);
    // Recreate with the SAME id, the way a textId-keyed collection would.
    await (systemCtx(d).db as unknown as Db).insert("talks", { id, title: "brand new", status: "draft" });

    expect((await run(H.collectionListRevisions, ctx, { collection: "talks", id } as JsonValue)) as Row[]).toHaveLength(0);
  });

  test("publish and unpublish write NO revision — they change no content", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "v1" });
    await run(H.collectionPublish, ctx, { collection: "talks", id } as JsonValue);
    await run(H.collectionUnpublish, ctx, { collection: "talks", id } as JsonValue);
    // A "publish" revision would be byte-identical to the edit before it, and restoring it
    // would write only the declared fields — leaving the row live and the button dead.
    expect((await run(H.collectionListRevisions, ctx, { collection: "talks", id } as JsonValue)) as Row[]).toHaveLength(0);
  });

  test("revisions are stamped at ms precision and come back newest-first", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "v1" });
    // Two writes inside the same SECOND — expr.now() would have given both the same stamp
    // and made the ordering arbitrary.
    await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: "v2" } } as JsonValue);
    await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: "v3" } } as JsonValue);

    const revs = (await run(H.collectionListRevisions, ctx, { collection: "talks", id } as JsonValue)) as Row[];
    expect(revs.map((r) => (r.snapshot as Row).title)).toEqual(["v2", "v1"]);
    // The ORDER comes from the monotonic counter, not the stamp — two writes in the same
    // millisecond are common, and a uuid tiebreak is deterministic but arbitrary.
    expect(revs.map((r) => r.revision)).toEqual([2, 1]);
    for (const r of revs) expect(String(r.createdAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  // The above passes by luck whenever the two writes land in different milliseconds, which
  // is most runs — so force the collision the counter exists to survive.
  test("ordering holds when two revisions share a timestamp exactly", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "v1" });
    await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: "v2" } } as JsonValue);
    await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: "v3" } } as JsonValue);
    await d.exec("UPDATE cms_collection_revisions SET createdAt = ? WHERE rowId = ?", ["2026-08-24T00:00:00.000Z", String(id)]);

    const revs = (await run(H.collectionListRevisions, ctx, { collection: "talks", id } as JsonValue)) as Row[];
    expect(revs.map((r) => (r.snapshot as Row).title)).toEqual(["v2", "v1"]);
  });

  test("the revisions limit is CLAMPED — a negative limit is not SQLite's `unbounded`", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "v1" });
    for (const t of ["v2", "v3", "v4"]) await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: t } } as JsonValue);

    const all = (await run(H.collectionListRevisions, ctx, { collection: "talks", id } as JsonValue)) as Row[];
    expect(all).toHaveLength(3);
    const negative = (await run(H.collectionListRevisions, ctx, { collection: "talks", id, limit: -1 } as JsonValue)) as Row[];
    expect(negative).toHaveLength(1); // clamped to 1, NOT all 3
  });

  // A snapshot is replayed through the same whitelist as any other write.
  test("restoring cannot write a column the collection does not declare", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "v1" });
    await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: "v2" } } as JsonValue);
    const [rev] = (await run(H.collectionListRevisions, ctx, { collection: "talks", id } as JsonValue)) as Row[];
    // Forge an undeclared column into the stored snapshot.
    await d.exec("UPDATE cms_collection_revisions SET snapshot = ? WHERE id = ?", [JSON.stringify({ title: "v1", internalNote: "leaked" }), rev.id]);
    await run(H.collectionRestoreRevision, ctx, { collection: "talks", id, revisionId: rev.id } as JsonValue);

    const row = await rowOf(d, String(id));
    expect(row.title).toBe("v1");
    expect(row.internalNote).toBe(""); // never written
  });

  // The DO's single writer serializes the read-then-increment; D1's transaction is a no-op,
  // so the composite unique is what stops a duplicate becoming a silent ordering ambiguity.
  test("a duplicate (collection, rowId, revision) is rejected by the DB, not silently kept", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "v1" });
    await run(H.collectionUpdate, ctx, { collection: "talks", id, values: { title: "v2" } } as JsonValue);

    await expect(
      d.exec("INSERT INTO cms_collection_revisions (id, collection, rowId, revision, snapshot, createdAt) VALUES (?, ?, ?, ?, ?, ?)", [
        "forced", "talks", String(id), 1, "{}", new Date().toISOString(),
      ]),
    ).rejects.toThrow();
  });

  test("a collection without `revisions` records nothing and refuses the handlers", async () => {
    const plain = collection("plain", { entity: "talks", label: "P", fields: [{ name: "title", type: "text" }] });
    const PH = createCollectionHandlers([plain], { schema });
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "T" });
    await expect(run(PH.collectionListRevisions, ctx, { collection: "plain", id } as JsonValue)).rejects.toThrow(/does not support 'revisions'/);
  });
});

describe("preview", () => {
  test("a signed link round-trips to the row's unpublished state", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "secret draft" });
    const minted = (await run(H.signCollectionPreview, ctx, { collection: "talks", id } as JsonValue)) as Row;
    expect(String(minted.url)).toStartWith(`${COLLECTION_PREVIEW_PATH}?token=`);

    const payload = await verifyToken<CollectionPreviewToken>(String(minted.token), "a-sufficiently-long-test-secret");
    expect(payload).toMatchObject({ t: "acme", c: "talks", r: String(id) });

    const got = (await run(H.getCollectionPreview, ctx, { collection: "talks", id } as JsonValue)) as Row;
    expect((got.values as Row).title).toBe("secret draft");
    expect(got.values).not.toHaveProperty("internalNote"); // declared fields only
  });

  test("a tampered token does not verify", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "T" });
    const minted = (await run(H.signCollectionPreview, ctx, { collection: "talks", id } as JsonValue)) as Row;
    const [data, sig] = String(minted.token).split(".");
    const forged = `${data.slice(0, -1)}${data.slice(-1) === "A" ? "B" : "A"}.${sig}`;
    expect(await verifyToken<CollectionPreviewToken>(forged, "a-sufficiently-long-test-secret")).toBeNull();
  });

  test("minting fails CLOSED when no usable secret is configured", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "T" });
    const noSecret = { ...ctx, env: {} } as unknown as HandlerContext;
    await expect(run(H.signCollectionPreview, noSecret, { collection: "talks", id } as JsonValue)).rejects.toThrow(/not configured/);
  });

  // Redemption always reaches a DO, so a D1-minted link would 404 forever.
  test("minting is refused on the D1 store rather than handing out a dead link", async () => {
    const d = await fresh();
    const ctx = editorCtx(d);
    const { id } = await create(ctx, { title: "T" });
    const onD1 = { ...ctx, store: "d1" } as unknown as HandlerContext;
    await expect(run(H.signCollectionPreview, onD1, { collection: "talks", id } as JsonValue)).rejects.toThrow(/not available on the D1 store/);
  });
});
