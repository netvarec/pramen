// The steady-state boot is one read (#100).
//
// Every cold isolate (D1 path) and every DO's first fetch runs the full boot: `migrate()`,
// the data-migration ledger, the outbox DDL and every `app.bootstrap` reconciler. On a store
// where nothing changed that is pure overhead, and on D1 each statement is a network round
// trip: a CMS app paid ~41 sequential queries (5 of them writes to the primary), ~600 ms of
// wall time and ~30 ms CPU on the first request of every isolate, which with little traffic
// is most requests.
//
// The fingerprint is a digest of everything the boot converges FROM CODE: the schema hash
// (the same one `migrate()` records), the declared data-migration ids, the outbox DDL, and
// the fingerprint each bootstrap reconciler declares. After a boot that converged fully it
// is written to `_pramen_meta`; the next boot reads it, and when it matches, skips the lot.
//
// What it deliberately does NOT see: the DATA. A code-defined row deleted by hand is not
// re-created until the next change to the code that defines it. That is the trade, and the
// escape hatch is deleting the `boot_fingerprint` meta row (the next boot then runs in full).
//
// A reconciler without a declared fingerprint cannot be skipped (its inputs, e.g. `env`, are
// invisible here), so it runs on every boot as before, but it no longer drags migrate, the
// ledger and the outbox along with it.

import type { BootstrapFn, DataMigration } from "../sdk/handlers";
import type { SchemaDef } from "../sdk/schema";
import { DEFAULT_PARTITION } from "../sdk/schema";
import { digest } from "./digest";
import type { Driver } from "./driver";
import { schemaHashFor } from "./migrate";
import { ensureOutbox } from "./outbox";

/** Bump when the boot's own semantics change in a way the inputs below can't see (what a
 * matching fingerprint promises about the store). */
const BOOT_FINGERPRINT_REV = 1;

export interface BootFingerprint {
  /** `_pramen_meta` key: `boot_fingerprint`, or `boot_fingerprint:<partition>` on a partition DO. */
  readonly key: string;
  readonly value: string;
  /** Reconcilers with no declared fingerprint: they run on every boot, matching or not. */
  readonly alwaysRun: readonly BootstrapFn[];
}

export function bootFingerprint(input: {
  schema: SchemaDef;
  /** Unset = the whole schema (the D1 store); set = a partition DO. */
  partition?: string;
  /** The data migrations THIS boot runs (all of them on D1, the partition's on a DO). */
  migrations: readonly Pick<DataMigration, "id" | "partition">[];
  /** The reconcilers THIS boot runs (none on a non-default partition DO). */
  bootstrap: readonly BootstrapFn[];
}): BootFingerprint {
  const alwaysRun = input.bootstrap.filter((fn) => typeof fn.fingerprint !== "string");
  const value = digest({
    rev: BOOT_FINGERPRINT_REV,
    schema: schemaHashFor(input.schema, input.partition),
    migrations: input.migrations.map((m) => `${m.partition ?? DEFAULT_PARTITION}:${m.id}`),
    // The DDL itself, not a version someone has to remember to bump: changing ensureOutbox
    // changes its source, and one full boot per isolate after that deploy is the whole cost.
    outbox: digest(ensureOutbox.toString()),
    bootstrap: input.bootstrap.map((fn) => (typeof fn.fingerprint === "string" ? fn.fingerprint : null)),
  });
  return { key: input.partition === undefined ? "boot_fingerprint" : `boot_fingerprint:${input.partition}`, value, alwaysRun };
}

/** The stored fingerprint, or `undefined` (none yet, or a store so fresh `_pramen_meta`
 * does not exist: the full boot creates it). */
export async function readBootFingerprint(driver: Driver, key: string): Promise<string | undefined> {
  try {
    const rows = (await driver.exec(`SELECT value FROM _pramen_meta WHERE key = ?`, [key])) as { value: string }[];
    return rows[0]?.value;
  } catch {
    return undefined;
  }
}

/** Record the fingerprint. Call ONLY after a boot that converged fully: migrate skipped
 * nothing, every data migration applied, every reconciler finished without throwing. */
export async function writeBootFingerprint(driver: Driver, fp: BootFingerprint): Promise<void> {
  await driver.exec(`INSERT OR REPLACE INTO _pramen_meta (key, value) VALUES (?, ?)`, [fp.key, fp.value]);
}
