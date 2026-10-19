// Filter oracles: a `where` is an oracle for every column it names, so it must only name
// columns the caller can read. Covers `hidden()` columns under allow()/SYSTEM, a relation
// filter's keys resolving to the PARENT's columns through SQL correlated-name resolution,
// and an `$input` capability grant fed a JSON null. Dummy data, in-memory bun:sqlite.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, hidden } from "../packages/server/src/sdk/schema";
import { $identity, $input, allow, policy, role, type Identity } from "../packages/server/src/sdk/acl";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = defineSchema({
  members: Entity(
    (t) => ({ id: t.textId(), label: t.text(), credential: hidden(t.text()) }),
    (r) => ({ docs: r.hasMany("docs", "memberId") }),
  ),
  docs: Entity(
    (t) => ({ id: t.id(), heading: t.text(), restricted: t.text(), memberId: t.text() }),
    (r) => ({ member: r.belongsTo("members", "memberId") }),
  ),
  links: Entity((t) => ({ id: t.id(), content: t.text(), capKey: t.text() })),
});

async function seed() {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema) as any;
  await sys.insert("members", { id: "m1", label: "One", credential: "pbkdf2$ZZDUMMY" });
  await sys.insert("members", { id: "m2", label: "Two", credential: "pbkdf2$AAOTHER" });
  await sys.insert("docs", { heading: "d1", restricted: "RESTRICTED-VALUE-1", memberId: "m1" });
  await sys.insert("docs", { heading: "d2", restricted: "other", memberId: "m2" });
  await sys.insert("links", { content: "shared-dummy", capKey: "cap-unguessable-123" });
  await sys.insert("links", { content: "unshared-dummy", capKey: null });
  return { driver, sys };
}
const mk = (driver: any, roles: any[], identity: Identity | null, input?: unknown) =>
  new Db(driver, { acl: compileAcl(roles), identity, schema, input: input as any }, schema) as any;

describe("hidden() columns are never filterable", () => {
  const roles = [role("viewer", [policy("m", "members", "read", allow()), policy("d", "docs", "read", allow())])];
  const who: Identity = { userId: "v", roles: ["viewer"] };

  test("under allow(): top level, nested in AND/OR/NOT, and through a relation", async () => {
    const { driver } = await seed();
    const db = mk(driver, roles, who);
    await expect(db.count({ from: "members", where: { credential: { startsWith: "pbkdf2$ZZ" } } })).rejects.toThrow(/access denied: members.credential/);
    await expect(db.count({ from: "members", where: { credential: { gte: "pbkdf2$Z" } } })).rejects.toThrow(/access denied/);
    await expect(db.count({ from: "members", where: { OR: [{ NOT: { credential: { lt: "pbkdf2$ZZD" } } }] } })).rejects.toThrow(/access denied/);
    await expect(db.find({ from: "members", where: { AND: [{ label: "One" }, { credential: "x" }] } })).rejects.toThrow(/access denied/);
    await expect(db.find({ from: "docs", where: { member: { credential: { startsWith: "pbkdf2$ZZDU" } } } })).rejects.toThrow(/access denied: members.credential/);
    // A readable column still filters normally.
    expect(await db.count({ from: "members", where: { label: "One" } })).toBe(1);
  });

  test("under SYSTEM too, like orderBy/select/aggregate", async () => {
    const { sys } = await seed();
    await expect(sys.count({ from: "members", where: { credential: { like: "pbkdf2$ZZ%" } } })).rejects.toThrow(/access denied/);
    await expect(sys.find({ from: "docs", where: { member: { credential: "pbkdf2$ZZDUMMY" } } })).rejects.toThrow(/access denied/);
  });

  test("an undeclared key is a 400, not an SQL error or an outer-row binding", async () => {
    const { driver, sys } = await seed();
    const db = mk(driver, roles, who);
    await expect(db.find({ from: "members", where: { nope: 1 } })).rejects.toThrow(/unknown column: members.nope/);
    await expect(sys.find({ from: "members", where: { nope: 1 } })).rejects.toThrow(/unknown column/);
  });
});

describe("relation filter keys address the TARGET only", () => {
  test("a key only the parent has (field-denied there) is rejected, not bound to the parent row", async () => {
    const { driver } = await seed();
    const roles = [role("viewer", [policy("d", "docs", "read", { fields: ["id", "heading", "memberId"] }), policy("m", "members", "read", allow())])];
    const db = mk(driver, roles, { userId: "v", roles: ["viewer"] });
    await expect(db.find({ from: "docs", where: { restricted: { startsWith: "RESTR" } } })).rejects.toThrow(/access denied/);
    await expect(db.find({ from: "docs", where: { member: { restricted: { startsWith: "RESTRICTED-V" } } } })).rejects.toThrow(/unknown column: members.restricted/);
  });

  test("the parent's hidden column can't be reached through a hasMany filter either", async () => {
    const { driver } = await seed();
    const roles = [role("v2", [policy("m", "members", "read", { fields: ["id", "label"] }), policy("d", "docs", "read", allow())])];
    const db = mk(driver, roles, { userId: "v", roles: ["v2"] });
    await expect(db.find({ from: "members", where: { docs: { credential: { startsWith: "pbkdf2$ZZ" } } } })).rejects.toThrow(/unknown column: docs.credential/);
  });

  test("inner columns are qualified in SQL, so even a trusted policy can't bind to the outer row", async () => {
    // A policy (trusted, unchecked) naming a parent-only column inside a relation filter:
    // with qualified inner references this is an SQL error, never a silent outer-row filter.
    const { driver } = await seed();
    const roles = [role("p", [policy("d", "docs", "read", { where: { member: { restricted: "RESTRICTED-VALUE-1" } } }), policy("m", "members", "read", allow())])];
    const db = mk(driver, roles, { userId: "v", roles: ["p"] });
    await expect(db.find({ from: "docs" })).rejects.toThrow(/no such column/);
  });
});

describe("$input / $identity markers never resolve to null or a non-scalar", () => {
  const bare = [role("anonymous", [policy("l", "links", "read", { where: { capKey: $input("key") } })])];
  const op = [role("anonymous", [policy("l", "links", "read", { where: { capKey: { eq: $input("key") } } })])];
  const list = [role("anonymous", [policy("l", "links", "read", { where: { capKey: { in: $input("keys") } } })])];
  const q = async (driver: any, roles: any[], input: unknown) =>
    ((await mk(driver, roles, null, input).find({ from: "links" })) as any[]).map((r) => r.content);

  test("bare and operator forms: null matches nothing (not IS NULL), the key still works", async () => {
    const { driver } = await seed();
    for (const roles of [bare, op]) {
      expect(await q(driver, roles, { key: "cap-unguessable-123" })).toEqual(["shared-dummy"]);
      expect(await q(driver, roles, { key: null })).toEqual([]);
      expect(await q(driver, roles, {})).toEqual([]);
      expect(await q(driver, roles, { key: { gte: "" } })).toEqual([]);
      expect(await q(driver, roles, { key: ["cap-unguessable-123"] })).toEqual([]);
    }
  });

  test("an in-list marker must be a list of scalars", async () => {
    const { driver } = await seed();
    expect(await q(driver, list, { keys: ["cap-unguessable-123"] })).toEqual(["shared-dummy"]);
    expect(await q(driver, list, { keys: [null] })).toEqual([]);
    expect(await q(driver, list, { keys: [{ gte: "" }] })).toEqual([]);
    expect(await q(driver, list, { keys: "cap-unguessable-123" })).toEqual([]);
  });

  test("an identity claim that is null resolves the same way", async () => {
    const { driver } = await seed();
    const roles = [role("r", [policy("l", "links", "read", { where: { capKey: $identity("cap") } })])];
    const rows = (await mk(driver, roles, { roles: ["r"], cap: null } as any).find({ from: "links" })) as any[];
    expect(rows).toEqual([]);
  });
});
