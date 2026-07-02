// Schema shape + diff — powers the CLI's `schema diff`. The diff is a REPORTING tool; it
// does not itself migrate. On the next DO boot migrate() applies ADDITIVE changes only
// (new table -> CREATE TABLE; new column -> ALTER TABLE ADD COLUMN). DESTRUCTIVE changes
// (drop column/table, type change, table rebuild) are SKIPPED unless the deploy sets
// PRAMEN_ALLOW_DESTRUCTIVE=true — and when skipped the schema hash is left unwritten so a
// later opt-in deploy retries. A rename can't be detected from a shape diff; it shows as
// drop+add unless declared with `renamedFrom` in the schema.
//
// The shape records column type + the migration-relevant modifiers (notNull, unique,
// primaryKey, generated, default, hidden) and the entity's partition, so the diff REPORTS
// modifier and partition changes too. migrate() now RECONCILES modifier changes on an
// existing column (a NOT NULL / DEFAULT / PRIMARY KEY change via a rebuild, a UNIQUE
// change via a create/drop index), so a `change-column` is `appliesOnBoot: true`. It is
// flagged `destructive` when it tightens a constraint (adds NOT NULL / UNIQUE / PRIMARY
// KEY) — those apply only under PRAMEN_ALLOW_DESTRUCTIVE, or are skipped when the live
// data conflicts (NULL rows / duplicates), leaving the hash unwritten. A partition MOVE
// still CANNOT be enacted on boot (a partition is a separate Durable Object — it needs a
// manual cross-DO data migration), so it stays `appliesOnBoot: false`.

import type { FieldDef, SchemaDef } from "../sdk/schema";
import { partitionOf } from "../sdk/schema";

/** The comparable fingerprint of a single column: type + migration-relevant modifiers. */
export interface ColumnShape {
  type: string;
  notNull?: boolean;
  unique?: boolean;
  primaryKey?: boolean;
  generated?: boolean;
  hidden?: boolean;
  /** The literal or raw-SQL default, normalized to a string for comparison. */
  default?: string;
}

/** The comparable fingerprint of a table: its partition + each column's shape. */
export interface TableShape {
  partition: string;
  columns: Record<string, ColumnShape>;
}

/** table -> table shape. The comparable surface of a schema. */
export type SchemaShape = Record<string, TableShape>;

function columnShape(f: FieldDef): ColumnShape {
  const c: ColumnShape = { type: f.type };
  if (f.notNull) c.notNull = true;
  if (f.unique) c.unique = true;
  if (f.primaryKey) c.primaryKey = true;
  if (f.generated) c.generated = true;
  if (f.hidden) c.hidden = true;
  if (f.defaultExpr !== undefined) c.default = `(${f.defaultExpr})`;
  else if (f.default !== undefined) c.default = JSON.stringify(f.default);
  return c;
}

export function schemaShape(schema: SchemaDef): SchemaShape {
  const out: SchemaShape = {};
  for (const [table, def] of Object.entries(schema)) {
    const columns: Record<string, ColumnShape> = {};
    for (const [col, f] of Object.entries(def.fields)) columns[col] = columnShape(f as FieldDef);
    out[table] = { partition: partitionOf(schema, table), columns };
  }
  return out;
}

/** The modifier fields compared for a `change-column` (everything but `type`). */
const MODIFIER_KEYS: (keyof ColumnShape)[] = ["notNull", "unique", "primaryKey", "generated", "hidden", "default"];

/** Does `next` tighten a constraint `prev` lacked (add NOT NULL / UNIQUE / PRIMARY KEY)?
 * Such a change may require the destructive gate or be skipped when the live data
 * conflicts (NULL rows / duplicates) — so the diff flags it `destructive`. */
function tightensConstraint(prev: ColumnShape, next: ColumnShape): boolean {
  return (!!next.notNull && !prev.notNull) || (!!next.unique && !prev.unique) || (!!next.primaryKey && !prev.primaryKey);
}

function modifierDiff(prev: ColumnShape, next: ColumnShape): string | null {
  const parts: string[] = [];
  for (const k of MODIFIER_KEYS) {
    if (prev[k] !== next[k]) parts.push(`${k}: ${fmt(prev[k])} → ${fmt(next[k])}`);
  }
  return parts.length ? parts.join(", ") : null;
}

function fmt(v: unknown): string {
  return v === undefined ? "—" : String(v);
}

export interface SchemaChange {
  kind: "add-table" | "drop-table" | "add-column" | "drop-column" | "change-type" | "change-column" | "move-partition";
  table: string;
  column?: string;
  detail?: string;
  /** true = rebuilds the table and may lose data (drop / type change). false = additive
   * OR a metadata-only change (modifier / partition move) — see `appliesOnBoot`. */
  destructive: boolean;
  /** Whether migrate() enacts this change on the next DO boot. Additive changes are
   * always applied; destructive changes (type/drop, or a constraint-tightening modifier
   * change) apply only when the deploy sets PRAMEN_ALLOW_DESTRUCTIVE=true (and are
   * skipped when the live data conflicts, leaving the hash unwritten). `false` here means
   * the boot migrator will NEVER enact it — today only a partition MOVE (needs a manual
   * cross-DO data migration). Reported for honesty. */
  appliesOnBoot: boolean;
}

export function diffSchemaShape(prev: SchemaShape, next: SchemaShape): SchemaChange[] {
  const changes: SchemaChange[] = [];

  for (const table of Object.keys(next)) {
    const pt = prev[table];
    if (!pt) {
      changes.push({ kind: "add-table", table, destructive: false, appliesOnBoot: true });
      continue;
    }
    const nt = next[table]!;
    if (pt.partition !== nt.partition) {
      changes.push({
        kind: "move-partition",
        table,
        detail: `${pt.partition} → ${nt.partition}`,
        destructive: false,
        // A partition is a separate Durable Object; boot migration can't move a table's
        // data across DOs. Needs a manual data migration.
        appliesOnBoot: false,
      });
    }
    for (const col of Object.keys(nt.columns)) {
      const pc = pt.columns[col];
      const ncol = nt.columns[col]!;
      if (!pc) {
        changes.push({ kind: "add-column", table, column: col, destructive: false, appliesOnBoot: true });
      } else if (pc.type !== ncol.type) {
        changes.push({
          kind: "change-type",
          table,
          column: col,
          detail: `${pc.type} → ${ncol.type}`,
          destructive: true,
          // Applied only under PRAMEN_ALLOW_DESTRUCTIVE (a table rebuild). Report it as
          // boot-applicable — the destructive-gating note explains the opt-in.
          appliesOnBoot: true,
        });
      } else {
        const md = modifierDiff(pc, ncol);
        if (md) {
          changes.push({
            kind: "change-column",
            table,
            column: col,
            detail: md,
            // Tightening a constraint (add NOT NULL / UNIQUE / PRIMARY KEY) rebuilds/
            // indexes and applies only under PRAMEN_ALLOW_DESTRUCTIVE (or is skipped when
            // live data conflicts). Loosening or a DEFAULT change is additive.
            destructive: tightensConstraint(pc, ncol),
            // migrate() now reconciles modifier changes on an existing column on boot.
            appliesOnBoot: true,
          });
        }
      }
    }
    for (const col of Object.keys(pt.columns)) {
      if (!(col in nt.columns))
        changes.push({ kind: "drop-column", table, column: col, destructive: true, appliesOnBoot: true });
    }
  }

  for (const table of Object.keys(prev)) {
    if (!(table in next)) changes.push({ kind: "drop-table", table, destructive: true, appliesOnBoot: true });
  }

  return changes;
}
