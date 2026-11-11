// The steady-state boot is one read (#100).
//
// Every cold isolate (D1 path) and every DO's first fetch ran the full boot: `migrate()`, the
// data-migration ledger, the outbox DDL and every `app.bootstrap` reconciler. On a store where
// nothing changed that is pure overhead, and on D1 each statement is a network round trip: a
// CMS app paid 41 sequential statements (5 of them writes to the primary), ~600 ms of wall
// time and ~30 ms CPU on the first request of every isolate, which with little traffic is
// most requests.
//
// The fingerprint is a SHA-256 over everything the boot converges FROM CODE: the schema (the
// same subset `migrate()` hashes), the data-migration ids that boot runs, the outbox DDL, and
// the fingerprint each bootstrap reconciler declares. A full boot that converged writes it to
// `_pramen_meta`; a later boot reads it together with `schema_hash` and, when BOTH match,
// skips the lot.
//
// Why `schema_hash` too: code that predates the fingerprint (a rollback across #100) still
// migrates and rewrites `schema_hash` but never touches the fingerprint, so a matching
// fingerprint alone could vouch for a store an older release reshaped. Checking the hash
// `migrate()` itself keeps catches every schema change, whoever made it. What an older release
// does to bootstrap rows is NOT caught that way: after rolling back across #100 and forward
// again, delete the `boot_fingerprint` rows or boot once with `PRAMEN_FULL_BOOT=true`.
//
// Why the `pending:` marker: two releases that both know the fingerprint can boot the same
// store at once (a gradual rollout). Each full boot first claims the key with
// `pending:<its fingerprint>:<nonce>` and finishes with a conditional UPDATE that succeeds only
// over a claim (or a record) of the SAME fingerprint: boots of the same code write identical
// rows, so either may record. A boot that finds the key claimed or recorded by OTHER code
// writes a fresh claim instead. It ran its reconcilers after the other release may have
// recorded, so the store can no longer vouch for that release's rows either; the next cold
// isolate of each runs in full, and whichever finishes last without being overtaken records.
//
// What it deliberately does NOT see: the DATA. A code-defined row deleted by hand, a ledger
// row deleted to re-run a migration, an editor-owned row that blocked a declared slug and was
// then deleted: none of them is acted on until the code changes or a full boot is forced.
//
// A reconciler without a declared fingerprint cannot be skipped (its inputs, e.g. `env`, are
// invisible here), so it runs on every boot as before, but it no longer drags migrate, the
// ledger and the outbox along with it.

import type { BootstrapFn, DataMigration } from "../sdk/handlers";
import type { SchemaDef } from "../sdk/schema";
import { DEFAULT_PARTITION } from "../sdk/schema";
import { canonical } from "./digest";
import type { Driver } from "./driver";
import { schemaCanon, schemaHash, schemaSubset } from "./migrate";
import { ensureOutbox } from "./outbox";

/** Bump when the boot's own semantics change in a way the inputs below can't see (what a
 * matching fingerprint promises about the store). */
const BOOT_FINGERPRINT_REV = 2;

export interface BootFingerprint {
  /** `_pramen_meta` key: `boot_fingerprint`, or `boot_fingerprint:<partition>` on a partition DO. */
  readonly key: string;
  /** The `schema_hash` key `migrate()` keeps for the same scope, and the value it must hold. */
  readonly schemaKey: string;
  readonly schemaHash: string;
  readonly value: string;
  /** Reconcilers with no declared fingerprint: they run on every boot, matching or not. */
  readonly alwaysRun: readonly BootstrapFn[];
}

const sha256 = async (text: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export async function bootFingerprint(input: {
  schema: SchemaDef;
  /** Unset = the whole schema (the D1 store); set = a partition DO. */
  partition?: string;
  /** The data migrations THIS boot runs (all of them on D1, the partition's on a DO). */
  migrations: readonly Pick<DataMigration, "id" | "partition">[];
  /** The reconcilers THIS boot runs (none on a non-default partition DO). */
  bootstrap: readonly BootstrapFn[];
}): Promise<BootFingerprint> {
  const alwaysRun = input.bootstrap.filter((fn) => typeof fn.fingerprint !== "string");
  const subset = schemaSubset(input.schema, input.partition);
  const value = await sha256(
    canonical({
      rev: BOOT_FINGERPRINT_REV,
      // The declared shape itself (not migrate's 32-bit hash of it): a collision here would
      // skip a migration, so this one digest is SHA-256 over the full text.
      schema: schemaCanon(subset),
      migrations: input.migrations.map((m) => `${m.partition ?? DEFAULT_PARTITION}:${m.id}`),
      // The DDL itself, not a version someone has to remember to bump: changing ensureOutbox
      // changes its source, and one full boot per isolate after that deploy is the whole cost.
      outbox: ensureOutbox.toString(),
      bootstrap: input.bootstrap.map((fn) => (typeof fn.fingerprint === "string" ? fn.fingerprint : null)),
    }),
  );
  const scoped = (base: string) => (input.partition === undefined ? base : `${base}:${input.partition}`);
  return {
    key: scoped("boot_fingerprint"),
    schemaKey: scoped("schema_hash"),
    schemaHash: schemaHash(subset),
    value,
    alwaysRun,
  };
}

/** Does the store vouch for this exact boot? Both the fingerprint and `migrate()`'s own schema
 * hash must match. One statement. A store so fresh that `_pramen_meta` does not exist is
 * "no" (the full boot creates it), not a throw. */
export async function bootFingerprintMatches(driver: Driver, fp: BootFingerprint): Promise<boolean> {
  try {
    const rows = (await driver.exec(`SELECT key, value FROM _pramen_meta WHERE key IN (?, ?)`, [fp.key, fp.schemaKey])) as { key: string; value: string }[];
    const got = new Map(rows.map((r) => [r.key, r.value]));
    return got.get(fp.key) === fp.value && got.get(fp.schemaKey) === fp.schemaHash;
  } catch {
    return false;
  }
}

/** Start a full boot: claim the fingerprint key with a nonce, so a concurrent full boot of
 * other code cannot be vouched for by this one's result (see the header). Returns the claim. */
export async function claimFullBoot(driver: Driver, fp: BootFingerprint): Promise<string> {
  const claim = `pending:${fp.value}:${crypto.randomUUID()}`;
  await driver.exec(`CREATE TABLE IF NOT EXISTS _pramen_meta (key TEXT PRIMARY KEY, value TEXT)`, []);
  await driver.exec(`INSERT OR REPLACE INTO _pramen_meta (key, value) VALUES (?, ?)`, [fp.key, claim]);
  return claim;
}

/** Finish a full boot that converged fully (migrate skipped nothing, every data migration
 * applied, every reconciler finished). Records over a claim or record of the same fingerprint;
 * if other code claimed or recorded meanwhile, re-claims instead (see the header). */
export async function recordBootFingerprint(driver: Driver, fp: BootFingerprint, _claim: string): Promise<void> {
  const recorded = await driver.exec(
    `UPDATE _pramen_meta SET value = ? WHERE key = ? AND (value = ? OR substr(value, 1, ?) = ?) RETURNING key`,
    [fp.value, fp.key, fp.value, `pending:${fp.value}:`.length, `pending:${fp.value}:`],
  );
  if (recorded.length === 0) await claimFullBoot(driver, fp);
}

/** `PRAMEN_FULL_BOOT=true` ignores a matching fingerprint: the escape hatch after a rollback
 * across #100 or a hand edit the fingerprint can't see, usable on a DO store too (no per-tenant
 * meta row to delete by hand). */
export const forceFullBoot = (env: { PRAMEN_FULL_BOOT?: unknown }): boolean => env.PRAMEN_FULL_BOOT === "true";
