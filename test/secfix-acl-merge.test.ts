// OR-merged grants keep each policy's fields bound to the rows THAT policy admits.
// Before: merging "own rows, all fields" (author) with "every row, public fields"
// (reader/user) produced "every row, all fields", which no single grant allows, on read,
// on write, and through a directAccess relation grant. Driven with the REAL example app's
// schema, ACL and handlers over an in-memory bun:sqlite store. Dummy data only.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { app } from "../example/app";
import { Entity, defineSchema } from "../packages/server/src/sdk/schema";
import { $identity, allow, policy, role, type Identity } from "../packages/server/src/sdk/acl";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { ensureOutbox } from "../packages/server/src/runtime/outbox";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = app.schema as any;
const acl = compileAcl(app.acl as any);
type Run = { run: (ctx: unknown, input: unknown) => Promise<unknown> };
const h = app.handlers as unknown as Record<string, Run>;

async function setup() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  await ensureOutbox(driver);
  const sys = new Db(driver, { acl, identity: null, schema, system: true } as any, schema) as any;
  await sys.insert("users", { id: "alice", name: "Alice", email: "alice@example.test" });
  await sys.insert("users", { id: "mallory", name: "Mallory", email: "mallory@example.test" });
  const a = await sys.insert("notes", { title: "alice-note", body: "ALICE-PRIVATE-BODY", ownerId: "alice", createdAt: 1 });
  const m = await sys.insert("notes", { title: "mal-note", body: "m-body", ownerId: "mallory", createdAt: 2 });
  const dbAs = (identity: Identity) => new Db(driver, { acl, identity, schema } as any, schema) as any;
  const ctx = (identity: Identity) => ({ db: dbAs(identity), identity, env: {}, kv: undefined, tasks: { enqueue: async () => {} } });
  const raw = async (id: number) => (await sys.find({ from: "notes", where: { id } }))[0];
  return { driver, sys, a, m, dbAs, ctx, raw };
}

const mallory = (...roles: string[]): Identity => ({ userId: "mallory", roles });

describe("read: merged grants do not pair one policy's fields with another's rows", () => {
  for (const combo of [["author", "reader"], ["author", "user"]]) {
    test(`${combo.join("+")}: alice's body stays hidden, mallory's own body stays visible`, async () => {
      const s = await setup();
      const rows = (await h.listNotes!.run(s.ctx(mallory(...combo)), {})) as any[];
      const alices = rows.find((r) => r.ownerId === "alice");
      const own = rows.find((r) => r.ownerId === "mallory");
      expect(alices).toBeDefined();
      expect("body" in alices).toBe(false);
      expect(alices.title).toBe("alice-note");
      expect(own.body).toBe("m-body");
    });
  }

  test("author+reader: body is not a filter, order or count oracle (it is not readable on every row)", async () => {
    const s = await setup();
    const db = s.dbAs(mallory("author", "reader"));
    await expect(db.count({ from: "notes", where: { body: { startsWith: "ALICE-" } } })).rejects.toThrow(/access denied/);
    await expect(db.find({ from: "notes", where: { body: "ALICE-PRIVATE-BODY" } })).rejects.toThrow(/access denied/);
    await expect(db.find({ from: "notes", orderBy: { column: "body" } })).rejects.toThrow(/access denied/);
    await expect(db.aggregate({ from: "notes", aggregations: { m: { fn: "max", column: "body" } } })).rejects.toThrow(/access denied/);
    // The shared public columns still work across every row.
    expect(await db.count({ from: "notes", where: { title: "alice-note" } })).toBe(1);
  });

  test("author+reader: a select of body is allowed but only yields it on mallory's own row", async () => {
    const s = await setup();
    const rows = (await s.dbAs(mallory("author", "reader")).find({ from: "notes", select: ["id", "body"], orderBy: { column: "id" } })) as any[];
    expect(rows).toEqual([{ id: s.a.id }, { id: s.m.id, body: "m-body" }]);
  });

  test("author+reader: directAccess on owner only reaches owners of notes the author policy admits", async () => {
    const s = await setup();
    const rows = (await h.listNotesWithOwner!.run(s.ctx(mallory("author", "reader")), {})) as any[];
    const alices = rows.find((r) => r.ownerId === "alice");
    const own = rows.find((r) => r.ownerId === "mallory");
    expect(alices.owner).toBeNull();
    expect(own.owner).toEqual({ id: "mallory", name: "Mallory" });
    // Control: reader alone has no path to users at all.
    await expect(h.listNotesWithOwner!.run(s.ctx(mallory("reader")), {})).rejects.toThrow(/access denied/);
  });
});

describe("write: merged update grants keep fields bound to rows", () => {
  test("author+teammate: body/ownerId on alice's note is 403, title still editable, row intact", async () => {
    const s = await setup();
    const c = s.ctx(mallory("author", "teammate"));
    await expect(h.updateNote!.run(c, { id: s.a.id, body: "OVERWRITTEN" })).rejects.toThrow(/access denied: notes.body/);
    await expect(h.updateNote!.run(c, { id: s.a.id, ownerId: "mallory" })).rejects.toThrow(/access denied/);
    const echo = (await h.updateNote!.run(c, { id: s.a.id, title: "renamed" })) as any;
    expect(echo.title).toBe("renamed");
    expect("body" in echo).toBe(false); // the echo is read-scoped too: alice's body never comes back
    const row = await s.raw(s.a.id);
    expect(row).toMatchObject({ title: "renamed", body: "ALICE-PRIVATE-BODY", ownerId: "alice" });
    // Own note: the author grant applies, body is writable.
    expect(((await h.updateNote!.run(c, { id: s.m.id, body: "mine" })) as any).body).toBe("mine");
  });
});

// A row-restricted grant whose `where` TRAVERSES a relation can't be evaluated in memory;
// the per-row binding is computed in SQL (a projected flag column) instead.
describe("relation-traversing admission in a merged scope", () => {
  const relSchema = defineSchema({
    teams: Entity((t) => ({ id: t.id(), name: t.text(), lead: t.text() })),
    docs: Entity(
      (t) => ({ id: t.id(), title: t.text(), secret: t.text(), teamId: t.int() }),
      (r) => ({ team: r.belongsTo("teams", "teamId") }),
    ),
  });
  const roles = [
    role("lead", [
      policy("l:teams", "teams", "read", allow()),
      policy("l:docs", "docs", "read", { where: { team: { lead: $identity("userId") } } }),
      policy("l:docs:u", "docs", "update", { where: { team: { lead: $identity("userId") } } }),
    ]),
    role("staff", [
      policy("s:docs", "docs", "read", { fields: ["id", "title", "teamId"] }),
      policy("s:docs:u", "docs", "update", { fields: ["title"] }),
    ]),
  ];
  async function relSetup() {
    const driver = bunSqliteDriver(new Database(":memory:"));
    await migrate(driver, relSchema);
    const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema: relSchema, system: true }, relSchema) as any;
    const mine = (await sys.insert("teams", { name: "mine", lead: "u1" })).id;
    const other = (await sys.insert("teams", { name: "other", lead: "u2" })).id;
    const d1 = (await sys.insert("docs", { title: "d1", secret: "S1", teamId: mine })).id;
    const d2 = (await sys.insert("docs", { title: "d2", secret: "S2", teamId: other })).id;
    const db = new Db(driver, { acl: compileAcl(roles), identity: { userId: "u1", roles: ["lead", "staff"] }, schema: relSchema }, relSchema) as any;
    return { sys, db, d1, d2 };
  }

  test("read: secret only on docs of the caller's own team", async () => {
    const { db, d1, d2 } = await relSetup();
    const rows = (await db.find({ from: "docs", orderBy: { column: "id" } })) as any[];
    expect(rows.find((r) => r.id === d1).secret).toBe("S1");
    expect("secret" in rows.find((r) => r.id === d2)).toBe(false);
    expect(Object.keys(rows[0]).some((k) => k.startsWith("__pramen"))).toBe(false); // flags never leak
  });

  test("write: secret writable only on own team's docs; echo respects the same binding", async () => {
    const { db, sys, d1, d2 } = await relSetup();
    await expect(db.update("docs", d2, { secret: "X" })).rejects.toThrow(/access denied: docs.secret/);
    expect(((await db.update("docs", d2, { title: "t2" })) as any).secret).toBeUndefined();
    expect(((await db.update("docs", d1, { secret: "S1b" })) as any).secret).toBe("S1b");
    expect((await sys.find({ from: "docs", where: { id: d2 } }))[0].secret).toBe("S2");
  });
});

describe("@pramen/auth admin + self on one identity", () => {
  test("self fields beyond the admin projection apply to the caller's own row only", async () => {
    const usersSchema = defineSchema({ accounts: Entity((t) => ({ username: t.textId(), email: t.text(), phone: t.text() })) });
    const roles = [
      role("admin", [policy("a", "accounts", "read", { fields: ["username", "email"] })]),
      role("self", [policy("s", "accounts", "read", { where: { username: $identity("userId") }, fields: ["username", "phone"] })]),
    ];
    const driver = bunSqliteDriver(new Database(":memory:"));
    await migrate(driver, usersSchema);
    const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema: usersSchema, system: true }, usersSchema) as any;
    await sys.insert("accounts", { username: "me", email: "me@x.test", phone: "111" });
    await sys.insert("accounts", { username: "you", email: "you@x.test", phone: "222" });
    const db = new Db(driver, { acl: compileAcl(roles), identity: { userId: "me", roles: ["admin", "self"] }, schema: usersSchema }, usersSchema) as any;
    const rows = (await db.find({ from: "accounts", orderBy: { column: "username" } })) as any[];
    expect(rows).toEqual([
      { username: "me", email: "me@x.test", phone: "111" },
      { username: "you", email: "you@x.test" },
    ]);
  });
});
