// Schema migration — applied on boot, wrapped in a transaction by the caller.
// Runs over a Driver, so it works on any SQLite-flavored substrate (DO SQLite and
// D1). The introspection (`PRAGMA table_info`, `sqlite_master`) and table-rebuild
// are SQLite-specific; a Postgres/MySQL migrator would be a separate adapter.
// Reconciles the live store with the declared schema in two passes:
//   1. additive (no data loss): missing table -> CREATE TABLE; missing column ->
//      ALTER TABLE ADD COLUMN (nullable).
//   2. destructive: a live column the schema no longer declares is DROPPED, a type
//      change is applied, and a `renamedFrom` column is renamed — all via the
//      standard SQLite table-rebuild (create new, copy, drop old, rename). This pass
//      is GATED: it runs only when the deploy opts in with PRAMEN_ALLOW_DESTRUCTIVE
//      (off by default). When a destructive change is detected but not allowed it is
//      SKIPPED (recorded in report.skipped) and the schema hash is left UNWRITTEN, so a
//      later opt-in deploy retries. Local dev sets the flag on; a bad deploy CAN then
//      lose data (WIP, no backward-compat).
//
// A schema hash in the internal `_pramen_meta` table lets an unchanged schema skip
// introspection entirely on warm boots. The live table (PRAGMA) is the ground
// truth diffed against the schema — no stored shape needed.
//
// ADD COLUMN is always nullable (SQLite can't add NOT NULL to a populated table).
// A rename can't be inferred from a diff (a removed + added column is ambiguous),
// so it must be declared with `renamedFrom`; otherwise it is applied as drop+add.

import { addColumnSql, createTableSql, indexStatements, sqlType } from "./ddl";
import { digest } from "./digest";
import { quoteIdent, type Driver } from "./driver";
import { entitiesInPartition, validateSchema } from "../sdk/schema";
import type { EntityFields, FieldDef, SchemaDef } from "../sdk/schema";

export interface MigrationReport {
  changed: boolean;
  created: string[];
  added: string[];
  /** Tables rebuilt to apply a drop / rename / type change. */
  rebuilt: string[];
  /** Tables dropped because the schema no longer declares them. */
  droppedTables: string[];
  /** Destructive ops detected but NOT applied because destructive migrations are
   * disabled (the default). Re-deploy with allowDestructive to apply them. */
  skipped: string[];
}

export interface MigrateOptions {
  /** Apply destructive changes (drop/rebuild/type-change/table-drop). Off by default
   * — data-loss is gated behind an explicit opt-in (env `PRAMEN_ALLOW_DESTRUCTIVE`).
   * Additive changes (create table, add column, add index) always apply. */
  allowDestructive?: boolean;
  /** Scope the migration to a single partition (Durable Object class). When set,
   * migrate operates ONLY on entities whose `partition` matches — it creates/alters
   * just that partition's tables and never drops other partitions' tables (a
   * partition-DO never sees them). The schema hash is stored under a per-partition
   * key so partitions don't thrash each other's drift detection. When unset, all
   * entities are migrated and the legacy single-hash key is used (unchanged — the
   * D1 path and existing callers). */
  partition?: string;
}

/** Internal bookkeeping tables the migrator must never touch — pramen's own, SQLite's,
 * and the substrate's (D1 keeps `_cf_*` / `d1_*` tables in sqlite_master and forbids
 * dropping them). Matched case-insensitively. */
function isInternalTable(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.startsWith("_pramen") ||
    n.startsWith("__pramen") ||
    n.startsWith("sqlite_") ||
    n.startsWith("_cf_") ||
    n.startsWith("d1_")
  );
}

export function schemaHash(schema: SchemaDef): string {
  const canon: Record<string, unknown> = {};
  for (const [table, def] of Object.entries(schema)) canon[table] = def.fields;
  return digest(canon);
}

/** Live columns of a table -> their declared SQL type (uppercased). Empty if the
 * table doesn't exist. */
async function tableColumns(driver: Driver, table: string): Promise<Map<string, string>> {
  const rows = (await driver.exec(`PRAGMA table_info(${quoteIdent(table)})`, [])) as { name: string; type: string }[];
  return new Map(rows.map((r) => [r.name, (r.type || "").toUpperCase()]));
}

async function readMeta(driver: Driver, key: string): Promise<string | undefined> {
  const rows = (await driver.exec(`SELECT value FROM _pramen_meta WHERE key = ?`, [key])) as { value: string }[];
  return rows[0]?.value;
}

async function writeMeta(driver: Driver, key: string, value: string): Promise<void> {
  await driver.exec(`INSERT OR REPLACE INTO _pramen_meta (key, value) VALUES (?, ?)`, [key, value]);
}

/** Rebuild a table to exactly the declared schema: create a temp table, copy each
 * desired column from its source (renamed or same-named live column, CAST on a
 * type change; brand-new columns left NULL), drop the old table, rename the temp. */
async function rebuildTable(driver: Driver, table: string, def: { fields: EntityFields }, live: Map<string, string>): Promise<void> {
  const tmp = `__pramen_rebuild_${table}`;
  await driver.exec(`DROP TABLE IF EXISTS ${quoteIdent(tmp)}`, []);
  await driver.exec(createTableSql(tmp, def), []);

  const destCols: string[] = [];
  const srcExprs: string[] = [];
  for (const [name, field] of Object.entries(def.fields)) {
    const f = field as FieldDef;
    const src = f.renamedFrom && live.has(f.renamedFrom) ? f.renamedFrom : live.has(name) ? name : undefined;
    if (!src) continue; // brand-new column with no source -> leave NULL
    const target = sqlType(f);
    destCols.push(quoteIdent(name));
    srcExprs.push(live.get(src) === target ? quoteIdent(src) : `CAST(${quoteIdent(src)} AS ${target})`);
  }
  if (destCols.length > 0) {
    await driver.exec(`INSERT INTO ${quoteIdent(tmp)} (${destCols.join(", ")}) SELECT ${srcExprs.join(", ")} FROM ${quoteIdent(table)}`, []);
  }
  await driver.exec(`DROP TABLE ${quoteIdent(table)}`, []);
  await driver.exec(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(table)}`, []);
}

export async function migrate(driver: Driver, schema: SchemaDef, opts: MigrateOptions = {}): Promise<MigrationReport> {
  // Static schema invariants (relation targets exist, no cross-partition relations) —
  // checked before any DDL so a bad schema fails fast on boot / the D1 path, not mid-migration.
  validateSchema(schema);
  await driver.exec(`CREATE TABLE IF NOT EXISTS _pramen_meta (key TEXT PRIMARY KEY, value TEXT)`, []);
  const allowDestructive = opts.allowDestructive ?? false;

  // When a partition is named, narrow the schema to just that partition's entities —
  // every later pass (create/alter/rebuild/drop/index/hash) iterates this subset, so
  // a partition-DO only ever touches its own tables. Unset ⇒ the whole schema, the
  // legacy (default) behavior.
  const tables = opts.partition === undefined ? Object.keys(schema) : entitiesInPartition(schema, opts.partition);
  const entries = tables.map((table) => [table, schema[table]!] as const);
  const inScope = new Set(tables);

  // The schema hash is computed over the in-scope subset only, and stored under a
  // per-partition meta key, so two partitions of the same app each detect just their
  // own drift and never invalidate the other. The unscoped path keeps the original
  // `schema_hash` key for backward compatibility (existing stores + the D1 path).
  const subset: SchemaDef = Object.fromEntries(entries);
  const hashKey = opts.partition === undefined ? "schema_hash" : `schema_hash:${opts.partition}`;
  const tablesKey = opts.partition === undefined ? "schema_tables" : `schema_tables:${opts.partition}`;
  const tablesValue = () => JSON.stringify(Object.fromEntries(entries.map(([table, def]) => [table, Object.keys(def.fields)])));
  const current = schemaHash(subset);
  if ((await readMeta(driver, hashKey)) === current) {
    // Backfill the table map for stores migrated before this key existed (the schema
    // is unchanged, so it's exactly what's applied).
    if ((await readMeta(driver, tablesKey)) == null) await writeMeta(driver, tablesKey, tablesValue());
    return { changed: false, created: [], added: [], rebuilt: [], droppedTables: [], skipped: [] };
  }

  const created: string[] = [];
  const added: string[] = [];
  const rebuilt: string[] = [];
  const droppedTables: string[] = [];
  const skipped: string[] = [];

  for (const [table, def] of entries) {
    const existing = await tableColumns(driver, table);
    if (existing.size === 0) {
      await driver.exec(createTableSql(table, def), []);
      created.push(table);
      continue;
    }
    // Pass 1 — additive: add any column the schema declares but the table lacks.
    // SQLite forbids ALTER ADD COLUMN with a non-constant DEFAULT (e.g. expr.now()),
    // so such a column is added via a table rebuild instead — which is still additive
    // (no data loss): the rebuild's INSERT omits the new column, so SQLite applies its
    // CREATE TABLE default, backfilling existing rows. Flagged here, done in Pass 2.
    let needsAdditiveRebuild = false;
    for (const [name, field] of Object.entries(def.fields)) {
      if (existing.has(name)) continue;
      if ((field as FieldDef).defaultExpr !== undefined) {
        needsAdditiveRebuild = true;
        continue;
      }
      await driver.exec(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${addColumnSql(name, field as FieldDef)}`, []);
      added.push(`${table}.${name}`);
    }

    // Pass 2 — destructive: rebuild if any live column must be dropped, a declared
    // column changed type, or a rename hint points at an existing live column.
    const live = await tableColumns(driver, table); // re-read (now includes additively-added columns)
    const desired = new Set(Object.keys(def.fields));
    const renamedSources = new Set<string>();
    for (const f of Object.values(def.fields)) {
      const from = (f as FieldDef).renamedFrom;
      if (from && live.has(from)) renamedSources.add(from);
    }
    const needsDrop = [...live.keys()].some((c) => !desired.has(c) && !renamedSources.has(c));
    const needsTypeChange = Object.entries(def.fields).some(
      ([n, f]) => live.has(n) && live.get(n) !== sqlType(f as FieldDef),
    );
    const destructive = needsDrop || needsTypeChange || renamedSources.size > 0;
    if (destructive && !allowDestructive) {
      // The destructive part is gated off — skip the whole rebuild (any pending
      // expr-default column waits until destructive migrations are allowed).
      skipped.push(`rebuild ${table} (drop/type-change/rename)`);
    } else if (destructive || needsAdditiveRebuild) {
      // An additive-only rebuild (just an expr-default column) needs no permission —
      // it loses no data.
      await rebuildTable(driver, table, def, live);
      rebuilt.push(table);
    }
  }

  // Ensure unique/index declarations (idempotent, via IF NOT EXISTS). Indexes can be
  // added to an existing table without a rebuild; a stale index from a removed
  // declaration is left in place (cleanup is future work).
  for (const [table, def] of entries) {
    for (const stmt of indexStatements(table, def)) await driver.exec(stmt, []);
  }

  // Drop tables the schema no longer declares (internal bookkeeping tables skipped).
  // When scoped to a partition, a live table that belongs to ANOTHER partition's
  // entity must NOT be dropped — a partition-DO never owns it, and even when several
  // partitions share a store the other partition's reconciler owns that table. So the
  // drop candidate set is: live tables that are neither in this scope's declared
  // entities nor declared by any other partition. (Unscoped: `otherPartitionTables`
  // is empty and `inScope` is every entity, so this is the original behavior.)
  const otherPartitionTables =
    opts.partition === undefined ? new Set<string>() : new Set(Object.keys(schema).filter((t) => !inScope.has(t)));
  const liveTables = (await driver.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`, [])) as { name: string }[];
  for (const { name } of liveTables) {
    if (isInternalTable(name) || inScope.has(name) || otherPartitionTables.has(name)) continue;
    if (allowDestructive) {
      await driver.exec(`DROP TABLE ${quoteIdent(name)}`, []);
      droppedTables.push(name);
    } else {
      skipped.push(`drop table ${name}`);
    }
  }

  // Only record the schema as applied when fully reconciled. If destructive changes
  // were skipped, leave the hash so a later deploy (with allowDestructive) retries —
  // additive work is idempotent, so re-running is safe.
  if (skipped.length === 0) {
    await writeMeta(driver, hashKey, current);
    // Persist the applied table→columns so /admin/schema reports it without a raw
    // PRAGMA at request time — workerd's SQLite authorizer rejects PRAGMA once the
    // DO-storage alarm API has run in the object. Migrate runs on boot, before any.
    await writeMeta(driver, tablesKey, tablesValue());
  } else {
    console.warn(
      `pramen: ${skipped.length} destructive migration(s) skipped (set PRAMEN_ALLOW_DESTRUCTIVE=true to apply): ${skipped.join("; ")}`,
    );
  }
  return { changed: true, created, added, rebuilt, droppedTables, skipped };
}
