// Many-to-many via an explicit junction entity: `with` eager-load through the junction,
// `where` traversal through the junction (both owning + inverse sides), and the target's
// read scope applied during traversal. Driven directly over a bun:sqlite Driver.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema } from "../packages/server/src/sdk/schema";
import { allow, policy, role } from "../packages/server/src/sdk/acl";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = defineSchema({
  posts: Entity(
    (t) => ({ id: t.id(), title: t.text() }),
    (r) => ({ tags: r.manyToMany("tags", { through: "post_tags", sourceColumn: "postId", targetColumn: "tagId" }) }),
  ),
  tags: Entity(
    (t) => ({ id: t.id(), name: t.text() }),
    (r) => ({ posts: r.manyToMany("posts", { through: "post_tags", sourceColumn: "tagId", targetColumn: "postId" }) }),
  ),
  post_tags: Entity((t) => ({ id: t.id(), postId: t.int(), tagId: t.int() })),
});

async function seed() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
  const p1 = (await sys.insert("posts", { title: "Hello" })).id as number;
  const p2 = (await sys.insert("posts", { title: "World" })).id as number;
  const red = (await sys.insert("tags", { name: "red" })).id as number;
  const blue = (await sys.insert("tags", { name: "blue" })).id as number;
  for (const [postId, tagId] of [[p1, red], [p1, blue], [p2, red]]) await sys.insert("post_tags", { postId, tagId });
  return { driver, ids: { p1, p2, red, blue } };
}

const names = (r: any) => ((r.tags ?? []) as any[]).map((t) => t.name).sort();
const titles = (r: any) => ((r.posts ?? []) as any[]).map((p) => p.title).sort();

describe("many-to-many", () => {
  test("with: eager-loads the target list through the junction (owning side)", async () => {
    const { driver } = await seed();
    const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
    const rows = (await sys.find({ from: "posts", with: { tags: true }, orderBy: [{ column: "title" }] })) as any[];
    expect(rows.map((r) => r.title)).toEqual(["Hello", "World"]);
    expect(names(rows[0])).toEqual(["blue", "red"]); // Hello
    expect(names(rows[1])).toEqual(["red"]); // World
  });

  test("with: eager-loads the inverse side too", async () => {
    const { driver } = await seed();
    const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
    const rows = (await sys.find({ from: "tags", with: { posts: true }, orderBy: [{ column: "name" }] })) as any[];
    const byName = Object.fromEntries(rows.map((r) => [r.name, titles(r)]));
    expect(byName.red).toEqual(["Hello", "World"]);
    expect(byName.blue).toEqual(["Hello"]);
  });

  test("where: filters through the junction (owning side)", async () => {
    const { driver } = await seed();
    const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
    const rows = (await sys.find({ from: "posts", where: { tags: { name: "blue" } } })) as any[];
    expect(rows.map((r) => r.title)).toEqual(["Hello"]); // only Hello is tagged blue
  });

  test("where: filters through the junction (inverse side)", async () => {
    const { driver } = await seed();
    const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
    const rows = (await sys.find({ from: "tags", where: { posts: { title: "World" } }, orderBy: [{ column: "name" }] })) as any[];
    expect(rows.map((r) => r.name)).toEqual(["red"]); // only red tags World
  });

  test("with: an unreadable target drops out of the list (target scope applied in traversal)", async () => {
    const { driver } = await seed();
    // A role that can read posts + the junction, but only tags named 'red'.
    const roles = [
      role("viewer", [
        policy("p", "posts", "read", allow()),
        policy("j", "post_tags", "read", allow()),
        policy("t", "tags", "read", { where: { name: "red" } }),
      ]),
    ];
    const db = new Db(driver, { acl: compileAcl(roles), identity: { roles: ["viewer"] }, schema }, schema);
    const rows = (await db.find({ from: "posts", with: { tags: true }, orderBy: [{ column: "title" }] })) as any[];
    // "Hello" is tagged red+blue, but blue is not readable -> only red survives.
    expect(names(rows[0])).toEqual(["red"]);
    expect(names(rows[1])).toEqual(["red"]);
  });

  test("where: traversal respects the target's read scope (can't widen access)", async () => {
    const { driver } = await seed();
    const roles = [
      role("viewer", [
        policy("p", "posts", "read", allow()),
        policy("t", "tags", "read", { where: { name: "red" } }),
      ]),
    ];
    const db = new Db(driver, { acl: compileAcl(roles), identity: { roles: ["viewer"] }, schema }, schema);
    // Filtering by an unreadable tag ('blue') matches nothing, even though the link exists.
    const rows = (await db.find({ from: "posts", where: { tags: { name: "blue" } } })) as any[];
    expect(rows).toHaveLength(0);
  });
});
