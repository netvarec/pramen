// Unit tests for the confirmed security/correctness fixes in the Db read/write
// engine, ACL resolver, and read-engine — driven directly over a bun:sqlite Driver
// (no server). Covers: C1 marker-operator injection, H1 relation-where nested
// AND/OR field check, H2 relation-load hidden leak, H3 aggregate hidden leak, H4
// null-aware keyset pagination, H5 hasMany custom-PK join, H6 relation-traversal
// touched-set, M9 orderBy-hidden leak, and boolean read-decode.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, hidden } from "../packages/server/src/sdk/schema";
import { $input, allow, policy, role, type Identity } from "../packages/server/src/sdk/acl";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

// --- C1: an $input/$identity marker in a bare-value position must only ever be an
// equality; a caller-supplied operator object must NOT become an operator predicate. ---
describe("C1: capability read can't be enumerated via operator injection", () => {
  const schema = defineSchema({
    signups: Entity((t) => ({ id: t.id(), email: t.text(), code: t.text(), status: t.text() })),
  });
  // anonymous may read a signup ONLY by presenting the exact code (a capability read).
  const roles = [role("anonymous", [policy("cap", "signups", "read", { where: { code: $input("code") } })])];

  async function seed(input: unknown) {
    const sqlite = new Database(":memory:");
    const driver = bunSqliteDriver(sqlite);
    await migrate(driver, schema);
    // seed two rows under SYSTEM
    const sys = new Db(driver, { acl: compileAcl(roles), identity: null, schema, system: true }, schema);
    await sys.insert("signups", { email: "a@example.com", code: "cap-aaa", status: "pending" });
    await sys.insert("signups", { email: "b@example.com", code: "cap-bbb", status: "pending" });
    const anon = new Db(driver, { acl: compileAcl(roles), identity: null, schema, input, partition: undefined }, schema);
    return anon;
  }

  test("correct code returns exactly its row", async () => {
    const db = await seed({ code: "cap-aaa" });
    const rows = (await db.find({ from: "signups", where: {} })) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("a@example.com");
  });

  test("operator-object injection {gte:''} enumerates nothing", async () => {
    const db = await seed({ code: { gte: "" } });
    const rows = (await db.find({ from: "signups", where: {} })) as any[];
    expect(rows).toHaveLength(0); // was: returned an arbitrary row (full-table enumeration)
  });

  test("missing code enumerates nothing", async () => {
    const db = await seed({});
    const rows = (await db.find({ from: "signups", where: {} })) as any[];
    expect(rows).toHaveLength(0);
  });
});

// --- Relations: H1 (nested AND/OR field check), H2 (hidden leak), H5 (custom PK),
// H6 (touched read-set). ---
describe("relation-scoped reads", () => {
  const schema = defineSchema({
    users: Entity((t) => ({ id: t.textId(), name: t.text(), secret: hidden(t.text()) })),
    posts: Entity(
      (t) => ({ id: t.id(), title: t.text(), authorId: t.text() }),
      (r) => ({ author: r.belongsTo("users", "authorId") }),
    ),
  });

  // reader: full read of posts; users readable but only name (secret is hidden anyway).
  const reader = [
    role("reader", [
      policy("p:read", "posts", "read", allow()),
      policy("u:read", "users", "read", { fields: ["id", "name"] }),
    ]),
  ];
  const ident: Identity = { userId: "r", roles: ["reader"] };

  async function seed(rolesList: any[]) {
    const sqlite = new Database(":memory:");
    const driver = bunSqliteDriver(sqlite);
    await migrate(driver, schema);
    const sys = new Db(driver, { acl: compileAcl(rolesList), identity: null, schema, system: true }, schema);
    await sys.insert("users", { id: "u1", name: "Alice", secret: "s3cr3t" });
    await sys.insert("posts", { title: "hello", authorId: "u1" });
    return driver;
  }

  test("H1: relation-where filtering a non-readable column inside nested AND → 403", async () => {
    const driver = await seed(reader);
    const db = new Db(driver, { acl: compileAcl(reader), identity: ident, schema, partition: undefined }, schema);
    // a readable nested column is fine
    await db.find({ from: "posts", where: { author: { AND: [{ name: "Alice" }] } } });
    // ...but a non-readable/hidden column inside the AND must be rejected (was an oracle)
    await expect(
      db.find({ from: "posts", where: { author: { AND: [{ secret: { like: "s%" } }] } } }),
    ).rejects.toThrow(/access denied/);
    // and inside a nested OR
    await expect(
      db.find({ from: "posts", where: { author: { OR: [{ name: "Alice" }, { secret: "x" }] } } }),
    ).rejects.toThrow(/access denied/);
  });

  test("H2: belongsTo eager-load does not leak the target's hidden column", async () => {
    // full allow() on users → scope.fields === null (the path that skipped stripHidden)
    const roles = [
      role("reader", [policy("p:read", "posts", "read", allow()), policy("u:read", "users", "read", allow())]),
    ];
    const driver = await seed(roles);
    const db = new Db(driver, { acl: compileAcl(roles), identity: ident, schema, partition: undefined }, schema);
    const rows = (await db.find({ from: "posts", with: { author: true } })) as any[];
    expect(rows[0].author.name).toBe("Alice");
    expect("secret" in rows[0].author).toBe(false);
  });

  test("H6: relation-traversal where records the traversed table in touched", async () => {
    const driver = await seed(reader);
    const db = new Db(driver, { acl: compileAcl(reader), identity: ident, schema, partition: undefined }, schema);
    await db.find({ from: "posts", where: { author: { name: "Alice" } } });
    expect(db.touched.has("posts")).toBe(true);
    expect(db.touched.has("users")).toBe(true); // was missing → live-query under-invalidation
  });
});

describe("H5: hasMany eager-load over a non-`id` parent PK", () => {
  const schema = defineSchema({
    orgs: Entity(
      (t) => ({ slug: t.textId(), name: t.text() }),
      (r) => ({ members: r.hasMany("members", "orgSlug") }),
    ),
    members: Entity((t) => ({ id: t.textId(), orgSlug: t.text() })),
  });
  const roles = [
    role("admin", [
      policy("o:r", "orgs", "read", allow()),
      policy("o:c", "orgs", "create", allow()),
      policy("m:r", "members", "read", allow()),
      policy("m:c", "members", "create", allow()),
    ]),
  ];
  const admin: Identity = { userId: "a", roles: ["admin"] };

  test("members load keyed by the parent PK (slug), not a hardcoded id", async () => {
    const sqlite = new Database(":memory:");
    const driver = bunSqliteDriver(sqlite);
    await migrate(driver, schema);
    const db = new Db(driver, { acl: compileAcl(roles), identity: admin, schema, partition: undefined }, schema);
    await db.insert("orgs", { slug: "acme", name: "Acme" });
    await db.insert("members", { id: "m1", orgSlug: "acme" });
    await db.insert("members", { id: "m2", orgSlug: "acme" });
    const rows = (await db.find({ from: "orgs", with: { members: true } })) as any[];
    expect(rows[0].members).toHaveLength(2); // was [] (joined on undefined r.id)
  });
});

describe("H3 + M9: hidden columns are non-aggregatable and non-orderable", () => {
  const schema = defineSchema({
    accounts: Entity((t) => ({ id: t.id(), name: t.text(), balance: t.int(), secret: hidden(t.int()) })),
  });
  const roles = [
    role("admin", [policy("a:r", "accounts", "read", allow()), policy("a:c", "accounts", "create", allow())]),
  ];
  const admin: Identity = { userId: "a", roles: ["admin"] };

  async function seed() {
    const sqlite = new Database(":memory:");
    const driver = bunSqliteDriver(sqlite);
    await migrate(driver, schema);
    const db = new Db(driver, { acl: compileAcl(roles), identity: admin, schema, partition: undefined }, schema);
    await db.insert("accounts", { name: "x", balance: 10, secret: 42 });
    return db;
  }

  test("H3: aggregate max/min/groupBy over a hidden column → 403 (even under full read)", async () => {
    const db = await seed();
    await expect(db.aggregate({ from: "accounts", aggregations: { m: { fn: "max", column: "secret" } } })).rejects.toThrow(
      /access denied/,
    );
    await expect(db.aggregate({ from: "accounts", groupBy: "secret", aggregations: { n: { fn: "count" } } })).rejects.toThrow(
      /access denied/,
    );
    // a non-hidden aggregate still works
    const ok = (await db.aggregate({ from: "accounts", aggregations: { m: { fn: "max", column: "balance" } } })) as any[];
    expect(Number(ok[0].m)).toBe(10);
  });

  test("M9: orderBy / page over a hidden column → 403", async () => {
    const db = await seed();
    await expect(db.find({ from: "accounts", orderBy: { column: "secret" } as any })).rejects.toThrow(/access denied/);
    await expect(db.page({ from: "accounts", orderBy: { column: "secret" } as any })).rejects.toThrow(/access denied/);
  });
});

describe("H4: keyset pagination over a nullable order column terminates", () => {
  const schema = defineSchema({
    items: Entity((t) => ({ id: t.id(), score: t.int() })),
  });
  const roles = [role("admin", [policy("i:r", "items", "read", allow()), policy("i:c", "items", "create", allow())])];
  const admin: Identity = { userId: "a", roles: ["admin"] };

  async function seed() {
    const sqlite = new Database(":memory:");
    const driver = bunSqliteDriver(sqlite);
    await migrate(driver, schema);
    const db = new Db(driver, { acl: compileAcl(roles), identity: admin, schema, partition: undefined }, schema);
    // scores with NULLs interspersed
    for (const s of [null, 5, null, 3, 8, null, 1]) await db.insert("items", { score: s });
    return db;
  }

  async function walk(db: Db, dir: "asc" | "desc"): Promise<number[]> {
    const seen: number[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const pageRes: any = await db.page({ from: "items", orderBy: { column: "score", dir } as any, limit: 2, after });
      for (const it of pageRes.items) seen.push(it.id);
      if (!pageRes.hasMore) return seen;
      after = pageRes.cursor;
    }
    throw new Error("pagination did not terminate (infinite loop over NULL order key)");
  }

  test("ASC walk visits every row exactly once and terminates", async () => {
    const db = await seed();
    const ids = await walk(db, "asc");
    expect(ids.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(ids).size).toBe(7); // no duplicates
  });

  test("DESC walk visits every row exactly once and terminates", async () => {
    const db = await seed();
    const ids = await walk(db, "desc");
    expect(new Set(ids).size).toBe(7);
    expect(ids.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("boolean columns decode to true/false on read", () => {
  const schema = defineSchema({
    flags: Entity((t) => ({ id: t.id(), name: t.text(), on: t.bool() })),
  });
  const roles = [role("admin", [policy("f:r", "flags", "read", allow()), policy("f:c", "flags", "create", allow())])];
  const admin: Identity = { userId: "a", roles: ["admin"] };

  test("insert echo + read yield booleans, and WHERE on a bool still matches", async () => {
    const sqlite = new Database(":memory:");
    const driver = bunSqliteDriver(sqlite);
    await migrate(driver, schema);
    const db = new Db(driver, { acl: compileAcl(roles), identity: admin, schema, partition: undefined }, schema);
    const created = (await db.insert("flags", { name: "a", on: true })) as any;
    expect(created.on).toBe(true); // not 1
    await db.insert("flags", { name: "b", on: false });

    const rows = (await db.find({ from: "flags", orderBy: { column: "id" } as any })) as any[];
    expect(rows.map((r) => r.on)).toEqual([true, false]);

    // WHERE on a bool column still works (write-side encodes true→1)
    const onlyOn = (await db.find({ from: "flags", where: { on: true } })) as any[];
    expect(onlyOn).toHaveLength(1);
    expect(onlyOn[0].name).toBe("a");
  });
});
