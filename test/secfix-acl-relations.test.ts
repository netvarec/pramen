// Relation traversal never widens a direct read. A join is a read of its join column (a
// field-denied, cell-conditional or hidden FK must not link rows through `with` or `where`,
// at any hop), and a manyToMany traversal goes through the junction's own read scope.
// Dummy data, in-memory bun:sqlite.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, hidden } from "../packages/server/src/sdk/schema";
import { $identity, allow, policy, role } from "../packages/server/src/sdk/acl";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = defineSchema({
  users: Entity(
    (t) => ({ id: t.id(), name: t.text() }),
    (r) => ({
      posts: r.hasMany("posts", "authorId"),
      groups: r.manyToMany("groups", { through: "memberships", sourceColumn: "userId", targetColumn: "groupId" }),
    }),
  ),
  posts: Entity(
    (t) => ({ id: t.id(), title: t.text(), anonymous: t.bool(), authorId: t.int(), reviewerId: hidden(t.int()) }),
    (r) => ({ author: r.belongsTo("users", "authorId"), reviewer: r.belongsTo("users", "reviewerId") }),
  ),
  comments: Entity((t) => ({ id: t.id(), body: t.text(), postId: t.int() }), (r) => ({ post: r.belongsTo("posts", "postId") })),
  groups: Entity(
    (t) => ({ id: t.id(), name: t.text() }),
    (r) => ({ members: r.manyToMany("users", { through: "memberships", sourceColumn: "groupId", targetColumn: "userId" }) }),
  ),
  memberships: Entity((t) => ({ id: t.id(), userId: t.int(), groupId: t.int() })),
});

async function seed() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema) as any;
  const alice = (await sys.insert("users", { name: "alice" })).id as number;
  const bob = (await sys.insert("users", { name: "bob" })).id as number;
  const p1 = (await sys.insert("posts", { title: "signed", anonymous: false, authorId: alice, reviewerId: bob })).id;
  const p2 = (await sys.insert("posts", { title: "whistleblow", anonymous: true, authorId: bob, reviewerId: alice })).id;
  await sys.insert("comments", { body: "c-on-signed", postId: p1 });
  await sys.insert("comments", { body: "c-on-whistle", postId: p2 });
  const g = (await sys.insert("groups", { name: "support-group" })).id as number;
  await sys.insert("memberships", { userId: bob, groupId: g });
  return { driver, sys, alice, bob, g };
}
const mk = (driver: any, r: any, identity: any) => new Db(driver, { acl: compileAcl([r]), identity, schema }, schema) as any;

const viewerFieldDenied = () =>
  role("viewer", [
    policy("p", "posts", "read", { fields: ["id", "title", "anonymous"] }),
    policy("u", "users", "read", allow()),
    policy("c", "comments", "read", allow()),
  ]);
const viewerConditional = () =>
  role("viewer", [
    policy("p", "posts", "read", { fields: ["id", "title", "anonymous"], conditionalFields: [{ fields: ["authorId"], when: { anonymous: false } }] }),
    policy("u", "users", "read", allow()),
  ]);
const viewerAll = () => role("viewer", [policy("p", "posts", "read", allow()), policy("u", "users", "read", allow())]);

const byTitle = (rows: any[], title: string) => rows.find((r) => r.title === title);

describe("field-denied FK", () => {
  test("controls: a direct read of authorId is denied", async () => {
    const { driver, bob } = await seed();
    const db = mk(driver, viewerFieldDenied(), { roles: ["viewer"], userId: 99 });
    await expect(db.find({ from: "posts", where: { authorId: bob } })).rejects.toThrow(/access denied: posts.authorId/);
    await expect(db.find({ from: "posts", select: ["authorId"] })).rejects.toThrow(/access denied/);
  });

  test("belongsTo: `with` attaches no author, `where` through it is 403", async () => {
    const { driver, bob } = await seed();
    const db = mk(driver, viewerFieldDenied(), { roles: ["viewer"], userId: 99 });
    const rows = await db.find({ from: "posts", with: { author: true }, orderBy: { column: "id" } });
    expect(rows.map((r: any) => r.author)).toEqual([null, null]);
    await expect(db.find({ from: "posts", where: { author: { id: bob } } })).rejects.toThrow(/access denied: posts.authorId/);
  });

  test("hasMany: `with` groups nothing, `where` through it is 403", async () => {
    const { driver } = await seed();
    const db = mk(driver, viewerFieldDenied(), { roles: ["viewer"], userId: 99 });
    const users = await db.find({ from: "users", with: { posts: true }, orderBy: { column: "id" } });
    expect(users.map((u: any) => u.posts)).toEqual([[], []]);
    await expect(db.find({ from: "users", where: { posts: { title: "whistleblow" } } })).rejects.toThrow(/access denied: posts.authorId/);
  });

  test("nested hop: a readable first FK does not launder a denied second one", async () => {
    const { driver, bob } = await seed();
    const db = mk(driver, viewerFieldDenied(), { roles: ["viewer"], userId: 99 });
    await expect(db.find({ from: "comments", where: { post: { author: { id: bob } } } })).rejects.toThrow(/access denied: posts.authorId/);
    // The first hop alone (comments.postId is readable) still works.
    const rows = await db.find({ from: "comments", where: { post: { title: "signed" } } });
    expect(rows.map((r: any) => r.body)).toEqual(["c-on-signed"]);
  });
});

describe("cell-conditional FK", () => {
  test("`with` attaches the author only on the row whose grant exposes authorId", async () => {
    const { driver, alice } = await seed();
    const db = mk(driver, viewerConditional(), { roles: ["viewer"], userId: 99 });
    const rows = await db.find({ from: "posts", with: { author: true }, orderBy: { column: "id" } });
    expect(byTitle(rows, "signed").author).toEqual({ id: alice, name: "alice" });
    expect(byTitle(rows, "whistleblow").author).toBeNull();
    expect("authorId" in byTitle(rows, "whistleblow")).toBe(false);
  });

  test("hasMany groups only target rows whose FK is readable on that row", async () => {
    const { driver, alice, bob } = await seed();
    const db = mk(driver, viewerConditional(), { roles: ["viewer"], userId: 99 });
    const users = await db.find({ from: "users", with: { posts: true }, orderBy: { column: "id" } });
    expect(users.find((u: any) => u.id === alice).posts.map((p: any) => p.title)).toEqual(["signed"]);
    expect(users.find((u: any) => u.id === bob).posts).toEqual([]);
  });
});

describe("hidden FK", () => {
  test("never traverses: `with`, `where` (top level and nested), even under allow()", async () => {
    const { driver, alice } = await seed();
    const db = mk(driver, viewerAll(), { roles: ["viewer"], userId: 99 });
    await expect(db.find({ from: "posts", where: { reviewerId: alice } })).rejects.toThrow(/access denied: posts.reviewerId/);
    const rows = await db.find({ from: "posts", with: { reviewer: true }, orderBy: { column: "id" } });
    expect(rows.map((r: any) => r.reviewer)).toEqual([null, null]);
    await expect(db.find({ from: "posts", where: { reviewer: { id: alice } } })).rejects.toThrow(/access denied: posts.reviewerId/);
    await expect(db.find({ from: "users", where: { posts: { reviewer: { id: alice } } } })).rejects.toThrow(/access denied: posts.reviewerId/);
    await expect(db.find({ from: "users", where: { posts: { reviewerId: alice } } })).rejects.toThrow(/access denied/);
  });

  test("not even under SYSTEM, while a readable FK still does", async () => {
    const { sys, alice, bob } = await seed();
    const rows = await sys.find({ from: "posts", with: { reviewer: true, author: true }, orderBy: { column: "id" } });
    expect(rows.map((r: any) => r.reviewer)).toEqual([null, null]);
    expect(rows.map((r: any) => r.author.id)).toEqual([alice, bob]);
  });
});

describe("legitimate traversal keeps working", () => {
  test("readable FKs join in both directions and through a nested hop", async () => {
    const { driver, alice, bob } = await seed();
    const db = mk(driver, viewerAll(), { roles: ["viewer"], userId: 99 });
    const posts = await db.find({ from: "posts", with: { author: true }, orderBy: { column: "id" } });
    expect(posts.map((p: any) => p.author.name)).toEqual(["alice", "bob"]);
    const users = await db.find({ from: "users", with: { posts: true }, orderBy: { column: "id" } });
    expect(users.find((u: any) => u.id === alice).posts.map((p: any) => p.title)).toEqual(["signed"]);
    const viaNested = await db.find({ from: "users", where: { posts: { author: { name: "bob" } } } });
    expect(viaNested.map((u: any) => u.id)).toEqual([bob]);
  });

  test("a target whose read fields omit its PK still attaches through a belongsTo", async () => {
    const { driver } = await seed();
    const pkless = role("pk", [policy("p", "posts", "read", allow()), policy("u", "users", "read", { fields: ["name"] })]);
    const rows = await mk(driver, pkless, { roles: ["pk"] }).find({ from: "posts", with: { author: true }, orderBy: { column: "id" } });
    expect(rows.map((r: any) => r.author)).toEqual([{ name: "alice" }, { name: "bob" }]);
  });
});

describe("manyToMany goes through the junction's read scope", () => {
  const memberOwn = () =>
    role("member", [
      policy("g", "groups", "read", allow()),
      policy("u", "users", "read", allow()),
      policy("m", "memberships", "read", { where: { userId: $identity("userId") } }),
    ]);
  const memberNone = () => role("nj", [policy("g", "groups", "read", allow()), policy("u", "users", "read", allow())]);

  test("own-only junction scope: other users' memberships are invisible to `with` and `where`", async () => {
    const { driver, alice, bob, g } = await seed();
    const asAlice = mk(driver, memberOwn(), { roles: ["member"], userId: alice });
    expect(await asAlice.find({ from: "memberships" })).toEqual([]);
    expect((await asAlice.find({ from: "groups", with: { members: true } }))[0].members).toEqual([]);
    expect(await asAlice.find({ from: "users", where: { groups: { id: g } } })).toEqual([]);
    // Bob reads his own membership both ways.
    const asBob = mk(driver, memberOwn(), { roles: ["member"], userId: bob });
    expect((await asBob.find({ from: "groups", with: { members: true } }))[0].members.map((u: any) => u.id)).toEqual([bob]);
    expect((await asBob.find({ from: "users", where: { groups: { id: g } } })).map((u: any) => u.id)).toEqual([bob]);
  });

  test("no junction grant: traversal matches nothing", async () => {
    const { driver, alice, g } = await seed();
    const db = mk(driver, memberNone(), { roles: ["nj"], userId: alice });
    await expect(db.find({ from: "memberships" })).rejects.toThrow(/access denied/);
    expect((await db.find({ from: "groups", with: { members: true } }))[0].members).toEqual([]);
    expect(await db.find({ from: "users", where: { groups: { id: g } } })).toEqual([]);
  });

  test("SYSTEM and a full junction grant traverse normally", async () => {
    const { driver, sys, bob, g } = await seed();
    expect((await sys.find({ from: "groups", with: { members: true } }))[0].members.map((u: any) => u.id)).toEqual([bob]);
    const full = role("full", [policy("g", "groups", "read", allow()), policy("u", "users", "read", allow()), policy("m", "memberships", "read", allow())]);
    const db = mk(driver, full, { roles: ["full"], userId: 1 });
    expect((await db.find({ from: "users", where: { groups: { id: g } } })).map((u: any) => u.id)).toEqual([bob]);
  });
});
