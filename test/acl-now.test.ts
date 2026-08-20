// Unit tests for the $now() policy marker — a time-boxed row grant, driven directly
// over a bun:sqlite Driver (no server).
//
// The motivating case is scheduled publication: `{ publishedAt: { isNull: false } }`
// matches a FUTURE timestamp too, so a scheduled row would be public the moment it was
// saved. `{ publishedAt: { lte: $now() } }` is the predicate that actually holds it back.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema } from "../packages/server/src/sdk/schema";
import { $now, policy, role } from "../packages/server/src/sdk/acl";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = defineSchema({
  lectures: Entity((t) => ({ id: t.id(), title: t.text(), publishedAt: t.text() })),
});

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const HOUR = 3_600_000;

/** anonymous reads a lecture only once its publish instant has actually arrived. */
const timeBoxed = [role("anonymous", [policy("pub", "lectures", "read", { where: { publishedAt: { lte: $now() } } })])];

async function seed(roles: ReturnType<typeof role>[]) {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const sys = new Db(driver, { acl: compileAcl(roles), identity: null, schema, system: true }, schema);
  await sys.insert("lectures", { title: "past", publishedAt: iso(-HOUR) });
  await sys.insert("lectures", { title: "future", publishedAt: iso(HOUR) });
  await sys.insert("lectures", { title: "draft", publishedAt: null });
  return new Db(driver, { acl: compileAcl(roles), identity: null, schema, partition: undefined }, schema);
}

const titles = (rows: unknown[]) => (rows as { title: string }[]).map((r) => r.title).sort();

describe("$now() in a policy where", () => {
  test("a past publish instant is readable", async () => {
    const db = await seed(timeBoxed);
    expect(titles(await db.find({ from: "lectures", where: {} }))).toEqual(["past"]);
  });

  test("a scheduled (future) row stays hidden — the isNull:false gap", async () => {
    const db = await seed(timeBoxed);
    const rows = (await db.find({ from: "lectures", where: {} })) as { title: string }[];
    expect(rows.map((r) => r.title)).not.toContain("future");
  });

  test("an unpublished (null) row stays hidden", async () => {
    const db = await seed(timeBoxed);
    const rows = (await db.find({ from: "lectures", where: {} })) as { title: string }[];
    expect(rows.map((r) => r.title)).not.toContain("draft");
  });

  test("a caller cannot widen the grant by asking for the future row", async () => {
    const db = await seed(timeBoxed);
    const rows = await db.find({ from: "lectures", where: { title: "future" } });
    expect(rows).toHaveLength(0);
  });

  // Regression guard: NowMarker is an object whose only key is a symbol, so
  // Object.entries() on it is empty. Read as an operator map rather than a value it
  // would compile to NO predicate at all — every row public, silently.
  test("a bare-value $now() is an equality, not an empty operator map", async () => {
    const roles = [role("anonymous", [policy("exact", "lectures", "read", { where: { publishedAt: $now() } })])];
    const db = await seed(roles);
    expect(await db.find({ from: "lectures", where: {} })).toHaveLength(0);
  });
});
