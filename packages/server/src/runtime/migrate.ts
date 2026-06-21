// Schema migration — applied on boot, wrapped in a transaction by the caller.
// Runs over a Driver, so it works on any SQLite-flavored substrate (DO SQLite and
// D1). The introspection (`PRAGMA table_info`, `sqlite_master`) and table-rebuild
// are SQLite-specific; a Postgres/MySQL migrator would be a separate adapter.
// Reconciles the live store with the declared schema in two passes:
//   1. additive (no data loss): missing table -> CREATE TABLE; missing column ->
//      ALTER TABLE ADD COLUMN (nullable).
//   2. destructive: a live column the schema no longer declares is DROPPED, a type
//      change is applied, and a `renamedFrom` column is renamed — all via the
//      standard SQLite table-rebuild (create new, copy, drop old, rename). This is
//      auto-applied: a bad deploy CAN lose data, by design (WIP, no backward-compat).
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
import type { Driver } from "./driver";
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

function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid identifier: ${name}`);
  return name;
}

export function schemaHash(schema: SchemaDef): string {
  const canon: Record<string, unknown> = {};
  for (const [table, def] of Object.entries(schema)) canon[table] = def.fields;
  return digest(canon);
}

/** Live columns of a table -> their declared SQL type (uppercased). Empty if the
 * table doesn't exist. */
async function tableColumns(driver: Driver, table: string): Promise<Map<string, string>> {
  const rows = (await driver.exec(`PRAGMA table_info(${ident(table)})`, [])) as { name: string; type: string }[];
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
  await driver.exec(`DROP TABLE IF EXISTS ${ident(tmp)}`, []);
  await driver.exec(createTableSql(tmp, def), []);

  const destCols: string[] = [];
  const srcExprs: string[] = [];
  for (const [name, field] of Object.entries(def.fields)) {
    const f = field as FieldDef;
    const src = f.renamedFrom && live.has(f.renamedFrom) ? f.renamedFrom : live.has(name) ? name : undefined;
    if (!src) continue; // brand-new column with no source -> leave NULL
    const target = sqlType(f);
    destCols.push(ident(name));
    srcExprs.push(live.get(src) === target ? ident(src) : `CAST(${ident(src)} AS ${target})`);
  }
  if (destCols.length > 0) {
    await driver.exec(`INSERT INTO ${ident(tmp)} (${destCols.join(", ")}) SELECT ${srcExprs.join(", ")} FROM ${ident(table)}`, []);
  }
  await driver.exec(`DROP TABLE ${ident(table)}`, []);
  await driver.exec(`ALTER TABLE ${ident(tmp)} RENAME TO ${ident(table)}`, []);
}

export async function migrate(driver: Driver, schema: SchemaDef, opts: MigrateOptions = {}): Promise<MigrationReport> {
  await driver.exec(`CREATE TABLE IF NOT EXISTS _pramen_meta (key TEXT PRIMARY KEY, value TEXT)`, []);
  const allowDestructive = opts.allowDestructive ?? false;

  const current = schemaHash(schema);
  if ((await readMeta(driver, "schema_hash")) === current)
    return { changed: false, created: [], added: [], rebuilt: [], droppedTables: [], skipped: [] };

  const created: string[] = [];
  const added: string[] = [];
  const rebuilt: string[] = [];
  const droppedTables: string[] = [];
  const skipped: string[] = [];

  for (const [table, def] of Object.entries(schema)) {
    const existing = await tableColumns(driver, table);
    if (existing.size === 0) {
      await driver.exec(createTableSql(table, def), []);
      created.push(table);
      continue;
    }
    // Pass 1 — additive: add any column the schema declares but the table lacks.
    for (const [name, field] of Object.entries(def.fields)) {
      if (existing.has(name)) continue;
      await driver.exec(`ALTER TABLE ${ident(table)} ADD COLUMN ${addColumnSql(name, field as FieldDef)}`, []);
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
    if (needsDrop || needsTypeChange || renamedSources.size > 0) {
      if (allowDestructive) {
        await rebuildTable(driver, table, def, live);
        rebuilt.push(table);
      } else {
        skipped.push(`rebuild ${table} (drop/type-change/rename)`);
      }
    }
  }

  // Ensure unique/index declarations (idempotent, via IF NOT EXISTS). Indexes can be
  // added to an existing table without a rebuild; a stale index from a removed
  // declaration is left in place (cleanup is future work).
  for (const [table, def] of Object.entries(schema)) {
    for (const stmt of indexStatements(table, def)) await driver.exec(stmt, []);
  }

  // Drop tables the schema no longer declares (internal bookkeeping tables skipped).
  const liveTables = (await driver.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`, [])) as { name: string }[];
  for (const { name } of liveTables) {
    if (isInternalTable(name) || name in schema) continue;
    if (allowDestructive) {
      await driver.exec(`DROP TABLE ${ident(name)}`, []);
      droppedTables.push(name);
    } else {
      skipped.push(`drop table ${name}`);
    }
  }

  // Only record the schema as applied when fully reconciled. If destructive changes
  // were skipped, leave the hash so a later deploy (with allowDestructive) retries —
  // additive work is idempotent, so re-running is safe.
  if (skipped.length === 0) {
    await writeMeta(driver, "schema_hash", current);
  } else {
    console.warn(
      `pramen: ${skipped.length} destructive migration(s) skipped (set PRAMEN_ALLOW_DESTRUCTIVE=true to apply): ${skipped.join("; ")}`,
    );
  }
  return { changed: true, created, added, rebuilt, droppedTables, skipped };
}
