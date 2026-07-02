// Schema migration — applied on boot, wrapped in a transaction by the caller.
// Runs over a Driver, so it works on any SQLite-flavored substrate (DO SQLite and
// D1). The introspection (`PRAGMA table_info`, `sqlite_master`) and table-rebuild
// are SQLite-specific; a Postgres/MySQL migrator would be a separate adapter.
// Reconciles the live store with the declared schema in two passes:
//   1. additive (no data loss): missing table -> CREATE TABLE; missing column ->
//      ALTER TABLE ADD COLUMN (nullable).
//   2. reconcile existing columns + drop obsolete ones. A live column the schema no
//      longer declares is DROPPED, a type change is applied, a `renamedFrom` column is
//      renamed, and a MODIFIER change on an existing column (NOT NULL / DEFAULT /
//      PRIMARY KEY) is enacted — all via the standard SQLite table-rebuild (create new,
//      copy, drop old, rename); UNIQUE is reconciled with a CREATE/DROP INDEX. Each
//      change is classified SAFE (loses no data — applied always: a DEFAULT add/change,
//      dropping a constraint, adding NOT NULL when a backfill/default covers it, adding
//      UNIQUE with no duplicates) or DESTRUCTIVE (GATED behind PRAMEN_ALLOW_DESTRUCTIVE,
//      off by default: a drop, a type change, a rename, a PRIMARY KEY change, adding
//      NOT NULL over NULL rows with no default). Adding UNIQUE over duplicate values is
//      always SKIPPED (the index can't build). `hidden()`/`generated()` are ORM-only —
//      no physical column change, so they don't appear here.
//
// The guiding invariant: the schema hash is recorded ONLY when the store fully matches
// the schema. Any detected change that is SKIPPED (destructive-gated, a UNIQUE-over-
// duplicates, or a partition MOVE — see below) leaves the hash UNWRITTEN, so `schema
// status` keeps reporting drift and a later opt-in / data-fixed deploy retries. This is
// what stops a modifier change (e.g. an unenforced NOT NULL) from silently diverging the
// store from the schema while the hash claims "in sync". Local dev sets the flag on; a
// bad deploy CAN then lose data (WIP, no backward-compat).
//
// A partition MOVE (an entity reassigned to a different Durable Object) is never auto-
// applied — the data can't cross DOs — so it's detected and reported as a skipped manual
// migration (hash withheld), leaving the source DO's data intact.
//
// A schema hash in the internal `_pramen_meta` table lets an unchanged schema skip
// introspection entirely on warm boots. The live table (PRAGMA) is the ground
// truth diffed against the schema — no stored shape needed.
//
// ADD COLUMN is always nullable (SQLite can't add NOT NULL to a populated table).
// A rename can't be inferred from a diff (a removed + added column is ambiguous),
// so it must be declared with `renamedFrom`; otherwise it is applied as drop+add.

import { addColumnSql, createTableSql, defaultSqlValue, indexName, indexStatements, sqlType } from "./ddl";
import { digest } from "./digest";
import { quoteIdent, type Driver } from "./driver";
import { entitiesInPartition, partitionOf, validateSchema } from "../sdk/schema";
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

/** The constraint-bearing facts a migrator compares against a schema field's modifiers:
 * SQL type, NOT NULL, PRIMARY KEY membership, and the raw DEFAULT text (as reported by
 * PRAGMA — e.g. `'pending'`, `1`, `datetime('now')`, or null). */
interface LiveColumn {
  type: string;
  notNull: boolean;
  pk: boolean;
  default: string | null;
}

/** Full live column info (type + modifiers) via PRAGMA table_info. Empty if absent. */
async function liveColumnInfo(driver: Driver, table: string): Promise<Map<string, LiveColumn>> {
  const rows = (await driver.exec(`PRAGMA table_info(${quoteIdent(table)})`, [])) as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  const out = new Map<string, LiveColumn>();
  for (const r of rows) {
    out.set(r.name, {
      type: (r.type || "").toUpperCase(),
      notNull: r.notnull === 1,
      pk: r.pk > 0,
      default: r.dflt_value ?? null,
    });
  }
  return out;
}

/** The columns backed by a single-column UNIQUE index (a `unique()` constraint). Reads
 * PRAGMA index_list + index_info; multi-column indexes are ignored (pramen only emits
 * single-column ones). */
async function liveUniqueColumns(driver: Driver, table: string): Promise<Set<string>> {
  const idx = (await driver.exec(`PRAGMA index_list(${quoteIdent(table)})`, [])) as { name: string; unique: number }[];
  const out = new Set<string>();
  for (const i of idx) {
    if (i.unique !== 1) continue;
    const cols = (await driver.exec(`PRAGMA index_info(${quoteIdent(i.name)})`, [])) as { name: string | null }[];
    if (cols.length === 1 && cols[0]?.name) out.add(cols[0].name);
  }
  return out;
}

/** Does the column currently hold any NULL? (Adding NOT NULL to such a column is
 * unsafe without a backfill default.) */
async function columnHasNulls(driver: Driver, table: string, col: string): Promise<boolean> {
  const rows = await driver.exec(`SELECT 1 FROM ${quoteIdent(table)} WHERE ${quoteIdent(col)} IS NULL LIMIT 1`, []);
  return rows.length > 0;
}

/** Does the column hold a duplicate non-NULL value? (Adding UNIQUE to such a column
 * can't build the index.) NULLs are never "equal" in SQLite, so they're excluded. */
async function columnHasDuplicates(driver: Driver, table: string, col: string): Promise<boolean> {
  const rows = await driver.exec(
    `SELECT ${quoteIdent(col)} FROM ${quoteIdent(table)} WHERE ${quoteIdent(col)} IS NOT NULL GROUP BY ${quoteIdent(col)} HAVING COUNT(*) > 1 LIMIT 1`,
    [],
  );
  return rows.length > 0;
}

/** Normalize a DEFAULT's SQL text for comparison: trim, and strip balanced outer
 * parens (SQLite reports an expr default with or without the wrapping parens the DDL
 * emitted — `(datetime('now'))` vs `datetime('now')` — depending on the engine, so the
 * comparison must not depend on them). */
function normalizeDefault(s: string | null): string | null {
  if (s == null) return null;
  let t = s.trim();
  while (t.length >= 2 && t[0] === "(" && t[t.length - 1] === ")" && outerParensBalanced(t)) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Does the leading `(` in `t` match the trailing `)` (i.e. is the whole string wrapped
 * in one paren group)? Prevents stripping `(a) + (b)`. */
function outerParensBalanced(t: string): boolean {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")") {
      depth--;
      if (depth === 0 && i !== t.length - 1) return false;
    }
  }
  return depth === 0;
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
    let expr = live.get(src) === target ? quoteIdent(src) : `CAST(${quoteIdent(src)} AS ${target})`;
    // Backfill NULLs when the target is NOT NULL and carries a default — makes adding
    // NOT NULL to a column with NULL rows safe (the copy fills them from the default),
    // instead of the INSERT failing the new NOT NULL constraint.
    const notNull = !!f.notNull || !!f.primaryKey;
    const dflt = defaultSqlValue(f);
    if (notNull && dflt !== null) expr = `COALESCE(${expr}, ${dflt})`;
    destCols.push(quoteIdent(name));
    srcExprs.push(expr);
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
  // Per-table: columns whose new `unique()` can't be indexed (duplicate values) — the
  // index pass must skip them so it doesn't throw. They're already reported in `skipped`.
  const uniqueIndexSkip = new Map<string, Set<string>>();

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

    // Pass 2 — reconcile existing columns against the schema. Rebuild the table when a
    // live column must be dropped, a declared column changed type, a rename hint points
    // at an existing live column, or a MODIFIER changed on an existing column (NOT NULL,
    // DEFAULT, PRIMARY KEY). UNIQUE is reconciled with an index (create/drop), no rebuild.
    const liveInfo = await liveColumnInfo(driver, table); // re-read (includes additively-added columns)
    const liveUnique = await liveUniqueColumns(driver, table);
    const live = new Map([...liveInfo].map(([name, info]) => [name, info.type] as const)); // name -> type
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

    // Modifier reconciliation on existing (same-named) columns. A change to NOT NULL /
    // DEFAULT / PRIMARY KEY is enacted by a table rebuild (which reconstructs the column
    // to its exact declared shape); UNIQUE is an index op. Classify each as either a
    // SAFE change (loses no data — applied always) or a DESTRUCTIVE one (gated behind
    // allowDestructive). `hidden()`/`generated()` are ORM-only (no physical column
    // change), so they never appear here.
    let modifierRebuildSafe = false; // default add/change/remove, notNull widen, safe notNull add
    let modifierRebuildDestructive = false; // notNull add over NULL rows w/o default, PK change
    const destructiveReasons: string[] = [];
    const dropUniqueCols: string[] = []; // `unique()` removed -> drop the managed index
    for (const [name, field] of Object.entries(def.fields)) {
      const info = liveInfo.get(name);
      if (!info) continue; // new column (Pass 1) or a rename target — not an existing column
      const f = field as FieldDef;
      const fieldPk = !!f.primaryKey;
      const fieldNotNull = !!f.notNull || fieldPk;

      // DEFAULT add / change / remove — a rebuild backfills existing rows and applies the
      // new default going forward; no data loss.
      if (normalizeDefault(defaultSqlValue(f)) !== normalizeDefault(info.default)) modifierRebuildSafe = true;

      // NOT NULL — PRAGMA reports notnull=0 for a PRIMARY KEY column, so only compare on
      // non-PK columns (PK-ness is compared separately below).
      if (!fieldPk && !info.pk) {
        if (fieldNotNull && !info.notNull) {
          const backfillable = defaultSqlValue(f) !== null;
          if (!backfillable && (await columnHasNulls(driver, table, name))) {
            modifierRebuildDestructive = true;
            destructiveReasons.push(`NOT NULL ${name} (NULL rows, no default)`);
          } else {
            modifierRebuildSafe = true; // no NULLs, or backfilled from the default
          }
        } else if (!fieldNotNull && info.notNull) {
          modifierRebuildSafe = true; // dropping NOT NULL only widens — safe
        }
      }

      // PRIMARY KEY change — reshapes the table's key; treat as destructive.
      if (fieldPk !== info.pk) {
        modifierRebuildDestructive = true;
        destructiveReasons.push(`PRIMARY KEY ${name}`);
      }

      // UNIQUE — reconciled with an index (create/drop), not a rebuild.
      const fieldUnique = !!f.unique;
      if (fieldUnique && !liveUnique.has(name)) {
        // Added: safe only if no duplicate values exist; otherwise the index can't build.
        if (await columnHasDuplicates(driver, table, name)) {
          (uniqueIndexSkip.get(table) ?? uniqueIndexSkip.set(table, new Set()).get(table)!).add(name);
          skipped.push(`add UNIQUE ${table}.${name} (duplicate values present)`);
        }
        // else: the index pass creates it below (no rebuild needed).
      } else if (!fieldUnique && liveUnique.has(name)) {
        dropUniqueCols.push(name); // drop the managed unique index (safe — no data loss)
      }
    }

    const destructive = needsDrop || needsTypeChange || renamedSources.size > 0 || modifierRebuildDestructive;
    if (destructive && !allowDestructive) {
      // The destructive part is gated off — skip the whole rebuild (any pending safe
      // rebuild for this table waits until destructive migrations are allowed).
      const reasons = [
        ...(needsDrop ? ["drop"] : []),
        ...(needsTypeChange ? ["type-change"] : []),
        ...(renamedSources.size > 0 ? ["rename"] : []),
        ...destructiveReasons,
      ];
      skipped.push(`rebuild ${table} (${reasons.join(", ")})`);
    } else if (destructive || needsAdditiveRebuild || modifierRebuildSafe) {
      // A safe rebuild (expr-default column, default/notNull modifier change) needs no
      // permission — it loses no data.
      await rebuildTable(driver, table, def, live);
      rebuilt.push(table);
    }

    // Drop the managed unique index for a column that no longer declares `unique()`. A
    // rebuild already dropped every index (and the index pass won't recreate this one),
    // so this only matters when no rebuild ran — DROP INDEX IF EXISTS is a safe no-op
    // otherwise. No data loss either way.
    for (const col of dropUniqueCols) {
      await driver.exec(`DROP INDEX IF EXISTS ${quoteIdent(indexName(table, col))}`, []);
    }
  }

  // A partition MOVE — an entity that was applied in THIS partition before but the
  // current schema assigns to a DIFFERENT partition — is NOT auto-migratable: the data
  // lives in this DO's SQLite and boot migration can't move it across DOs. Detect it
  // (scoped path only; the unscoped/single-store path never strands data), report it as
  // a skipped manual migration, and leave the table in place so its data is preserved
  // for a hand-run migration. Leaving it in `skipped` also withholds the hash.
  if (opts.partition !== undefined) {
    const prevRaw = await readMeta(driver, tablesKey);
    if (prevRaw) {
      const prevApplied = JSON.parse(prevRaw) as Record<string, string[]>;
      for (const t of Object.keys(prevApplied)) {
        if (!inScope.has(t) && t in schema && partitionOf(schema, t) !== opts.partition) {
          skipped.push(
            `move partition ${t} (${opts.partition} → ${partitionOf(schema, t)}) — data stays in this DO; manual cross-DO migration required`,
          );
        }
      }
    }
  }

  // Ensure unique/index declarations (idempotent, via IF NOT EXISTS). Indexes can be
  // added to an existing table without a rebuild; a stale index from a removed
  // declaration is dropped above. A column whose new `unique()` has duplicate values is
  // skipped (reported above) so this doesn't throw.
  for (const [table, def] of entries) {
    for (const stmt of indexStatements(table, def, uniqueIndexSkip.get(table))) await driver.exec(stmt, []);
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
      `pramen: ${skipped.length} migration(s) skipped, schema hash left unwritten (a gated change needs ` +
        `PRAMEN_ALLOW_DESTRUCTIVE=true; a UNIQUE-over-duplicates or partition move needs a manual fix): ${skipped.join("; ")}`,
    );
  }
  return { changed: true, created, added, rebuilt, droppedTables, skipped };
}
