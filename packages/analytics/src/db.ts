// The db type every analytics module narrows to. A leaf module (no imports from the rest of
// the package) so ingest.ts and schedule.ts can share ONE `adb` without importing each other.

import type { HandlerContext } from "@pramen/server";
import type { analyticsSchema } from "./schema";

/** A `ctx.db` narrowed to this package's tables. The handler that calls `ingestEvents` is
 * privileged, so the ACL is not what bounds this; the type is. */
// Reached through `HandlerContext` rather than by importing the `Db` class, which
// `@pramen/server` does not export, and should not have to, for a consumer that only ever
// sees a db through a handler anyway.
export type AnalyticsDb = HandlerContext<typeof analyticsSchema>["db"];

/** Narrow a handler's `ctx.db` to the analytics tables.
 *
 * The same shape `@pramen/cms` uses (`cdb`), and for the same reason: `query`/`mutation`
 * imported from `@pramen/server` are typed against the DEFAULT `SchemaDef`, so annotating a
 * handler's `ctx` with a concrete schema makes it unassignable. `createApp(schema)` is the
 * other way, but a library ships handlers to be spread into someone ELSE's app, and so
 * cannot call it. Coercing the db is the seam that leaves the handler signature alone. */
export const adb = (ctx: HandlerContext): AnalyticsDb => ctx.db as unknown as AnalyticsDb;

/** Most values one `IN (...)` list may bind. DO SQLite caps bound parameters per statement at
 * roughly a hundred, and a list built from a date range or a pruning candidate set is
 * unbounded (two years of days is ~730). The same class of failure as the `with:` eager-load
 * chunking bug, so every list of days goes through {@link chunked}. */
export const IN_CHUNK = 90;

export function chunked<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
