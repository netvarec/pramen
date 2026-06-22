// DDL generation — CREATE TABLE for a new entity and the additive ALTER fragment
// for a new column. Runs in TS inside the isolate; see runtime/migrate.ts for how
// these are applied.

import type { DefaultValue, EntityFields, FieldDef } from "../sdk/schema";

// SQLite has no boolean type; store as INTEGER 0/1. json + fileRef + uuid are
// stored as TEXT. Exported for the migrator, which compares declared column types
// (and CASTs on a type change).
export const sqlType = (f: FieldDef): string =>
  f.type === "boolean"
    ? "INTEGER"
    : f.type === "json" || f.type === "fileRef" || f.type === "uuid"
      ? "TEXT"
      : f.type.toUpperCase();

/** Render a DEFAULT literal. Strings are single-quote-escaped; booleans → 0/1. */
function defaultLiteral(v: DefaultValue): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

/** The ` DEFAULT x` fragment for a column, or "" when it has no default. A raw-SQL
 * `defaultExpr` (e.g. `datetime('now')`) is emitted UNQUOTED; a literal `default` is
 * quote-escaped. UNIQUE/index are NOT inline — they're emitted as separate index
 * statements so the same code path serves both CREATE TABLE and ALTER TABLE ADD COLUMN. */
function defaultSql(f: FieldDef): string {
  // A raw-SQL default is parenthesized: SQLite's column-DEFAULT grammar only takes a
  // bare literal/keyword, so a function call (e.g. datetime('now')) must be wrapped —
  // `DEFAULT (datetime('now'))`. Parens are harmless around a keyword too.
  if (f.defaultExpr !== undefined) return ` DEFAULT (${f.defaultExpr})`;
  return f.default !== undefined ? ` DEFAULT ${defaultLiteral(f.default)}` : "";
}

function columnSql(name: string, f: FieldDef): string {
  let s = `${name} ${sqlType(f)}`;
  if (f.primaryKey) s += " PRIMARY KEY";
  if (f.autoIncrement) s += " AUTOINCREMENT";
  if (f.notNull && !f.primaryKey) s += " NOT NULL";
  s += defaultSql(f);
  return s;
}

export function createTableSql(table: string, def: { fields: EntityFields }): string {
  const cols = Object.entries(def.fields).map(([n, f]) => columnSql(n, f));
  return `CREATE TABLE IF NOT EXISTS ${table} (${cols.join(", ")})`;
}

/** Column definition for ALTER TABLE ADD COLUMN. No PRIMARY KEY / AUTOINCREMENT.
 * NOT NULL is only emitted alongside a DEFAULT (SQLite can't add a bare NOT NULL to
 * a populated table); a DEFAULT alone backfills existing rows. */
export function addColumnSql(name: string, f: FieldDef): string {
  let s = `${name} ${sqlType(f)}`;
  if (f.notNull && f.default !== undefined) s += " NOT NULL";
  s += defaultSql(f);
  return s;
}

/** Index name for a column's unique/index constraint. */
export function indexName(table: string, col: string): string {
  return `pramen_idx_${table}_${col}`;
}

/** CREATE [UNIQUE] INDEX statements for a table's unique/index columns (idempotent
 * via IF NOT EXISTS). Unique wins if a column declares both. */
export function indexStatements(table: string, def: { fields: EntityFields }): string[] {
  const out: string[] = [];
  for (const [col, f] of Object.entries(def.fields)) {
    if (!f.unique && !f.index) continue;
    const kind = f.unique ? "UNIQUE INDEX" : "INDEX";
    out.push(`CREATE ${kind} IF NOT EXISTS ${indexName(table, col)} ON ${table} (${col})`);
  }
  return out;
}
