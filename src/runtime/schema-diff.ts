// Schema shape + diff — powers the CLI's `schema diff`. mrak migrations are
// additive (create table, add column), so a diff classifies each change as
// `safe` (applied automatically by migrate() on the next DO boot) or unsafe
// (drops / type changes — NOT applied, left as orphans / needing manual work).

import type { FieldDef, SchemaDef } from "../sdk/schema";

/** table -> column -> field type. The comparable surface of a schema. */
export type SchemaShape = Record<string, Record<string, string>>;

export function schemaShape(schema: SchemaDef): SchemaShape {
  const out: SchemaShape = {};
  for (const [table, def] of Object.entries(schema)) {
    const cols: Record<string, string> = {};
    for (const [col, f] of Object.entries(def.fields)) cols[col] = (f as FieldDef).type;
    out[table] = cols;
  }
  return out;
}

export interface SchemaChange {
  kind: "add-table" | "drop-table" | "add-column" | "drop-column" | "change-type";
  table: string;
  column?: string;
  detail?: string;
  /** true = applied by additive migrate(); false = NOT applied (manual). */
  safe: boolean;
}

export function diffSchemaShape(prev: SchemaShape, next: SchemaShape): SchemaChange[] {
  const changes: SchemaChange[] = [];

  for (const table of Object.keys(next)) {
    if (!(table in prev)) {
      changes.push({ kind: "add-table", table, safe: true });
      continue;
    }
    for (const col of Object.keys(next[table]!)) {
      if (!(col in prev[table]!)) {
        changes.push({ kind: "add-column", table, column: col, safe: true });
      } else if (prev[table]![col] !== next[table]![col]) {
        changes.push({ kind: "change-type", table, column: col, detail: `${prev[table]![col]} → ${next[table]![col]}`, safe: false });
      }
    }
    for (const col of Object.keys(prev[table]!)) {
      if (!(col in next[table]!)) changes.push({ kind: "drop-column", table, column: col, safe: false });
    }
  }

  for (const table of Object.keys(prev)) {
    if (!(table in next)) changes.push({ kind: "drop-table", table, safe: false });
  }

  return changes;
}
