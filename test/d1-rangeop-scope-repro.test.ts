// Repro + regression gate for issue #22 — "D1 store: find() with a range operator +
// ACL read scope hangs the worker". Reported as an apparent infinite loop / unbounded
// retry in the D1 scope-merge path (raw SQL instant, DO fine, D1 hangs ~25-30s).
//
// Investigation (see the memory / PR notes) established the pramen read path compiles
// to exactly ONE statement — no loop, no retry, no N+1; a real loop would hang the DO
// path too. What DID differ from the reporter's `SELECT id` probe is that pramen
// emitted `SELECT *`, fetching EVERY column (incl. a wide `json`/`text` payload) and
// projecting in JS — so on remote D1-over-RPC it ships all wide rows across the network
// before an unindexed `ORDER BY` filesort. This suite pins the fix:
//
//   1. Default column projection — the SELECT now names the caller's readable columns
//      (not `*`), so `hidden()` columns never cross RPC, and a FIELD-RESTRICTED caller
//      never ships columns it can't read.
//   2. `select:` clause — an all-fields-readable caller (exactly the reporter's shape,
//      where projection-to-readable can't drop a *readable* wide column) can now opt to
//      fetch only the columns it needs, keeping the wide payload off the wire.
//
// It runs over the same seam D1 uses (`sqliteDialect` Driver + Db + read-engine;
// `D1Driver.exec` is just prepare/bind/all over this identical SQL). CAVEAT: local
// SQLite (this harness AND miniflare) has no RPC, so it cannot reproduce the *remote*
// latency itself — it pins the mechanism and the SELECT shape, not the wall-clock hang.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, hidden } from "../packages/server/src/sdk/schema";
import { policy, role, type Identity } from "../packages/server/src/sdk/acl";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";
import type { Driver, Row } from "../packages/server/src/runtime/driver";
import type { Row } from "@pramen/server";

// Mirrors the issue's `lectures`: an UNINDEXED int timestamp, a bool the ACL scopes
// on, a wide readable JSON column, and a hidden secret (must never cross RPC).
const schema = defineSchema({
  lectures: Entity((t) => ({
    id: t.id(),
    publishAt: t.int(), // range-op column — deliberately NOT indexed(), as in #22
    public: t.bool(),
    payload: t.json(), // wide readable cell
    secret: hidden(t.text()), // never selectable / never shipped
  })),
});

const roles = [
  // #22's exact shape: anonymous reads only PUBLIC rows (a ROW scope — every column
  // readable), AND-merged with the caller's range-op `where` at read time.
  role("anonymous", [policy("pub:lectures:read", "lectures", "read", { where: { public: true } })]),
  // A FIELD-RESTRICTED caller — reads all rows but only a subset of columns (no
  // payload, no secret). Projection should drop the unreadable columns from the SQL.
  role("reader", [policy("r:lectures:read", "lectures", "read", { fields: ["id", "publishAt", "public"] })]),
];

// Wrap a Driver to record every exec — to assert the read is a SINGLE statement (no
// loop / retry / N+1) and inspect the exact SQL it emits.
function recording(inner: Driver): { driver: Driver; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    driver: {
      ...inner,
      async exec(sql: string, params: unknown[]): Promise<Row[]> {
        calls.push({ sql, params });
        return inner.exec(sql, params);
      },
    },
  };
}

const bigPayload = { note: "x".repeat(4096), tags: Array.from({ length: 32 }, (_, i) => `tag-${i}`) };
const BASE = 1_700_000_000_000;
const isPublic = (i: number) => i % 3 !== 0; // ~2/3 public

async function seed(count: number): Promise<Driver> {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const sys = new Db(driver, { acl: compileAcl(roles), identity: null, schema, system: true }, schema);
  for (let i = 0; i < count; i++) {
    await sys.insert("lectures", { publishAt: BASE + i * 1000, public: isPublic(i), payload: bigPayload, secret: `s-${i}` });
  }
  return driver;
}

function db(driver: Driver, roleName: string | null): Db<typeof schema> {
  const identity = roleName ? ({ roles: [roleName] } as Identity) : null;
  return new Db(driver, { acl: compileAcl(roles), identity, schema, partition: undefined }, schema);
}

describe("#22 — D1 range-op + ACL read scope: single statement, projected SELECT", () => {
  test("the exact issue query returns one scope-filtered, ordered page from a single statement", async () => {
    const driver = await seed(150);
    const now = BASE + 100 * 1000; // 101 rows (i in [0,100]) are <= now
    const rec = recording(driver);
    const anon = db(rec.driver, null);

    // If the reported bug were a real loop, this never resolves — reaching the
    // assertions at all is the primary proof it terminates.
    const rows = (await anon.find({
      from: "lectures",
      where: { publishAt: { lte: now }, public: true }, // range op AND-merged with the scope
      orderBy: [{ column: "publishAt", dir: "desc" }],
    })) as { publishAt: number; public: boolean; payload: unknown; secret?: string }[];

    // Single statement — no loop, no retry, no N+1.
    expect(rec.calls.length).toBe(1);
    const sql = rec.calls[0]!.sql;

    // Projection: a named column list, NOT `SELECT *`. The hidden `secret` never
    // appears in the SQL (never crosses RPC), even though this scope reads all fields.
    // The readable payload IS still selected — projection-to-readable can't drop it.
    expect(sql).not.toContain("SELECT *");
    expect(sql).not.toContain('"secret"');
    expect(sql).toContain('"payload"');

    // Correctness: only public rows, only publishAt <= now, newest-first, and the
    // readable payload is present while the hidden secret is stripped.
    const expected = Array.from({ length: 101 }, (_, i) => i).filter(isPublic).length;
    expect(rows.length).toBe(expected);
    expect(rows.every((r) => r.public === true)).toBe(true);
    expect(rows.every((r) => r.publishAt <= now)).toBe(true);
    expect(rows.every((r) => "payload" in r && !("secret" in r))).toBe(true);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.publishAt >= rows[i]!.publishAt).toBe(true);
  });

  test("`select:` keeps a readable-but-wide column off the wire (the reporter's lever)", async () => {
    // Projection-to-readable can't drop `payload` here (it's readable). `select:` can:
    // the SQL and the returned rows carry only the requested columns.
    const driver = await seed(30);
    const rec = recording(driver);
    const anon = db(rec.driver, null);

    const rows = (await anon.find({
      from: "lectures",
      where: { publishAt: { lte: BASE + 30 * 1000 }, public: true },
      orderBy: [{ column: "publishAt", dir: "desc" }],
      select: ["id", "publishAt"], // <-- fetch only these
    })) as Row[];

    expect(rec.calls.length).toBe(1);
    const sql = rec.calls[0]!.sql;
    expect(sql).not.toContain('"payload"'); // wide column never selected...
    expect(sql).not.toContain('"secret"');
    expect(sql).toContain('"publishAt"');

    expect(rows.length).toBeGreaterThan(0);
    // ...nor returned. Only the selected columns (public was a filter, not selected).
    expect(rows.every((r) => "id" in r && "publishAt" in r)).toBe(true);
    expect(rows.every((r) => !("payload" in r) && !("public" in r) && !("secret" in r))).toBe(true);
  });

  test("a field-restricted caller auto-projects: unreadable columns are never SELECTed", async () => {
    const driver = await seed(20);
    const rec = recording(driver);
    const reader = db(rec.driver, "reader"); // may read id, publishAt, public only

    const rows = (await reader.find({ from: "lectures", where: { public: true } })) as Row[];

    expect(rec.calls.length).toBe(1);
    const sql = rec.calls[0]!.sql;
    expect(sql).not.toContain("SELECT *");
    expect(sql).not.toContain('"payload"'); // reader can't read it -> not fetched
    expect(sql).not.toContain('"secret"');

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => "id" in r && "publishAt" in r && "public" in r)).toBe(true);
    expect(rows.every((r) => !("payload" in r) && !("secret" in r))).toBe(true);
  });

  test("`select:` of a hidden or unreadable column is a 403 (not a silent leak)", async () => {
    const driver = await seed(5);
    // hidden column: nobody can select it
    await expect(db(driver, null).find({ from: "lectures", select: ["secret"] })).rejects.toThrow();
    // unreadable-for-this-role column: reader can't select `payload`
    await expect(db(driver, "reader").find({ from: "lectures", select: ["payload"] })).rejects.toThrow();
    // sanity: a permitted projection does NOT throw
    const ok = (await db(driver, "reader").find({ from: "lectures", select: ["id", "publishAt"] })) as unknown[];
    expect(Array.isArray(ok)).toBe(true);
  });
});
