// DO registry — the source of truth for which `(tenant, partition)` Durable Objects
// exist. A `DurableObjectNamespace` has NO list/enumerate API (only idFromName /
// idFromString / newUniqueId / get), so the platform cannot tell us which DOs were
// ever instantiated. The only way to "work with all DOs" (migrate, recover, browse)
// is this registry we maintain ourselves: each DO self-registers once (durable-object.ts
// `ensureRegistered`), and admin ops enumerate via `listDOs`.
//
// This file owns the KV key scheme so the Worker and the DO agree on the format. It
// is deliberately free of `cloudflare:workers` imports — it takes a `KVNamespace`
// param, mirroring runtime/kv.ts.
//
// KEY SCHEME (hard backward-compat requirement):
//   - default partition  → BARE  `tenant:<t>`        (NO `:default` suffix)
//   - non-default        →       `tenant:<t>:<p>`
// The bare-key-for-default rule keeps existing registry entries and DO routing keys
// unchanged for single-partition apps. Adding a `:default` suffix would orphan all
// existing data, so it must never appear in a key.
//
// NAME RULE: tenant and partition names MUST NOT contain `:`. The key format is
// `tenant:<t>` / `tenant:<t>:<p>`, so a `:` in a name would make parsing ambiguous
// (we couldn't tell where the tenant ends and the partition begins). Names are
// validated at the boundary (here, when building a key) and rejected otherwise.

import { DEFAULT_PARTITION } from "../sdk/schema";

const KEY_PREFIX = "tenant:";

/** A registered Durable Object identity: a (tenant, partition) pair. */
export interface DoRef {
  readonly tenant: string;
  readonly partition: string;
}

/** Reject a tenant/partition name that would make a registry key ambiguous. A name
 * may not be empty and may not contain `:` (the key separator). Throws on violation. */
export function assertValidName(kind: "tenant" | "partition", name: string): void {
  if (name.length === 0) {
    throw new Error(`pramen: ${kind} name must not be empty`);
  }
  if (name.includes(":")) {
    throw new Error(`pramen: ${kind} name "${name}" must not contain ':' (it is the registry key separator)`);
  }
}

/** Build the registry KV key for a `(tenant, partition)`. The default partition keeps
 * the bare `tenant:<t>` key (backward-compat); any other partition is `tenant:<t>:<p>`.
 * Rejects names containing `:` so the key parses unambiguously. */
export function registryKey(tenant: string, partition: string = DEFAULT_PARTITION): string {
  assertValidName("tenant", tenant);
  assertValidName("partition", partition);
  return partition === DEFAULT_PARTITION ? `${KEY_PREFIX}${tenant}` : `${KEY_PREFIX}${tenant}:${partition}`;
}

/** Build the Durable Object NAME for a `(tenant, partition)` — the string passed to
 * `idFromName`. This is the same default/non-default rule as `registryKey` but WITHOUT
 * the KV `tenant:` prefix: the DO namespace and the KV registry are distinct keyspaces.
 * Default partition keeps the BARE `tenant` name (byte-for-byte the pre-partition DO
 * name — a hard backward-compat requirement: changing it would orphan existing DOs);
 * any other partition is `${tenant}:${partition}`. Keeping it next to `registryKey`
 * keeps routing and the registry derived from one place. */
export function partitionDoName(tenant: string, partition: string = DEFAULT_PARTITION): string {
  assertValidName("tenant", tenant);
  assertValidName("partition", partition);
  return partition === DEFAULT_PARTITION ? tenant : `${tenant}:${partition}`;
}

/** Parse a registry KV key back into a `(tenant, partition)`. A bare `tenant:<t>`
 * key yields partition `"default"`; `tenant:<t>:<p>` yields `<p>`. Returns null if
 * the key is not a registry key (missing the `tenant:` prefix). */
export function parseRegistryKey(key: string): DoRef | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const rest = key.slice(KEY_PREFIX.length);
  // At most one `:` remains (names exclude `:`), separating tenant from partition.
  const sep = rest.indexOf(":");
  if (sep === -1) return { tenant: rest, partition: DEFAULT_PARTITION };
  return { tenant: rest.slice(0, sep), partition: rest.slice(sep + 1) };
}

/** Enumerate every registered `(tenant, partition)` pair from the registry KV.
 * Paginates over the full listing (cursor / list_complete) — never truncates at the
 * 1000-key page limit. */
export async function listDOs(kv: KVNamespace): Promise<DoRef[]> {
  const out: DoRef[] = [];
  let cursor: string | undefined;
  for (;;) {
    const res = await kv.list({ prefix: KEY_PREFIX, cursor });
    for (const k of res.keys) {
      const ref = parseRegistryKey(k.name);
      if (ref) out.push(ref);
    }
    if (res.list_complete) break;
    cursor = (res as { cursor?: string }).cursor;
    if (!cursor) break;
  }
  return out;
}
