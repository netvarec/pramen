// Schema shape + diff — powers the CLI's `schema diff`. migrate() applies every
// change on the next DO boot, additive AND destructive. A diff classifies each as
// `destructive` (drop / type change — rebuilds the table and CAN lose data) or not
// (add table/column — no data loss). A rename can't be detected from a shape diff;
// it shows as drop+add unless declared with `renamedFrom` in the schema.

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
  /** true = rebuilds the table and may lose data (drop / type change); false =
   * additive, no data loss. All changes are auto-applied on the next DO boot. */
  destructive: boolean;
}

export function diffSchemaShape(prev: SchemaShape, next: SchemaShape): SchemaChange[] {
  const changes: SchemaChange[] = [];

  for (const table of Object.keys(next)) {
    if (!(table in prev)) {
      changes.push({ kind: "add-table", table, destructive: false });
      continue;
    }
    for (const col of Object.keys(next[table]!)) {
      if (!(col in prev[table]!)) {
        changes.push({ kind: "add-column", table, column: col, destructive: false });
      } else if (prev[table]![col] !== next[table]![col]) {
        changes.push({ kind: "change-type", table, column: col, detail: `${prev[table]![col]} → ${next[table]![col]}`, destructive: true });
      }
    }
    for (const col of Object.keys(prev[table]!)) {
      if (!(col in next[table]!)) changes.push({ kind: "drop-column", table, column: col, destructive: true });
    }
  }

  for (const table of Object.keys(prev)) {
    if (!(table in next)) changes.push({ kind: "drop-table", table, destructive: true });
  }

  return changes;
}
