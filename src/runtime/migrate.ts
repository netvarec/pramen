// Schema migration — applied on DO boot (blockConcurrencyWhile). Reconciles the
// live SQLite store with the schema *additively* and without data loss:
//   - missing table        -> CREATE TABLE
//   - missing column        -> ALTER TABLE ADD COLUMN (nullable)
//
// A schema hash is stored in the internal `_mrak_meta` table so an unchanged
// schema skips introspection entirely on subsequent (warm) boots.
//
// Additive only — column drops, renames, type/constraint changes are NOT applied
// (a removed field leaves its column orphaned). Destructive changes need an
// explicit migration story (roadmap). ADD COLUMN is always nullable because SQLite
// can't add a NOT NULL column to a table that already has rows.

import { addColumnSql, createTableSql } from "./ddl";
import { digest } from "./digest";
import type { SchemaDef } from "../sdk/schema";

export interface MigrationReport {
  changed: boolean;
  created: string[];
  added: string[];
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

function tableColumns(sql: SqlStorage, table: string): Set<string> {
  const rows = sql.exec(`PRAGMA table_info(${ident(table)})`).toArray() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function readMeta(sql: SqlStorage, key: string): string | undefined {
  const rows = sql.exec(`SELECT value FROM _mrak_meta WHERE key = ?`, key).toArray() as { value: string }[];
  return rows[0]?.value;
}

function writeMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec(`INSERT OR REPLACE INTO _mrak_meta (key, value) VALUES (?, ?)`, key, value);
}

export function migrate(sql: SqlStorage, schema: SchemaDef): MigrationReport {
  sql.exec(`CREATE TABLE IF NOT EXISTS _mrak_meta (key TEXT PRIMARY KEY, value TEXT)`);

  const current = schemaHash(schema);
  if (readMeta(sql, "schema_hash") === current) return { changed: false, created: [], added: [] };

  const created: string[] = [];
  const added: string[] = [];

  for (const [table, def] of Object.entries(schema)) {
    const existing = tableColumns(sql, table);
    if (existing.size === 0) {
      sql.exec(createTableSql(table, def));
      created.push(table);
      continue;
    }
    for (const [name, field] of Object.entries(def.fields)) {
      if (existing.has(name)) continue;
      sql.exec(`ALTER TABLE ${ident(table)} ADD COLUMN ${addColumnSql(name, field)}`);
      added.push(`${table}.${name}`);
    }
  }

  writeMeta(sql, "schema_hash", current);
  return { changed: true, created, added };
}
