// Unit test for the DO registry key scheme + enumeration (runtime/registry.ts).
// The registry is the only source of truth for which (tenant, partition) DOs exist
// (a DurableObjectNamespace has no list API). The bare-key-for-default rule is a
// hard backward-compat requirement — existing single-partition data depends on it.

import { describe, expect, test } from "bun:test";
import { listDOs, parseRegistryKey, registryKey } from "../packages/server/src/runtime/registry";

describe("registryKey / parseRegistryKey", () => {
  test("default partition → bare key", () => {
    expect(registryKey("acme")).toBe("tenant:acme");
    expect(registryKey("acme", "default")).toBe("tenant:acme");
  });

  test("non-default partition → tenant:<t>:<p>", () => {
    expect(registryKey("acme", "audit")).toBe("tenant:acme:audit");
  });

  test("round-trips", () => {
    for (const [t, p] of [["acme", "default"], ["acme", "audit"], ["t1", "logs"]] as const) {
      expect(parseRegistryKey(registryKey(t, p))).toEqual({ tenant: t, partition: p });
    }
  });

  test("bare key parses to default partition", () => {
    expect(parseRegistryKey("tenant:acme")).toEqual({ tenant: "acme", partition: "default" });
    expect(parseRegistryKey("tenant:acme:audit")).toEqual({ tenant: "acme", partition: "audit" });
  });

  test("non-registry key returns null", () => {
    expect(parseRegistryKey("app:foo")).toBeNull();
  });

  test("name containing ':' is rejected", () => {
    expect(() => registryKey("a:b")).toThrow(/must not contain ':'/);
    expect(() => registryKey("acme", "a:b")).toThrow(/must not contain ':'/);
    expect(() => registryKey("")).toThrow(/must not be empty/);
  });
});

describe("listDOs", () => {
  // A fake paginated KVNamespace: serves `keys` in fixed-size pages so the test
  // exercises cursor / list_complete handling past a single page.
  function fakeKv(names: string[], pageSize: number): KVNamespace {
    return {
      list: async (opts?: { prefix?: string; cursor?: string }) => {
        const matched = names.filter((n) => n.startsWith(opts?.prefix ?? ""));
        const start = opts?.cursor ? Number(opts.cursor) : 0;
        const page = matched.slice(start, start + pageSize);
        const next = start + pageSize;
        const complete = next >= matched.length;
        return {
          keys: page.map((name) => ({ name })),
          list_complete: complete,
          ...(complete ? {} : { cursor: String(next) }),
        };
      },
    } as unknown as KVNamespace;
  }

  test("returns the (tenant, partition) pair for a touched tenant + partition", async () => {
    const kv = fakeKv(["tenant:t", "tenant:t:audit"], 100);
    const refs = await listDOs(kv);
    expect(refs).toContainEqual({ tenant: "t", partition: "default" });
    expect(refs).toContainEqual({ tenant: "t", partition: "audit" });
  });

  test("paginates past a single page (no truncation at the page limit)", async () => {
    const names: string[] = [];
    for (let i = 0; i < 2500; i++) names.push(registryKey(`t${i}`));
    names.push(registryKey("t0", "audit"));
    const kv = fakeKv(names, 1000); // 1000-key pages, like real KV

    const refs = await listDOs(kv);
    expect(refs.length).toBe(2501);
    expect(refs).toContainEqual({ tenant: "t0", partition: "default" });
    expect(refs).toContainEqual({ tenant: "t2499", partition: "default" });
    expect(refs).toContainEqual({ tenant: "t0", partition: "audit" });
  });

  test("ignores non-registry keys mixed into the listing", async () => {
    const kv = fakeKv(["tenant:t", "app:other"], 100);
    const refs = await listDOs(kv);
    // prefix filtering already excludes app:*, but parseRegistryKey is the backstop
    expect(refs).toEqual([{ tenant: "t", partition: "default" }]);
  });
});
