// The single place an event becomes a row.
//
// Both sinks converge here — the queue consumer and the direct in-request path — and that
// is on purpose. The CMS learned this the expensive way with `dispatchD1`: two entry points
// into "the same" write drift, and the drift is only discovered on whichever store gets
// less traffic. One function, two callers.

import type { HandlerContext } from "@pramen/server";
import { EVENT_KINDS, EVENT_ORIGINS, type AnalyticsEvent } from "./events";
import type { analyticsSchema } from "./schema";

/** A `ctx.db` narrowed to this package's tables. The handler that calls `ingestEvents` is
 * privileged, so the ACL is not what bounds this — the type is. */
// Reached through `HandlerContext` rather than by importing the `Db` class, which
// `@pramen/server` does not export — and should not have to, for a consumer that only ever
// sees a db through a handler anyway.
export type AnalyticsDb = HandlerContext<typeof analyticsSchema>["db"];

/** Narrow a handler's `ctx.db` to the analytics tables.
 *
 * The same shape `@pramen/cms` uses (`cdb`), and for the same reason: `query`/`mutation`
 * imported from `@pramen/server` are typed against the DEFAULT `SchemaDef`, so annotating a
 * handler's `ctx` with a concrete schema makes it unassignable. `createApp(schema)` is the
 * other way — but a library ships handlers to be spread into someone ELSE's app, and so
 * cannot call it. Coercing the db is the seam that leaves the handler signature alone. */
export const adb = (ctx: HandlerContext): AnalyticsDb => ctx.db as unknown as AnalyticsDb;

/** The columns written by an insert, in statement order. `id` is minted here (the raw
 * path skips the `generated()` helper, which runs at the `Db` layer) and `createdAt` is
 * left to its SQL default. */
const COLUMNS = [
  "id", "viewId", "kind", "origin", "ts", "day", "path", "pageId", "referrer", "source",
  "country", "city", "device", "sessionId", "userId", "durationMs", "scrollDepth", "clicks",
] as const;

/** SQLite caps the number of bound variables per statement. 900 is comfortably under every
 * limit involved and keeps a full queue batch to one or two statements. */
const MAX_PARAMS = 900;
const CHUNK = Math.floor(MAX_PARAMS / COLUMNS.length);

/** Reject anything that is not a well-formed event.
 *
 * `/collect` is a PUBLIC, pre-auth endpoint — every field below arrives from whoever chose
 * to POST to it. This is not defensive programming for its own sake: an unchecked `kind`
 * becomes a row that no query counts and no rollup sees, which presents as data silently
 * going missing rather than as an error. */
function isWellFormed(e: AnalyticsEvent): boolean {
  return (
    typeof e.viewId === "string" && e.viewId.length > 0 && e.viewId.length <= 64 &&
    (EVENT_KINDS as readonly string[]).includes(e.kind) &&
    (EVENT_ORIGINS as readonly string[]).includes(e.origin) &&
    typeof e.ts === "string" && e.ts.length > 0 &&
    typeof e.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.day) &&
    typeof e.path === "string" && e.path.length > 0
  );
}

/** Insert a batch of events. Returns how many rows were written.
 *
 * Raw `db.exec` rather than `db.insert` per row, for the reason the data-migration docs
 * give for preferring a bulk statement: this is the one write path that scales with
 * TRAFFIC rather than with editorial activity, and a per-row round trip is what makes a
 * collector fall over. The statement is fully parameterized — no value is interpolated. */
export async function ingestEvents(db: AnalyticsDb, events: readonly AnalyticsEvent[]): Promise<number> {
  const rows = events.filter(isWellFormed);
  if (rows.length === 0) return 0;

  const cols = COLUMNS.map((c) => `"${c}"`).join(", ");
  let written = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const placeholders = slice.map(() => `(${COLUMNS.map(() => "?").join(", ")})`).join(", ");
    const params: (string | number | null)[] = [];
    for (const e of slice) {
      params.push(
        crypto.randomUUID(),
        e.viewId,
        e.kind,
        e.origin,
        e.ts,
        e.day,
        e.path,
        e.pageId ?? null,
        e.referrer ?? null,
        e.source ?? null,
        e.country ?? null,
        e.city ?? null,
        e.device ?? null,
        e.sessionId ?? null,
        e.userId ?? null,
        e.durationMs ?? null,
        e.scrollDepth ?? null,
        e.clicks ?? null,
      );
    }
    await db.exec(`INSERT INTO "analytics_events" (${cols}) VALUES ${placeholders}`, ...params);
    written += slice.length;
  }

  return written;
}

/** The privileged handler both sinks reach. */
export const INGEST_HANDLER = "__analyticsIngest";

/** The role the collector calls it with, and the ONLY role its `auth` accepts.
 *
 * The obvious spelling is `auth: []` — "no role satisfies this" — and it does not work.
 * `[]` is truthy, so `dispatch` runs the gate, and `[].some(...)` is false for every
 * caller INCLUDING `callPrivileged`, whose synthetic identity is just `{ roles: ["admin"] }`
 * and goes through the same check. A handler declared that way is unreachable full stop,
 * not merely unreachable from outside.
 *
 * So the gate names a role instead — a SYSTEM role, `__`-prefixed. That prefix is not a
 * naming convention: `toIdentity` STRIPS such a role from every verified token, so the only
 * way to hold one is to be the Worker (see `SYSTEM_ROLE_PREFIX` in `@pramen/server`).
 *
 * The weaker version of this argument — "no token carries it because nothing writes it" —
 * was wrong, and is worth recording because it is the tempting one: a JWT's `roles` claim is
 * copied verbatim into the identity, and on the verify-only (BYO-IdP) path that claim is
 * written entirely by an external IdP, so a directory group of the same name would have been
 * enough. The invariant has to be enforced at verification; asserting it in a comment is not
 * enforcement.
 *
 * `auth: ["admin"]` would also work and is worse: it would let any admin post fabricated
 * traffic over /rpc, and the collector does not need to be an admin to insert an event. */
export const INGEST_ROLE = "__analytics_ingest";

export interface IngestInput {
  events: AnalyticsEvent[];
}

export async function runIngest(ctx: HandlerContext, input: IngestInput): Promise<{ written: number }> {
  const events = Array.isArray(input?.events) ? input.events : [];
  return { written: await ingestEvents(adb(ctx), events) };
}
