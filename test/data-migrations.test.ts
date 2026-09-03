// app.migrations — imperative, ordered, recorded-ONCE data migrations. The half the
// declarative migrator can't express (backfills, splits, normalizations), and the whole
// reason it exists is that a transformation is NOT idempotent: running it twice doubles the
// value. So the interesting properties are all about the ledger — that it records, that it
// skips what it recorded, that it keys per partition, and that it records NOTHING when the
// migration throws.
//
// Runs the runner directly over a bun:sqlite Driver (the same seam both boot paths use).
// That driver's `transaction()` is a passthrough, exactly like D1Driver's — so these tests
// assert the D1-SHAPED guarantees (work-then-ledger ordering; no ledger row on a throw)
// rather than pretending a rollback happened. The DO's real transaction only makes the
// same guarantee stronger. The wiring that calls this after migrate() on boot is covered
// end-to-end by test/suites/migrations.ts.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { defineSchema, Entity } from "../packages/server/src/sdk/schema";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import {
  appliedMigrations,
  ensureMigrationsTable,
  migrationsForPartition,
  runDataMigrations,
  validateMigrations,
  MIGRATIONS_TABLE,
} from "../packages/server/src/runtime/data-migrations";
import { bunSqliteDriver } from "./sqlite-driver";
import type { DataMigration, MigrationContext } from "../packages/server/src/sdk/handlers";
import type { Driver } from "../packages/server/src/runtime/driver";

const schema = defineSchema({
  counters: Entity((t) => ({ id: t.textId(), n: t.int() })),
  audits: Entity((t) => ({ id: t.textId(), note: t.text() }), undefined, { partition: "audit" }),
});

function makeContext(driver: Driver): (partition: string) => MigrationContext {
  const db = new Db(driver, { acl: compileAcl([]), identity: { roles: ["admin"] }, system: true, schema }, schema);
  return (partition) => ({ db, driver, schema, partition } as MigrationContext);
}

/** A store migrated for one partition, so the runner has real tables to touch. */
async function freshStore(partition = "default"): Promise<Driver> {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema, { partition });
  return driver;
}

const run = (driver: Driver, migrations: readonly DataMigration[], partition?: string) =>
  runDataMigrations(driver, migrations, { partition, makeContext: makeContext(driver) });

describe("data migrations — the runner", () => {
  test("runs pending migrations in DECLARATION order", async () => {
    const driver = await freshStore();
    const order: string[] = [];
    const step = (id: string): DataMigration => ({ id, up: () => void order.push(id) });
    // Declared out of any alphabetical/id order on purpose — the contract is the array's
    // order, since a later migration may depend on an earlier one's output.
    const result = await run(driver, [step("c"), step("a"), step("b")], "default");
    expect(order).toEqual(["c", "a", "b"]);
    expect(result.applied).toEqual(["c", "a", "b"]);
    expect(result.skipped).toEqual([]);
  });

  test("records the ledger row, and a second run does not re-run the backfill", async () => {
    const driver = await freshStore();
    await driver.exec(`INSERT INTO "counters" ("id", "n") VALUES ('a', 1)`, []);
    // The classic non-idempotent migration: run it twice and the value doubles.
    const doubler: DataMigration = {
      id: "double-n",
      up: async ({ driver: d }) => void (await d.exec(`UPDATE "counters" SET "n" = "n" * 2`, [])),
    };

    expect((await run(driver, [doubler], "default")).applied).toEqual(["double-n"]);
    const ledger = await appliedMigrations(driver, "default");
    expect(ledger.map((r) => r.id)).toEqual(["double-n"]);
    expect(ledger[0]!.partition).toBe("default");
    expect(ledger[0]!.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO-8601 UTC

    const second = await run(driver, [doubler], "default");
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["double-n"]);
    const rows = (await driver.exec(`SELECT "n" FROM "counters" WHERE "id" = 'a'`, [])) as { n: number }[];
    expect(rows[0]!.n).toBe(2); // 2, not 4 — the ledger, not idempotent SQL, is what saved it
  });

  test("the same id in two partitions applies once per partition, never cross-skipping", async () => {
    // Two partitions are two independent DOs (two SQLite stores) — a migration applied in
    // one must still be pending in the other, which is why the ledger key is (id, partition).
    const defaultStore = await freshStore("default");
    const auditStore = await freshStore("audit");
    const seen: string[] = [];
    const migrations: DataMigration[] = [
      { id: "same-id", up: () => void seen.push("default") },
      { id: "same-id-audit", partition: "audit", up: () => void seen.push("audit") },
    ];
    // Deliberately reuse ONE id across partitions by re-declaring it per store.
    const shared = (partition?: string): DataMigration => ({ id: "shared", partition, up: () => void seen.push(`shared:${partition ?? "default"}`) });

    await run(defaultStore, [migrations[0]!, shared()], "default");
    await run(auditStore, [migrations[1]!, shared("audit")], "audit");
    expect(seen).toEqual(["default", "shared:default", "audit", "shared:audit"]);

    expect((await appliedMigrations(defaultStore, "default")).map((r) => r.id).sort()).toEqual(["same-id", "shared"]);
    expect((await appliedMigrations(auditStore, "audit")).map((r) => r.id).sort()).toEqual(["same-id-audit", "shared"]);

    // A partition's ledger is invisible to the other partition's selection.
    expect((await appliedMigrations(defaultStore, "audit")).length).toBe(0);
  });

  test("a migration declared for another partition does not run", async () => {
    const driver = await freshStore();
    let ran = false;
    const result = await run(driver, [{ id: "audit-only", partition: "audit", up: () => void (ran = true) }], "default");
    expect(ran).toBe(false);
    expect(result.applied).toEqual([]);
    // Not even the ledger table is created — nothing was selected for this partition.
    expect(migrationsForPartition([{ id: "x", partition: "audit", up: () => {} }], "default")).toEqual([]);
  });

  test("omitting `partition` (the D1 store) runs EVERY declared migration, recorded under its own", async () => {
    // D1 is ONE shared database with no partition split — every entity's table lives in it,
    // so a non-default-partition migration is runnable there and would otherwise be dead.
    const driver = bunSqliteDriver(new Database(":memory:"));
    await migrate(driver, schema); // the whole schema, all partitions — the D1 shape
    const ran: string[] = [];
    const result = await run(driver, [
      { id: "d-default", up: () => void ran.push("d-default") },
      { id: "d-audit", partition: "audit", up: () => void ran.push("d-audit") },
    ]);
    expect(ran).toEqual(["d-default", "d-audit"]);
    expect(result.applied).toEqual(["d-default", "d-audit"]);
    const all = await appliedMigrations(driver);
    expect(all.map((r) => `${r.id}@${r.partition}`).sort()).toEqual(["d-audit@audit", "d-default@default"]);
  });

  test("FAILS CLOSED: a throw propagates, records nothing, stops the rest, and retries later", async () => {
    const driver = await freshStore();
    const ran: string[] = [];
    let explode = true;
    const migrations: DataMigration[] = [
      { id: "first", up: () => void ran.push("first") },
      {
        id: "boom",
        up: async ({ driver: d }) => {
          // Write BEFORE throwing: on a passthrough-transaction substrate (D1, and this
          // driver) the partial write survives — what must NOT survive is a ledger row
          // claiming the migration is done.
          await d.exec(`INSERT OR REPLACE INTO "counters" ("id", "n") VALUES ('partial', 1)`, []);
          if (explode) throw new Error("backfill blew up");
          ran.push("boom");
        },
      },
      { id: "after", up: () => void ran.push("after") },
    ];

    await expect(run(driver, migrations, "default")).rejects.toThrow(/boom/);
    expect(ran).toEqual(["first"]); // "after" did NOT run — order is a contract
    // "boom" claimed its ledger row, then RELEASED it on the throw. On this passthrough
    // driver (and on D1) that compensating delete is the only thing standing between a
    // failed migration and being permanently marked as applied.
    expect((await appliedMigrations(driver, "default")).map((r) => r.id)).toEqual(["first"]);

    // The next boot retries exactly the pending tail.
    explode = false;
    const retry = await run(driver, migrations, "default");
    expect(retry.applied).toEqual(["boom", "after"]);
    expect(retry.skipped).toEqual(["first"]);
    expect((await appliedMigrations(driver, "default")).map((r) => r.id).sort()).toEqual(["after", "boom", "first"]);
  });

  test("the thrown error names the failing migration", async () => {
    const driver = await freshStore();
    await expect(
      run(driver, [{ id: "2026-01-01-split-name", up: () => { throw new Error("no such column: firstName"); } }], "default"),
    ).rejects.toThrow(/2026-01-01-split-name.*partition=default.*no such column/s);
  });

  test("the ledger row is CLAIMED before the work runs", async () => {
    // Claim-first is what makes the once-only contract hold on D1, where transaction() is a
    // passthrough and two cold isolates would otherwise both see an empty ledger and both
    // run the backfill. The conflicting insert is the lock, so it must precede the work.
    const driver = await freshStore();
    const statements: string[] = [];
    const spy: Driver = { ...driver, exec: (sql, params) => (statements.push(sql), driver.exec(sql, params)) };
    await runDataMigrations(spy, [{ id: "m", up: async ({ driver: d }) => void (await d.exec(`UPDATE "counters" SET "n" = 1`, [])) }], {
      partition: "default",
      makeContext: makeContext(spy),
    });
    const claim = statements.findIndex((s) => s.includes(`INSERT INTO "_pramen_migrations"`));
    const work = statements.findIndex((s) => s.includes(`UPDATE "counters"`));
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(statements[claim]).toContain("ON CONFLICT"); // a claim, not a blind insert
    expect(work).toBeGreaterThan(claim);
  });

  test("a claim already held is not re-run — the D1 concurrent-isolate case", async () => {
    // Simulate the race directly: another isolate has already claimed the row (but not yet
    // finished). The second runner must NOT run the work, or a `n = n * 2` backfill doubles
    // twice. This is the property the pre-read `done` set alone cannot give on D1, where
    // `d1Ready` is per-isolate and there is no single writer.
    const driver = await freshStore();
    await ensureMigrationsTable(driver);
    await driver.exec(`INSERT INTO "_pramen_migrations" ("id", "partition", "appliedAt") VALUES ('m', 'default', '2026-01-01T00:00:00.000Z')`, []);
    let ran = false;
    // Hide the row from the up-front read so only the claim can catch it — exactly what a
    // racing isolate sees when it read the ledger before the other one claimed.
    const blind: Driver = {
      ...driver,
      exec: (sql, params) => (/^\s*SELECT/i.test(sql) && sql.includes("_pramen_migrations") ? Promise.resolve([]) : driver.exec(sql, params)),
    };
    const result = await runDataMigrations(blind, [{ id: "m", up: () => void (ran = true) }], {
      partition: "default",
      makeContext: makeContext(blind),
    });
    expect(ran).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["m"]);
    expect((await appliedMigrations(driver, "default")).length).toBe(1); // still one row
  });

  test("ensureMigrationsTable is idempotent and the ledger reads empty on a fresh store", async () => {
    const driver = await freshStore();
    await ensureMigrationsTable(driver);
    await ensureMigrationsTable(driver);
    await ensureMigrationsTable(driver);
    expect(await appliedMigrations(driver, "default")).toEqual([]);
    expect(MIGRATIONS_TABLE).toBe("_pramen_migrations");
  });

  test("no declared migrations is a clean no-op", async () => {
    const driver = await freshStore();
    expect(await run(driver, [], "default")).toEqual({ applied: [], skipped: [] });
  });
});

describe("validateMigrations — declaration-time invariants", () => {
  const ok: DataMigration = { id: "a", up: () => {} };

  test("a valid set does not throw", () => {
    expect(() =>
      validateMigrations(schema, [ok, { id: "b", partition: "audit", up: () => {} }]),
    ).not.toThrow();
    expect(() => validateMigrations(schema, undefined)).not.toThrow();
    expect(() => validateMigrations(schema, [])).not.toThrow();
  });

  test("a duplicate id throws — ids are the ledger key, globally unique", () => {
    expect(() => validateMigrations(schema, [ok, { id: "a", up: () => {} }])).toThrow(/duplicate id "a"/);
    // Even across partitions: an id must identify ONE migration, or a copy-paste silently
    // marks a different one as applied.
    expect(() => validateMigrations(schema, [ok, { id: "a", partition: "audit", up: () => {} }])).toThrow(/duplicate id/);
  });

  test("an empty id throws", () => {
    expect(() => validateMigrations(schema, [{ id: "", up: () => {} }])).toThrow(/non-empty/);
  });

  test("an unknown partition throws", () => {
    expect(() => validateMigrations(schema, [{ id: "a", partition: "nope", up: () => {} }])).toThrow(
      /partition "nope".*Known partitions/s,
    );
  });
});
