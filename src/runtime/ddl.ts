// DDL generation — turns a SchemaDef into CREATE TABLE statements applied to the
// DO's SQLite store on boot. Idempotent (IF NOT EXISTS). The the prior runtime analog lives
// in the Rust the schema layer crate; here it runs in TS inside the isolate.

import type { FieldDef, SchemaDef } from "../sdk/schema";

function columnSql(name: string, f: FieldDef): string {
  // SQLite has no boolean type; store as INTEGER 0/1.
  const sqlType = f.type === "boolean" ? "INTEGER" : f.type.toUpperCase();
  let s = `${name} ${sqlType}`;
  if (f.primaryKey) s += " PRIMARY KEY";
  if (f.autoIncrement) s += " AUTOINCREMENT";
  if (f.notNull && !f.primaryKey) s += " NOT NULL";
  return s;
}

export function schemaDDL(schema: SchemaDef): string[] {
  return Object.entries(schema).map(([table, def]) => {
    const cols = Object.entries(def.fields).map(([n, f]) => columnSql(n, f));
    return `CREATE TABLE IF NOT EXISTS ${table} (${cols.join(", ")})`;
  });
}
