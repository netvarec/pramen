// Unit test for handler partition declaration (sdk/handlers.ts) + the Worker's
// partition→DO-key selection rule (which reuses registryKey). The full e2e suite is
// the real gate for the default routing path staying byte-for-byte unchanged; this
// test pins the declaration threading + the key rule without booting a Worker.

import { describe, expect, test } from "bun:test";
import { mutation, query } from "../packages/server/src/sdk/handlers";
import { DEFAULT_PARTITION } from "../packages/server/src/sdk/schema";
import { partitionDoName } from "../packages/server/src/runtime/registry";

describe("handler partition opt", () => {
  test("absent ⇒ undefined (router treats as default)", () => {
    expect(query(() => 1).partition).toBeUndefined();
    expect(mutation(() => 1).partition).toBeUndefined();
    expect(query(() => 1, { input: (r) => r }).partition).toBeUndefined();
  });

  test("threaded from opts onto the handler", () => {
    expect(query(() => 1, { partition: "audit" }).partition).toBe("audit");
    expect(mutation(() => 1, { partition: "audit" }).partition).toBe("audit");
  });
});

describe("partition → DO name (partitionDoName)", () => {
  // The Worker's partitionStubFor names the DO via partitionDoName(tenant, partition).
  // The default partition MUST yield the bare tenant — byte-for-byte the pre-partition
  // idFromName(tenant) — or existing single-partition DOs/data are orphaned.
  test("default partition (and absent opt) ⇒ bare tenant name — backward-compat", () => {
    const partition = query(() => 1).partition ?? DEFAULT_PARTITION;
    expect(partitionDoName("acme", partition)).toBe("acme");
    expect(partitionDoName("acme", DEFAULT_PARTITION)).toBe("acme");
    expect(partitionDoName("acme")).toBe("acme");
  });

  test("declared partition ⇒ <t>:<p>", () => {
    const partition = query(() => 1, { partition: "audit" }).partition ?? DEFAULT_PARTITION;
    expect(partitionDoName("acme", partition)).toBe("acme:audit");
  });
});
