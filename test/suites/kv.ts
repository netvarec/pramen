// ctx.kv: handlers can read/write the project KV. It is GLOBAL across tenants
// (config/flags/cache), unlike ctx.db which is per-tenant — a value set while
// addressing one tenant is visible while addressing another.

import { assert, http, token } from "../lib";

export async function runKv(base: string): Promise<void> {
  const admin = await token("admin", ["admin"]); // admin may address any tenant
  const inA = http(base, "kv-demo-a");
  const inB = http(base, "kv-demo-b");

  // missing key -> null
  const miss = await inA("getConfig", { key: "greeting" }, admin);
  assert(miss.body.ok && miss.body.result === null, "ctx.kv.get returns null for a missing key");

  // write while addressing tenant A
  const set = await inA("setConfig", { key: "greeting", value: "hello" }, admin);
  assert(set.body.result?.value === "hello", "ctx.kv.put writes a value");

  // read it back while addressing tenant B -> KV is global, not per-tenant
  const fromB = await inB("getConfig", { key: "greeting" }, admin);
  assert(fromB.body.result === "hello", "ctx.kv is global across tenants (read from a different tenant)");

  // overwrite
  await inB("setConfig", { key: "greeting", value: "hola" }, admin);
  const after = await inA("getConfig", { key: "greeting" }, admin);
  assert(after.body.result === "hola", "ctx.kv reflects the latest write across tenants");
}
