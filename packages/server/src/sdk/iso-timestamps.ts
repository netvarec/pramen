// Rewriting timestamps written before `expr.now()` emitted ISO-8601.
//
// `expr.now()` used to emit `datetime('now')` — the `CURRENT_TIMESTAMP` space form,
// `'2026-09-03 21:33:07'`. It now emits `'2026-09-03T21:33:07.222Z'`. Changing a column's
// DEFAULT is a MODIFIER change, so `migrate()` rebuilds the table — and a rebuild copies
// existing values through untouched. New rows would get the new shape and old rows would
// keep the old one, in the same column.
//
// That is worse than either format alone, and the failure is narrower and nastier than
// "the column is inconsistent". Both forms open with the same `YYYY-MM-DD`, so for values
// on DIFFERENT dates the date prefix decides and ordering is still correct. It is values on
// the SAME date that break: index 10 is ` ` (0x20) in the space form and `T` (0x54) in ISO,
// so a same-day space-form value always sorts BEFORE a same-day ISO one whatever the
// time-of-day — 23:00 in the old shape sorts below 01:00 in the new.
//
// Which makes the deploy window itself the blast radius: the rows written just before and
// just after the change are exactly the same-day pairs that invert. And a `{ lte: $now() }`
// policy is the sharp version, because `$now()` is ISO: a space-form value dated today
// always compares as less than it, so a row scheduled for later TODAY reads as already
// published until midnight. Nothing reports any of it.
//
// So the format change comes with a rewrite, and the rewrite is a DATA migration: it is
// imperative, it must run exactly once, and it must fail closed. Declaring it is the app's
// job — this builds it.

import { DEFAULT_PARTITION, ISO_NOW_SQL, entitiesInPartition } from "./schema";
import type { DataMigration, MigrationContext } from "./handlers";
import type { FieldDef, SchemaDef } from "./schema";

/** The old default's SQL, for recognizing a column that carried it. */
export const LEGACY_NOW_SQL = "datetime('now')";

/** Columns to rewrite beyond the ones the schema identifies, as `{ table: [column, …] }`.
 *
 * The schema can only find columns whose DEFAULT is `expr.now()`. A column written by
 * HANDLER code in the same space form — `@pramen/cms` stamped `cms_pages.publishedAt` that
 * way — has no marker on it at all, so the app has to name it. `@pramen/cms` exports its
 * own set as `CMS_LEGACY_TIMESTAMP_COLUMNS`. */
export type ExtraTimestampColumns = Readonly<Record<string, readonly string[]>>;

export interface IsoTimestampBackfillOpts {
  /** Ledger id. Defaults to `pramen:iso-timestamps`. Override only if you have already
   * used that id for something else — it is the key that makes this run once. */
  id?: string;
  /** Partition to run in. A partition-DO only sees its own tables, so an app with several
   * partitions declares one of these per partition, each with its own id. */
  partition?: string;
  /** Columns the schema cannot identify — see {@link ExtraTimestampColumns}. */
  extraColumns?: ExtraTimestampColumns;
}

/**
 * A `DataMigration` that rewrites space-form timestamps to ISO-8601 in place.
 *
 * ```ts
 * import { isoTimestampBackfill } from "@pramen/server";
 * import { CMS_LEGACY_TIMESTAMP_COLUMNS } from "@pramen/cms";
 *
 * export const app = {
 *   migrations: [isoTimestampBackfill({ extraColumns: CMS_LEGACY_TIMESTAMP_COLUMNS })],
 *   // …
 * };
 * ```
 *
 * A **new** deployment can declare it too and pay nothing: every `UPDATE` matches no rows.
 * Declaring it unconditionally is the cheaper habit, because "was this store ever written
 * by an older build?" is not a question the code can answer later.
 *
 * It is not idempotent-by-accident, it is idempotent-by-shape: the `WHERE` matches only the
 * space form, and what it writes is not the space form. That matters because a data
 * migration is not required to be idempotent (it is recorded once) but this one runs over
 * columns an app may also be writing, and a second pass must not corrupt a converted value.
 */
export function isoTimestampBackfill(opts: IsoTimestampBackfillOpts = {}): DataMigration {
  const partition = opts.partition ?? DEFAULT_PARTITION;
  return {
    id: opts.id ?? "pramen:iso-timestamps",
    partition,
    async up(ctx: MigrationContext): Promise<void> {
      for (const [table, columns] of timestampColumns(ctx.schema, partition, opts.extraColumns)) {
        for (const column of columns) {
          // A bulk UPDATE, not a walk: this runs inside `blockConcurrencyWhile` on a
          // tenant's first fetch, so a row-by-row rewrite of a large table is what stalls
          // that request and risks the DO's wall-clock limit.
          //
          // The predicate is deliberately exact rather than "does not look like ISO":
          // length 19 with a space at index 11 (SQLite's `substr` is 1-based) is the space
          // form and nothing else. A column holding some third format an app wrote by hand
          // is left alone, because guessing at it would be a silent rewrite of data this
          // migration does not understand.
          await ctx.driver.exec(
            `UPDATE ${q(table)} SET ${q(column)} = replace(${q(column)}, ' ', 'T') || '.000Z' ` +
              `WHERE ${q(column)} IS NOT NULL AND length(${q(column)}) = 19 AND substr(${q(column)}, 11, 1) = ' '`,
            [],
          );
        }
      }
    },
  };
}

/**
 * Which `(table, column)` pairs this migration touches — the schema's `expr.now()` columns
 * in `partition`, plus whatever the app named.
 *
 * Exported for the tests and for anyone who wants to see the list before running it. An
 * extra column naming a table or column that is not in the schema is IGNORED rather than
 * throwing: the list is a hand-written constant an app may keep across a schema change, and
 * failing the whole boot over a stale entry in it would be a worse outcome than skipping it.
 */
export function timestampColumns(
  schema: SchemaDef,
  partition: string = DEFAULT_PARTITION,
  extra: ExtraTimestampColumns = {},
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const inPartition = new Set(entitiesInPartition(schema, partition));
  for (const table of inPartition) {
    const fields = schema[table]?.fields as Record<string, FieldDef> | undefined;
    if (!fields) continue;
    const cols = Object.entries(fields)
      // Both spellings: a store written by an older build has the legacy default recorded
      // in its own DDL, and `migrate()` may not have rebuilt the table yet when this runs
      // (it does — migrations run after — but the check costs nothing and makes the set
      // independent of that ordering).
      .filter(([, f]) => f.defaultExpr === ISO_NOW_SQL || f.defaultExpr === LEGACY_NOW_SQL)
      .map(([name]) => name);
    if (cols.length > 0) out.set(table, cols);
  }
  for (const [table, columns] of Object.entries(extra)) {
    if (!inPartition.has(table)) continue;
    const fields = schema[table]?.fields as Record<string, FieldDef> | undefined;
    if (!fields) continue;
    const existing = out.get(table) ?? [];
    for (const column of columns) {
      if (fields[column] && !existing.includes(column)) existing.push(column);
    }
    if (existing.length > 0) out.set(table, existing);
  }
  return out;
}

/** Double-quote an identifier for SQLite. Table and column names here come from the app's
 * own schema, never from a request — but the SQL is built by concatenation, so they are
 * quoted rather than trusted to be quote-free. */
const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
