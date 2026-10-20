// Write policies bind the row being WRITTEN: a create policy's `where` must hold on the
// candidate row, an update policy may declare a `check` on the post-image, and a per-row
// (cell-level) update grant is re-asserted in the UPDATE so a concurrent write on D1 can't
// slip between the pre-image read and the write. Dummy data, in-memory bun:sqlite.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { app } from "../example/app";
import { Entity, defineSchema } from "../packages/server/src/sdk/schema";
import { $identity, allow, policy, role, type Identity } from "../packages/server/src/sdk/acl";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { ensureOutbox } from "../packages/server/src/runtime/outbox";
import type { Driver } from "../packages/server/src/runtime/driver";
import { bunSqliteDriver } from "./sqlite-driver";

const appSchema = app.schema as any;

async function exampleSetup(roles = app.acl as any) {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, appSchema);
  await ensureOutbox(driver);
  const acl = compileAcl(roles);
  const sys = new Db(driver, { acl, identity: null, schema: appSchema, system: true } as any, appSchema) as any;
  await sys.insert("users", { id: "alice", name: "Alice", email: "alice@example.test" });
  await sys.insert("users", { id: "mallory", name: "Mallory", email: "mallory@example.test" });
  const m = await sys.insert("notes", { title: "mal-note", body: "m-body", ownerId: "mallory", createdAt: 2 });
  const dbAs = (identity: Identity) => new Db(driver, { acl, identity, schema: appSchema } as any, appSchema) as any;
  const raw = async (id: number) => (await sys.find({ from: "notes", where: { id } }))[0];
  return { sys, m, dbAs, raw };
}

describe("create: the policy `where` binds the candidate row", () => {
  const scoped = [role("scopedcreator", [policy("sc:create", "notes", "create", { where: { ownerId: $identity("userId") } })])];

  test("an insert outside the where is a 403 and writes nothing; inside it succeeds", async () => {
    const s = await exampleSetup(scoped);
    const db = s.dbAs({ userId: "mallory", roles: ["scopedcreator"] });
    await expect(db.insert("notes", { title: "forged", body: "b", ownerId: "alice", createdAt: 3 })).rejects.toThrow(/access denied: create notes/);
    expect(await s.sys.count({ from: "notes", where: { title: "forged" } })).toBe(0);
    const ok = await db.insert("notes", { title: "own", body: "b", ownerId: "mallory", createdAt: 3 });
    expect(ok.ownerId).toBe("mallory");
  });

  test("a relation-traversing create where is evaluated in SQL against the candidate", async () => {
    const schema = defineSchema({
      projects: Entity((t) => ({ id: t.id(), owner: t.text() })),
      tasks: Entity((t) => ({ id: t.id(), title: t.text(), projectId: t.int() }), (r) => ({ project: r.belongsTo("projects", "projectId") })),
    });
    const driver = bunSqliteDriver(new Database(":memory:"));
    await migrate(driver, schema);
    const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema) as any;
    const mine = (await sys.insert("projects", { owner: "u1" })).id;
    const theirs = (await sys.insert("projects", { owner: "u2" })).id;
    const roles = [
      role("r", [
        policy("p", "projects", "read", allow()),
        policy("t", "tasks", "create", { where: { project: { owner: $identity("userId") } } }),
      ]),
    ];
    const db = new Db(driver, { acl: compileAcl(roles), identity: { userId: "u1", roles: ["r"] }, schema }, schema) as any;
    expect((await db.insert("tasks", { title: "ok", projectId: mine })).title).toBe("ok");
    await expect(db.insert("tasks", { title: "no", projectId: theirs })).rejects.toThrow(/access denied/);
    expect(await sys.count({ from: "tasks" })).toBe(1);
  });

  test("an omitted column is evaluated at its declared default", async () => {
    const schema = defineSchema({ items: Entity((t) => ({ id: t.id(), name: t.text(), status: { ...t.text(), default: "draft" } })) });
    const driver = bunSqliteDriver(new Database(":memory:"));
    await migrate(driver, schema);
    const roles = [role("r", [policy("c", "items", "create", { where: { status: "draft" } })])];
    const db = new Db(driver, { acl: compileAcl(roles), identity: { roles: ["r"] }, schema }, schema) as any;
    expect((await db.insert("items", { name: "a" })).name).toBe("a");
    await expect(db.insert("items", { name: "b", status: "live" })).rejects.toThrow(/access denied/);
  });
});

describe("update: an opt-in `check` on the post-image", () => {
  test("example author can't hand its note to someone else (updateNote), can still edit it", async () => {
    const s = await exampleSetup();
    const h = app.handlers as any;
    const identity = { userId: "mallory", roles: ["author"] };
    const ctx = { db: s.dbAs(identity), identity, env: {}, kv: undefined, tasks: { enqueue: async () => {} } };
    await expect(h.updateNote.run(ctx, { id: s.m.id, ownerId: "alice", title: "planted" })).rejects.toThrow(/access denied: update notes/);
    expect(await s.raw(s.m.id)).toMatchObject({ title: "mal-note", ownerId: "mallory" });
    expect((await h.updateNote.run(ctx, { id: s.m.id, title: "edited" })).title).toBe("edited");
  });

  test("without a check, moving a row out of the update scope stays possible (soft delete)", async () => {
    const schema = defineSchema({ pages: Entity((t) => ({ id: t.id(), title: t.text(), deletedAt: t.text() })) });
    const driver = bunSqliteDriver(new Database(":memory:"));
    await migrate(driver, schema);
    const roles = [role("ed", [policy("u", "pages", "update", { where: { deletedAt: { isNull: true } } }), policy("r", "pages", "read", allow())])];
    const db = new Db(driver, { acl: compileAcl(roles), identity: { roles: ["ed"] }, schema }, schema) as any;
    const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema) as any;
    const id = (await sys.insert("pages", { title: "p" })).id;
    expect((await db.update("pages", id, { deletedAt: "2026-01-01T00:00:00.000Z" })).deletedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(await db.update("pages", id, { title: "after" })).toBeUndefined(); // now out of scope
  });

  test("a failing check disables only ITS grant: another grant still covers its own fields", async () => {
    const roles = [
      role("owner", [policy("o", "notes", "update", { where: { ownerId: $identity("userId") }, check: { ownerId: $identity("userId") } })]),
      role("editor", [policy("e", "notes", "update", { fields: ["title"] })]),
    ];
    const s = await exampleSetup(roles);
    const db = s.dbAs({ userId: "mallory", roles: ["owner", "editor"] });
    await expect(db.update("notes", s.m.id, { ownerId: "alice" })).rejects.toThrow(/access denied: notes.ownerId/);
    expect((await db.update("notes", s.m.id, { title: "t" })).title).toBe("t");
    expect((await db.update("notes", s.m.id, { body: "b2" })).body).toBe("b2");
  });

  test("compileAcl refuses a check on a read or delete policy", () => {
    expect(() => compileAcl([role("r", [policy("x", "notes", "read", { check: { ownerId: "a" } })])])).toThrow(/check/);
    expect(() => compileAcl([role("r", [policy("x", "notes", "delete", { check: { ownerId: "a" } })])])).toThrow(/check/);
  });
});

// D1 runs the pre-image read and the UPDATE as two autocommitting statements. Park one
// request right before its UPDATE, let another change the row, then release it.
describe("D1 race: a cell-level update grant is re-asserted in the UPDATE", () => {
  const postSchema = defineSchema({ posts: Entity((t) => ({ id: t.id(), status: t.text(), ownerId: t.text(), body: t.text() })) });

  function parking(base: Driver) {
    let gate: { re: RegExp; hit: () => void; wait: Promise<void> } | null = null;
    const view: Driver = {
      dialect: base.dialect,
      batch: base.batch?.bind(base),
      transaction: (fn) => fn(),
      async exec(sql, params) {
        if (gate && gate.re.test(sql)) {
          const g = gate;
          gate = null;
          g.hit();
          await g.wait;
        }
        return base.exec(sql, params);
      },
    };
    const arm = (re: RegExp) => {
      let hit!: () => void;
      let release!: () => void;
      const hitP = new Promise<void>((r) => (hit = r));
      const wait = new Promise<void>((r) => (release = r));
      gate = { re, hit, wait };
      return { hit: hitP, release };
    };
    return { view, arm };
  }

  async function race(authorUpdate: object) {
    const acl = compileAcl([
      role("author", [policy("a:read", "posts", "read", {}), policy("a:update", "posts", "update", authorUpdate)]),
      role("editor", [policy("e:read", "posts", "read", {}), policy("e:update", "posts", "update", {})]),
    ]);
    const base = bunSqliteDriver(new Database(":memory:"));
    await migrate(base, postSchema);
    await base.exec(`INSERT INTO posts (id, status, ownerId, body) VALUES (1, 'draft', 'au', 'v1')`, []);
    const p = parking(base);
    const author = new Db(p.view, { acl, identity: { userId: "au", roles: ["author"] }, schema: postSchema }, postSchema) as any;
    const editor = new Db(base, { acl, identity: { userId: "ed", roles: ["editor"] }, schema: postSchema }, postSchema) as any;
    const read = async () => (await base.exec("SELECT status, ownerId, body FROM posts WHERE id = 1", []))[0];
    return { author, editor, read, arm: p.arm };
  }

  test("conditionalFields { status: 'draft' }: the body write does not land after publish", async () => {
    const r = await race({ fields: [], conditionalFields: [{ when: { status: "draft" }, fields: ["body"] }] });
    const g = r.arm(/^UPDATE "posts"/);
    const pending = r.author.update("posts", 1, { body: "unreviewed" });
    await g.hit;
    await r.editor.update("posts", 1, { status: "published", body: "reviewed" });
    g.release();
    await expect(pending).rejects.toThrow(/access denied: posts.body/); // re-evaluated on the fresh row
    expect(await r.read()).toEqual({ status: "published", ownerId: "au", body: "reviewed" });
  });

  test("fieldsFn owner gate: the previous owner's write does not land after reassignment", async () => {
    const r = await race({ fields: [], fieldsFn: (identity: any, row: any) => (row.ownerId === identity?.userId ? ["body"] : []) });
    const g = r.arm(/^UPDATE "posts"/);
    const pending = r.author.update("posts", 1, { body: "by-previous-owner" });
    await g.hit;
    await r.editor.update("posts", 1, { ownerId: "someone-else", body: "new-owner-body" });
    g.release();
    await expect(pending).rejects.toThrow(/access denied: posts.body/);
    expect(await r.read()).toEqual({ status: "draft", ownerId: "someone-else", body: "new-owner-body" });
  });

  test("a race the grant survives still applies the write (re-evaluated, not refused)", async () => {
    const r = await race({ fields: [], conditionalFields: [{ when: { status: "draft" }, fields: ["body"] }] });
    const g = r.arm(/^UPDATE "posts"/);
    const pending = r.author.update("posts", 1, { body: "mine" });
    await g.hit;
    await r.editor.update("posts", 1, { ownerId: "co-author" }); // touches no input of the grant
    g.release();
    expect((await pending).body).toBe("mine");
    expect(await r.read()).toEqual({ status: "draft", ownerId: "co-author", body: "mine" });
  });
});
