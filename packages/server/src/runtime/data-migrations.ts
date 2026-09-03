// Data migrations — the imperative, recorded half of schema evolution.
//
// `migrate()` (runtime/migrate.ts) is declarative: it diffs the live table shape against
// the declared schema and enacts the structural delta. A diff between two SHAPES can only
// ever express structure, never TRANSFORMATION — it cannot split `name` into
// `firstName`/`lastName`, backfill the nullable column `ADD COLUMN` just created (SQLite
// can't add NOT NULL to a populated table, so every new column starts as a hole), rewrite
// `priceHalers` → `priceCzk`, or normalize a `t.json()` blob whose shape changed.
//
// So: structure stays declarative, data becomes imperative, ordered, and RECORDED. Each
// `app.migrations` entry runs at most once per `(id, partition)`, its ledger row written in
// `_pramen_migrations` in the SAME transaction as the work. That is what makes a
// non-idempotent transformation safe, and it is precisely why `app.bootstrap` cannot be
// stretched to cover this (bootstrap runs on EVERY boot, must be idempotent, and swallows
// its errors).
//
// Fail closed. A throwing migration records no ledger row, does not let the boot complete,
// and propagates — the tenant's request fails and the migration is retried on the next
// fetch. This mirrors migrate()'s "withhold the schema hash on a skip" invariant: the store
// is never marked as having reached a state it did not reach.
//
// CLAIM FIRST. The ledger row is INSERTed (ON CONFLICT DO NOTHING ... RETURNING) BEFORE the
// work, and the migration runs only if that insert won the row. On the DO this is merely
// bookkeeping order inside one transaction. On D1 it is what makes the once-only contract
// hold at all: there is no single writer and no interactive transaction, `d1Ready` is
// per-isolate, so two cold isolates racing a `SET n = n * 2` backfill would each read an
// empty ledger, each run it, and quadruple the data. The conflicting insert is the lock.
//
// Written against the `Driver`/`Dialect` seam only (no `cloudflare:workers`), so the same
// runner drives the DO boot path and the D1/Worker path.

import { DEFAULT_PARTITION, partitionsOf, type SchemaDef } from "../sdk/schema";
import type { DataMigration, MigrationContext } from "../sdk/handlers";
import type { CellValue } from "../sdk/infer";
import type { Driver } from "./driver";

export const MIGRATIONS_TABLE = "_pramen_migrations";

/** One applied-migration ledger row. */
export interface AppliedMigration {
  id: string;
  partition: string;
  /** ISO-8601 UTC instant the migration committed. */
  appliedAt: string;
}

/** Create the ledger if absent. Idempotent — run on every boot before the runner and from
 * the /__migrations endpoint (a DO that has never applied one still answers). Internal
 * table (`_pramen_` prefix), so `isInternalTable()` keeps the migrator's hands off it.
 *
 * `partition` is a reserved-ish word in some engines, so every identifier goes through
 * `dialect.id(...)` (the single `quoteIdent` source of truth) rather than being interpolated
 * bare — here and in every query below. */
export async function ensureMigrationsTable(driver: Driver): Promise<void> {
  const d = driver.dialect;
  await driver.exec(
    `CREATE TABLE IF NOT EXISTS ${d.id(MIGRATIONS_TABLE)} (` +
      `${d.id("id")} TEXT NOT NULL, ${d.id("partition")} TEXT NOT NULL, ${d.id("appliedAt")} TEXT NOT NULL, ` +
      `PRIMARY KEY (${d.id("id")}, ${d.id("partition")}))`,
    [],
  );
}

/** Ledger rows for one partition — or every partition when `partition` is omitted (the D1
 * store, which holds one shared ledger for all of them). Oldest first. */
export async function appliedMigrations(driver: Driver, partition?: string): Promise<AppliedMigration[]> {
  const d = driver.dialect;
  const where = partition === undefined ? "" : ` WHERE ${d.id("partition")} = ${d.placeholder(1)}`;
  const rows = await driver.exec(
    `SELECT ${d.id("id")}, ${d.id("partition")}, ${d.id("appliedAt")} FROM ${d.id(MIGRATIONS_TABLE)}${where} ` +
      `ORDER BY ${d.id("appliedAt")}, ${d.id("id")}`,
    partition === undefined ? [] : [d.encode(partition)],
  );
  return rows.map((r) => ({ id: String(r.id), partition: String(r.partition), appliedAt: String(r.appliedAt) }));
}

/** The migrations that belong to `partition`: an entry with no declared partition belongs
 * to the default one. Both boot paths select through this, so "which partition owns this
 * migration" is answered in exactly one place. */
export function migrationsForPartition(
  migrations: readonly DataMigration[],
  partition: string,
): readonly DataMigration[] {
  return migrations.filter((m) => (m.partition ?? DEFAULT_PARTITION) === partition);
}

export interface RunMigrationsResult {
  /** Ids applied by THIS run, in the order they committed. */
  applied: string[];
  /** Ids already in the ledger (a previous boot applied them). */
  skipped: string[];
}

export interface RunMigrationsOpts {
  /** The partition to run: only its migrations are selected, and each ledger row is keyed
   * by it. OMIT it on the D1 store — see `runDataMigrations` for why that store runs every
   * declared migration regardless of partition. */
  partition?: string;
  /** Build the privileged context for one migration. Called per migration with the
   * partition its ledger row will be keyed under, so a caller can scope `db` accordingly. */
  makeContext: (partition: string) => MigrationContext;
}

/** Run every pending migration, in DECLARATION order, each inside its own
 * `driver.transaction()`, CLAIMING its ledger row before it runs the work — so "the work
 * happened" and "the work is recorded" cannot come apart on a substrate with real
 * transactions (the DO), and cannot double-run on one without (D1). A migration whose claim
 * loses the race (another isolate holds it, or a previous boot applied it) is skipped.
 *
 * D1 CAVEAT: `D1Driver.transaction(fn)` is `fn()` (D1 has no interactive transactions), so
 * there the claim and the work do NOT commit together. A throw therefore RELEASES the claim
 * explicitly (a compensating DELETE, issued inside the transaction so the DO simply rolls it
 * back with everything else) — otherwise a failed migration would stay marked as applied,
 * which is the one outcome the fail-closed contract exists to prevent. The residual D1 window
 * is narrow and self-healing: a concurrent isolate that skipped on the losing claim carries on
 * with the migration unapplied until that isolate recycles, and the released row makes the
 * next cold isolate re-run it. Prefer SQL that tolerates a re-run (`WHERE col IS NULL`) when
 * the D1 store is in play.
 *
 * Fails CLOSED: the first throw aborts the run, so migrations declared after it do not run
 * either (order is a contract — a later one may depend on an earlier one's output). */
export async function runDataMigrations(
  driver: Driver,
  migrations: readonly DataMigration[],
  opts: RunMigrationsOpts,
): Promise<RunMigrationsResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const pending = opts.partition === undefined ? migrations : migrationsForPartition(migrations, opts.partition);
  if (pending.length === 0) return { applied, skipped };

  await ensureMigrationsTable(driver);
  const done = new Set((await appliedMigrations(driver, opts.partition)).map((r) => ledgerKey(r.id, r.partition)));

  for (const m of pending) {
    const partition = m.partition ?? DEFAULT_PARTITION;
    // The cheap pre-check: skip without opening a transaction for what a previous boot
    // already applied (the common case — every boot after the first). `claim` is what
    // actually decides; this only keeps the steady state free of no-op transactions.
    if (done.has(ledgerKey(m.id, partition))) {
      skipped.push(m.id);
      continue;
    }
    let ran = false;
    try {
      await driver.transaction(async () => {
        if (!(await claim(driver, m.id, partition))) return; // someone else holds it
        ran = true;
        try {
          await m.up(opts.makeContext(partition));
        } catch (e) {
          await release(driver, m.id, partition); // no-op on the DO (rolled back anyway)
          throw e;
        }
      });
    } catch (e) {
      // Name the migration in the message: the raw SQL error alone gives no clue WHICH of
      // an ordered list failed, and the boot it aborted is the tenant's first request.
      throw new Error(
        `[pramen] data migration ${JSON.stringify(m.id)} failed (partition=${partition}): ` +
          `${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
    if (!ran) {
      skipped.push(m.id);
      continue;
    }
    console.log(`[pramen] data migration ${JSON.stringify(m.id)} applied (partition=${partition})`);
    applied.push(m.id);
  }
  return { applied, skipped };
}

/** The ledger is keyed by (id, partition) — the same reason the schema hash is
 * `schema_hash:<partition>`: partitions are independent DOs and must not thrash each
 * other's state. NUL-joined, so no (id, partition) pair can collide with another. */
const ledgerKey = (id: string, partition: string): string => `${id}\u0000${partition}`;

/** Take the ledger row for `(id, partition)`, returning whether THIS caller took it.
 * `ON CONFLICT DO NOTHING ... RETURNING` yields a row only when the insert actually
 * happened, which is what makes it a claim rather than an upsert: a concurrent D1 isolate
 * (or a previous boot) already holding the row gets `false` and skips. */
async function claim(driver: Driver, id: string, partition: string): Promise<boolean> {
  const d = driver.dialect;
  const params: CellValue[] = [id, partition, new Date().toISOString()];
  const rows = await driver.exec(
    `INSERT INTO ${d.id(MIGRATIONS_TABLE)} (${d.id("id")}, ${d.id("partition")}, ${d.id("appliedAt")}) ` +
      `VALUES (${d.placeholder(1)}, ${d.placeholder(2)}, ${d.placeholder(3)}) ` +
      `ON CONFLICT (${d.id("id")}, ${d.id("partition")}) DO NOTHING RETURNING ${d.id("id")}`,
    params.map((p) => d.encode(p)),
  );
  return rows.length > 0;
}

/** Give the claim back after a failed `up()`. Only observable where `transaction()` does
 * not roll back (D1); on the DO the enclosing transaction discards this along with the
 * claim itself. Without it a failed migration would stay recorded as applied. */
async function release(driver: Driver, id: string, partition: string): Promise<void> {
  const d = driver.dialect;
  await driver.exec(
    `DELETE FROM ${d.id(MIGRATIONS_TABLE)} WHERE ${d.id("id")} = ${d.placeholder(1)} AND ${d.id("partition")} = ${d.placeholder(2)}`,
    [id, partition].map((v) => d.encode(v)),
  );
}

/** Static validation, called from `createPramen` next to `validateTriggerTasks` — these are
 * declaration bugs, and the only honest time to surface them is before a single tenant has
 * booted. Throws on the first violation:
 *
 *  - an empty id (the ledger key would be meaningless);
 *  - a duplicate id — ids are GLOBALLY unique across the array, not per partition, so a
 *    copy-pasted id can never quietly mark a different migration as already applied;
 *  - a declared `partition` no entity lives in — the migration would be dead code on the
 *    DO path (no DO serves that partition) while still running on D1. */
export function validateMigrations(schema: SchemaDef, migrations: readonly DataMigration[] | undefined): void {
  if (!migrations?.length) return;
  const known = new Set(partitionsOf(schema));
  known.add(DEFAULT_PARTITION); // always addressable, even for a schema with no entities
  const seen = new Set<string>();
  for (const m of migrations) {
    if (!m.id) throw new Error("app.migrations: every migration needs a non-empty, stable `id` (it is the ledger key).");
    if (seen.has(m.id)) {
      throw new Error(
        `app.migrations: duplicate id ${JSON.stringify(m.id)}. Ids are the ledger key and must be globally ` +
          `unique — a reused id makes one of the two silently a no-op.`,
      );
    }
    seen.add(m.id);
    if (m.partition !== undefined && !known.has(m.partition)) {
      throw new Error(
        `app.migrations: migration ${JSON.stringify(m.id)} declares partition ${JSON.stringify(m.partition)}, ` +
          `which no entity lives in. Known partitions: ${[...known].join(", ")}.`,
      );
    }
  }
}
