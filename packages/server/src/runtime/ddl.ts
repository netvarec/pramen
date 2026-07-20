// DDL generation — CREATE TABLE for a new entity and the additive ALTER fragment
// for a new column. Runs in TS inside the isolate; see runtime/migrate.ts for how
// these are applied.

import type { DefaultValue, EntityFields, FieldDef } from "../sdk/schema";
import { quoteIdent } from "./driver";

// SQLite has no boolean type; store as INTEGER 0/1. json + fileRef + uuid are
// stored as TEXT. Exported for the migrator, which compares declared column types
// (and CASTs on a type change).
export const sqlType = (f: FieldDef): string =>
  f.type === "boolean"
    ? "INTEGER"
    : f.type === "json" || f.type === "fileRef" || f.type === "uuid"
      ? "TEXT"
      : f.type.toUpperCase();

/** Render a DEFAULT literal. Strings are single-quote-escaped; booleans → 0/1.
 * Exported for the migrator, which reconstructs a column's expected DEFAULT text to
 * compare against the live `PRAGMA table_info.dflt_value`. */
export function defaultLiteral(v: DefaultValue): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

/** The SQL text of a column's DEFAULT value (the part after `DEFAULT `), or null when
 * the column declares no default. A raw-SQL `defaultExpr` is returned unquoted (e.g.
 * `datetime('now')`); a literal `default` is rendered via {@link defaultLiteral}. Used
 * by the migrator both to detect a default add/change on an existing column and to
 * COALESCE-backfill a NOT NULL column during a rebuild. */
export function defaultSqlValue(f: FieldDef): string | null {
  if (f.defaultExpr !== undefined) return f.defaultExpr;
  if (f.default !== undefined) return defaultLiteral(f.default);
  return null;
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
  let s = `${quoteIdent(name)} ${sqlType(f)}`;
  if (f.primaryKey) s += " PRIMARY KEY";
  if (f.autoIncrement) s += " AUTOINCREMENT";
  if (f.notNull && !f.primaryKey) s += " NOT NULL";
  s += defaultSql(f);
  return s;
}

export function createTableSql(table: string, def: { fields: EntityFields }): string {
  const cols = Object.entries(def.fields).map(([n, f]) => columnSql(n, f));
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (${cols.join(", ")})`;
}

/** Column definition for ALTER TABLE ADD COLUMN. No PRIMARY KEY / AUTOINCREMENT.
 * NOT NULL is only emitted alongside a DEFAULT (SQLite can't add a bare NOT NULL to
 * a populated table); a DEFAULT alone backfills existing rows. */
export function addColumnSql(name: string, f: FieldDef): string {
  let s = `${quoteIdent(name)} ${sqlType(f)}`;
  if (f.notNull && f.default !== undefined) s += " NOT NULL";
  s += defaultSql(f);
  return s;
}

/** Index name for a column's unique/index constraint. */
export function indexName(table: string, col: string): string {
  return `pramen_idx_${table}_${col}`;
}

/** Index name for a composite (multi-column) UNIQUE constraint. The `pramen_uidx_`
 * prefix distinguishes managed composite uniques from single-column `pramen_idx_` ones,
 * so the migrator can enumerate and reconcile just the ones it owns. */
export function compositeUniqueName(table: string, cols: readonly string[]): string {
  return `pramen_uidx_${table}_${cols.join("_")}`;
}

/** Canonical key for a composite-unique column tuple (order-significant, matching the
 * index definition). Used to compare declared vs live composite uniques. */
export function compositeKey(cols: readonly string[]): string {
  return cols.join(",");
}

/** CREATE [UNIQUE] INDEX statements for a table's unique/index columns (idempotent
 * via IF NOT EXISTS). Unique wins if a column declares both. `skipCols` omits specific
 * columns — the migrator uses it to avoid emitting a UNIQUE index that would throw
 * (duplicate values present on a column that just gained `unique()`); that delta is
 * reported as skipped instead. Entity-level composite uniques (`def.uniques`) are
 * emitted too; `skipUniques` omits specific tuples (keyed by {@link compositeKey}). */
export function indexStatements(
  table: string,
  def: { fields: EntityFields; uniques?: readonly (readonly string[])[] },
  skipCols?: ReadonlySet<string>,
  skipUniques?: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const [col, f] of Object.entries(def.fields)) {
    if (!f.unique && !f.index) continue;
    if (skipCols?.has(col)) continue;
    const kind = f.unique ? "UNIQUE INDEX" : "INDEX";
    out.push(`CREATE ${kind} IF NOT EXISTS ${quoteIdent(indexName(table, col))} ON ${quoteIdent(table)} (${quoteIdent(col)})`);
  }
  for (const cols of def.uniques ?? []) {
    if (cols.length === 0 || skipUniques?.has(compositeKey(cols))) continue;
    const colList = cols.map((c) => quoteIdent(c)).join(", ");
    out.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(compositeUniqueName(table, cols))} ON ${quoteIdent(table)} (${colList})`);
  }
  return out;
}
