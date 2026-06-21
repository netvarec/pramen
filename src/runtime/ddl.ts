// DDL generation — CREATE TABLE for a new entity and the additive ALTER fragment
// for a new column. Runs in TS inside the isolate; see runtime/migrate.ts for how
// these are applied.

import type { EntityFields, FieldDef } from "../sdk/schema";

// SQLite has no boolean type; store as INTEGER 0/1. A fileRef is JSON metadata,
// stored as TEXT. Exported for the migrator, which compares declared column types
// (and CASTs on a type change).
export const sqlType = (f: FieldDef): string =>
  f.type === "boolean" ? "INTEGER" : f.type === "fileRef" ? "TEXT" : f.type.toUpperCase();

function columnSql(name: string, f: FieldDef): string {
  let s = `${name} ${sqlType(f)}`;
  if (f.primaryKey) s += " PRIMARY KEY";
  if (f.autoIncrement) s += " AUTOINCREMENT";
  if (f.notNull && !f.primaryKey) s += " NOT NULL";
  return s;
}

export function createTableSql(table: string, def: { fields: EntityFields }): string {
  const cols = Object.entries(def.fields).map(([n, f]) => columnSql(n, f));
  return `CREATE TABLE IF NOT EXISTS ${table} (${cols.join(", ")})`;
}

/** Column definition for ALTER TABLE ADD COLUMN — always nullable, with no
 * PRIMARY KEY / AUTOINCREMENT / NOT NULL (those can't be added to existing rows). */
export function addColumnSql(name: string, f: FieldDef): string {
  return `${name} ${sqlType(f)}`;
}
