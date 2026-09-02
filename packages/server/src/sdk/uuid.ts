// UUID format validation for `t.uuid()` columns. Platform-agnostic (sdk layer):
// the runtime validates a provided uuid value on write, and mints new ones via the
// global crypto.randomUUID() (Workers/Bun/Node) — see runtime/db.ts.

// Canonical 8-4-4-4-12 hex form, case-insensitive. Version/variant-agnostic so it
// accepts v4 (what we generate) as well as v7 and others a caller might supply.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `v` is a syntactically valid UUID string. */
export function isValidUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
