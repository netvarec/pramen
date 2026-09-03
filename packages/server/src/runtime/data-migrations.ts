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
// CLAIM FIRST, UNDER A LEASE. The ledger row is taken BEFORE the work — one atomic upsert
// that inserts a pending row, or steals one whose lease has expired, or does nothing — and
// the migration runs only if that statement won the row. On the DO this is merely bookkeeping
// order inside one transaction. On D1 it is what makes the once-only contract hold at all:
// there is no single writer and no interactive transaction, `d1Ready` is per-isolate, so two
// cold isolates racing a `SET n = n * 2` backfill would each read an empty ledger, each run
// it, and quadruple the data. The conflicting upsert is the lock.
//
// The row therefore has two states, distinguished by `leaseUntil`: IN FLIGHT (non-NULL — a
// runner holds it until that instant) and APPLIED (NULL). Only an applied row counts as
// applied, so an in-flight migration reads as pending everywhere, including the admin ledger.
//
// A runner that finds a LIVE lease does not skip — skipping would let it serve traffic
// against half-migrated data, and would strand the migration entirely if the holder then
// failed. It waits for the holder, up to WAIT_BUDGET_MS, and then either proceeds (the holder
// committed), takes the row (the holder released it), or fails closed. A holder that dies
// without releasing — an isolate evicted mid-backfill, which no compensating DELETE can
// cover — is recovered by the lease simply expiring.
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
  const t = d.id(MIGRATIONS_TABLE);
  await driver.exec(
    `CREATE TABLE IF NOT EXISTS ${t} (` +
      `${d.id("id")} TEXT NOT NULL, ${d.id("partition")} TEXT NOT NULL, ${d.id("appliedAt")} TEXT NOT NULL, ` +
      `${d.id("leaseUntil")} INTEGER, PRIMARY KEY (${d.id("id")}, ${d.id("partition")}))`,
    [],
  );
  // `leaseUntil` was added after the table's first shape. Probe for it with a zero-row SELECT
  // rather than PRAGMA table_info: the PRAGMA is what workerd's DO SQLite authorizer starts
  // rejecting (SQLITE_AUTH) once the alarm API has run in the object, and this runs on every
  // boot. Adding a nullable column is a plain ALTER — no rebuild, and existing rows read as
  // applied, which is what they are.
  const hasLease = await driver
    .exec(`SELECT ${d.id("leaseUntil")} FROM ${t} LIMIT 0`, [])
    .then(() => true)
    .catch(() => false);
  if (!hasLease) await driver.exec(`ALTER TABLE ${t} ADD COLUMN ${d.id("leaseUntil")} INTEGER`, []);
}

/** Ledger rows for one partition — or every partition when `partition` is omitted (the D1
 * store, which holds one shared ledger for all of them). Oldest first. */
export async function appliedMigrations(driver: Driver, partition?: string): Promise<AppliedMigration[]> {
  const d = driver.dialect;
  // `leaseUntil IS NULL` is the definition of applied: a row a runner is still holding is
  // in flight, and must read as PENDING everywhere — the admin ledger and the CLI included.
  const scope = partition === undefined ? "" : ` AND ${d.id("partition")} = ${d.placeholder(1)}`;
  const where = ` WHERE ${d.id("leaseUntil")} IS NULL${scope}`;
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

/** Lease timings. Defaults are deliberate, not arbitrary:
 *
 *  - `ttlMs` must EXCEED the slowest migration, because a lease that expires under a holder
 *    still running is exactly the double-apply this whole mechanism prevents. 60s is above
 *    anything that can finish inside a Worker's limits at all, and the docs already require
 *    backfills to be bounded.
 *  - `waitMs` bounds how long a runner blocks on someone else's live lease before failing
 *    closed. Long enough for an ordinary backfill to land (so the waiter proceeds against
 *    fully-migrated data), short enough not to hold a request open.
 *  - `pollMs` is the re-check interval while waiting. */
export interface LeaseOpts {
  ttlMs: number;
  waitMs: number;
  pollMs: number;
}

export const DEFAULT_LEASE: LeaseOpts = { ttlMs: 60_000, waitMs: 5_000, pollMs: 100 };

export interface RunMigrationsOpts {
  /** The partition to run: only its migrations are selected, and each ledger row is keyed
   * by it. OMIT it on the D1 store — see `runDataMigrations` for why that store runs every
   * declared migration regardless of partition. */
  partition?: string;
  /** Build the privileged context for one migration. Called per migration with the
   * partition its ledger row will be keyed under, so a caller can scope `db` accordingly. */
  makeContext: (partition: string) => MigrationContext;
  /** Override the lease timings (see `LeaseOpts`) — for tests, and for a deployment whose
   * backfills legitimately run long. Absent ⇒ `DEFAULT_LEASE`. */
  lease?: Partial<LeaseOpts>;
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
 * which is the one outcome the fail-closed contract exists to prevent. A holder that dies
 * without reaching that DELETE is covered by the lease expiring instead. Prefer SQL that
 * tolerates a re-run (`WHERE col IS NULL`) when the D1 store is in play: a mid-flight failure
 * leaves the partial writes behind.
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

  const lease = { ...DEFAULT_LEASE, ...opts.lease };
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
        // Take the row, waiting out any live lease. "applied" means another runner finished
        // it while we waited — nothing left to do, and we now know the data IS migrated.
        if ((await acquire(driver, m.id, partition, lease)) === "applied") return;
        ran = true;
        try {
          await m.up(opts.makeContext(partition));
          await complete(driver, m.id, partition);
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

/** What one attempt at taking the ledger row found. */
type ClaimOutcome = "claimed" | "applied" | "held";

/** ONE atomic statement that does all three things a claim must: insert the row when the
 * migration is pending, STEAL it when a previous holder's lease has expired (that holder is
 * presumed dead — an isolate evicted mid-backfill releases nothing), and do nothing when the
 * row is applied or a live lease holds it. `RETURNING` fires only when a row was actually
 * written, so it reports which happened. The upsert's `WHERE` is what confines the steal to
 * an expired lease: without it this would be a plain overwrite and two live runners would
 * both "win". */
async function tryClaim(driver: Driver, id: string, partition: string, now: number, ttlMs: number): Promise<ClaimOutcome> {
  const d = driver.dialect;
  const t = d.id(MIGRATIONS_TABLE);
  const params: CellValue[] = [id, partition, new Date(now).toISOString(), now + ttlMs, now];
  const rows = await driver.exec(
    `INSERT INTO ${t} (${d.id("id")}, ${d.id("partition")}, ${d.id("appliedAt")}, ${d.id("leaseUntil")}) ` +
      `VALUES (${d.placeholder(1)}, ${d.placeholder(2)}, ${d.placeholder(3)}, ${d.placeholder(4)}) ` +
      `ON CONFLICT (${d.id("id")}, ${d.id("partition")}) DO UPDATE SET ` +
      `${d.id("appliedAt")} = excluded.${d.id("appliedAt")}, ${d.id("leaseUntil")} = excluded.${d.id("leaseUntil")} ` +
      `WHERE ${t}.${d.id("leaseUntil")} IS NOT NULL AND ${t}.${d.id("leaseUntil")} <= ${d.placeholder(5)} ` +
      `RETURNING ${d.id("id")}`,
    params.map((v) => d.encode(v)),
  );
  if (rows.length > 0) return "claimed";
  // Nothing written — so the row exists and we did not qualify. Which of the two is it?
  const [row] = await driver.exec(
    `SELECT ${d.id("leaseUntil")} FROM ${t} WHERE ${d.id("id")} = ${d.placeholder(1)} AND ${d.id("partition")} = ${d.placeholder(2)}`,
    [id, partition].map((v) => d.encode(v)),
  );
  // Gone between the two statements (a holder released it) — contended, not applied.
  if (!row) return "held";
  return row.leaseUntil == null ? "applied" : "held";
}

/** Take the row, waiting out a live lease. Returns "applied" when someone else finished it
 * while we waited — in which case the caller must NOT run the migration, but CAN proceed
 * knowing the data is migrated. That distinction is the point: skipping a live lease outright
 * (the previous behavior) let a runner serve traffic against half-migrated data, and stranded
 * the migration on that isolate entirely if the holder then failed.
 *
 * On the DO this never waits — one Durable Object is a single writer and the migration runs
 * inside `blockConcurrencyWhile`, so a second concurrent first-fetch is queued by the platform
 * rather than contending here. The wait exists for D1, where nothing serializes isolates. */
async function acquire(driver: Driver, id: string, partition: string, lease: LeaseOpts): Promise<"claimed" | "applied"> {
  const deadline = Date.now() + lease.waitMs;
  for (;;) {
    const outcome = await tryClaim(driver, id, partition, Date.now(), lease.ttlMs);
    if (outcome !== "held") return outcome;
    if (Date.now() >= deadline) {
      // Fail closed rather than guess. Another runner is mid-flight; the request retries and
      // will usually find it applied. Serving on through a migration we know is unfinished is
      // the one thing that must not happen.
      throw new Error(`another runner holds the lease and did not finish within ${lease.waitMs}ms`);
    }
    await new Promise((r) => setTimeout(r, lease.pollMs));
  }
}

/** Mark the migration applied: drop the lease (NULL is the definition of applied) and stamp
 * the instant the work actually committed rather than the one the claim was taken. */
async function complete(driver: Driver, id: string, partition: string): Promise<void> {
  const d = driver.dialect;
  await driver.exec(
    `UPDATE ${d.id(MIGRATIONS_TABLE)} SET ${d.id("appliedAt")} = ${d.placeholder(1)}, ${d.id("leaseUntil")} = NULL ` +
      `WHERE ${d.id("id")} = ${d.placeholder(2)} AND ${d.id("partition")} = ${d.placeholder(3)}`,
    [new Date().toISOString(), id, partition].map((v) => d.encode(v)),
  );
}

/** Give the claim back after a failed `up()`, so the next runner retries immediately instead
 * of waiting out the lease. Only observable where `transaction()` does not roll back (D1); on
 * the DO the enclosing transaction discards this along with the claim itself. Guarded on
 * `leaseUntil IS NOT NULL` so it can only ever delete an IN-FLIGHT row — never an applied one,
 * whatever else has happened to the ledger in between. */
async function release(driver: Driver, id: string, partition: string): Promise<void> {
  const d = driver.dialect;
  await driver.exec(
    `DELETE FROM ${d.id(MIGRATIONS_TABLE)} WHERE ${d.id("id")} = ${d.placeholder(1)} AND ${d.id("partition")} = ${d.placeholder(2)} ` +
      `AND ${d.id("leaseUntil")} IS NOT NULL`,
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
