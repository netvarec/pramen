// Stable digest of a query result, for row-level change detection. Two results
// that are deeply equal (modulo object key order) hash the same, so a mutation
// that doesn't change a given subscription's visible rows produces no push.
//
// Re-running the query is cheap (in-process SQLite); the digest gates the
// expensive part — the network push and the client re-render.

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const obj = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(obj[k]))
      .join(",") +
    "}"
  );
}

export function digest(result: unknown): string {
  const s = canonical(result);
  // FNV-1a (32-bit).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}
