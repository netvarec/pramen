// Row-level grants for the analytics tables.
//
// There is no public fragment, unlike `cmsPolicies`. A published page is meant to be read
// by anyone; its traffic is not, and an anonymous read grant on `analytics_events` would
// hand every visitor the site's numbers — and, because a row carries `country`, `city`,
// `path` and a per-day session pseudonym, a partial view of what other visitors did.
//
// The COLLECTOR needs none of these. Ingest goes through `db.exec`, the documented raw
// escape hatch, from a handler only `callPrivileged` can reach — so writing an event
// requires no role at all, and no role can be granted one by accident.

import { allow, policy, type Policy } from "@pramen/server";

const TABLES = ["analytics_events", "analytics_daily", "analytics_pages"] as const;

export interface AnalyticsPolicyOpts {
  /** Distinguishes policy names when the fragment is spread into more than one role —
   * duplicate names on the same (role, entity, action) OR-merge, so the wider grant would
   * silently win. Same reason `cmsPolicies` takes one. */
  prefix?: string;
}

/**
 * `viewer` — read the three tables. Spread into whichever role opens the dashboard.
 * `admin`  — read plus write, for the rollup when it is run from the admin mutation
 *            rather than from a task (a task context is already system-scoped).
 */
export function analyticsPolicies(opts: AnalyticsPolicyOpts = {}): { viewer: Policy[]; admin: Policy[] } {
  const p = opts.prefix ?? "analytics";
  const viewer: Policy[] = TABLES.map((t) => policy(`${p}:viewer:${t}:read`, t, "read", allow()));
  const admin: Policy[] = [];
  for (const t of TABLES) {
    for (const action of ["read", "create", "update", "delete"] as const) {
      admin.push(policy(`${p}:admin:${t}:${action}`, t, action, allow()));
    }
  }
  return { viewer, admin };
}
