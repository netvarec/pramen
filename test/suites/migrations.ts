// Data migrations, end-to-end: proves the BOOT WIRING that the unit tests
// (test/data-migrations.test.ts) deliberately don't reach — that a real DO runs
// `app.migrations` after migrate() on its first fetch, records the ledger, and reports it
// over the admin surface. The example app declares two default-partition migrations.
//
// The ledger endpoint is what makes "is it safe to prune this id?" answerable at all:
// migration is lazy and per-DO, so a tenant nobody has touched is still unmigrated and no
// local artifact knows it.

import { assert, http, token } from "../lib";

export async function runMigrations(base: string): Promise<void> {
  const TENANT = "data-migrations";
  const call = http(base, TENANT);
  const admin = await token("admin", ["admin"]);
  const author = await token("mallory", ["author"], { tenants: [TENANT] });

  const ledger = (bearer: string, partition?: string) => {
    const qs = partition ? `&partition=${encodeURIComponent(partition)}` : "";
    const headers = new Headers();
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    return fetch(`${base}/admin/migrations?tenant=${TENANT}${qs}`, { headers }).then(async (r) => ({
      status: r.status,
      body: (await r.json()) as any,
    }));
  };

  // Touch the tenant so its DO boots — migration is lazy, so before a first fetch there is
  // no store at all, let alone a ledger. This has to be a REAL (tenant-authorized) request:
  // reading the ledger deliberately does not boot anything, so a 403'd "boot" would leave
  // nothing to report and every assertion below would be vacuous.
  const booted = await call("listNotes", {}, author);
  assert(booted.status === 200, "migrations: the tenant is booted by a real request first");

  const applied = await ledger(admin);
  assert(applied.status === 200 && applied.body.ok, "migrations: the ledger endpoint answers for a booted tenant");
  assert(applied.body.result.partition === "default", "migrations: the answer names the partition it read");
  const ids = (applied.body.result.applied as { id: string; appliedAt: string }[]).map((a) => a.id);
  assert(
    ids.includes("2026-09-03-backfill-note-meta") && ids.includes("2026-09-03-normalize-signup-status"),
    "migrations: both declared migrations are recorded as applied after the first fetch",
  );
  const stamped = (applied.body.result.applied as { appliedAt: string }[]).every((a) => /^\d{4}-\d{2}-\d{2}T/.test(a.appliedAt));
  assert(stamped, "migrations: each ledger row carries an ISO-8601 appliedAt");

  // Recorded ONCE: a second fetch re-enters ensureMigrated on a warm DO and must not add
  // a duplicate row (the PK would reject it, but the runner should never try).
  await call("listNotes", {}, author);
  const again = await ledger(admin);
  assert(
    (again.body.result.applied as unknown[]).length === (applied.body.result.applied as unknown[]).length,
    "migrations: a second boot adds no ledger rows (recorded once, ever)",
  );

  // The probe is READ-ONLY: asking an UNTOUCHED tenant must not boot it (which would apply
  // every pending migration as a side effect of asking, so `migrations status` could never
  // report PENDING — the one question the command exists to answer). A never-fetched tenant
  // has no ledger table at all, and that reads as "none applied", not as an error.
  const virgin = await fetch(`${base}/admin/migrations?tenant=${TENANT}-untouched`, {
    headers: { authorization: `Bearer ${admin}` },
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  assert(virgin.status === 200 && virgin.body.ok, "migrations: an untouched tenant's ledger answers");
  assert(
    (virgin.body.result.applied as unknown[]).length === 0,
    "migrations: reading the ledger does NOT boot the tenant (still reports none applied)",
  );

  // An unknown partition is rejected rather than minting a junk DO + a permanent registry key.
  assert((await ledger(admin, "nope")).status === 400, "migrations: an unknown partition is a 400");

  // A partition that declares no migrations still answers — with an empty list, not an
  // error about a missing ledger table.
  const audit = await ledger(admin, "audit");
  assert(audit.body.ok && audit.body.result.partition === "audit", "migrations: an unmigrated partition answers");
  assert((audit.body.result.applied as unknown[]).length === 0, "migrations: the audit partition has applied none");

  // --- gate: admin only ---
  assert((await ledger(author)).status === 403, "migrations: a non-admin is denied (403)");
  assert((await ledger("")).status === 403, "migrations: anonymous is denied (403)");
}
