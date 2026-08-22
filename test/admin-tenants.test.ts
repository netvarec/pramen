// The `GET /tenants` contract between @pramen/server and @pramen/admin.
//
// Regression test for a shape mismatch inside our own packages: the server returns
// `DoRef[]` (`{tenant, partition}`), the admin typed the call `string[]` and rendered
// each entry directly as a `<SelectItem>` child. React throws on an object child, so
// the dashboard rendered completely blank for any deployment that had a tenant — i.e.
// all of them. It shipped in 0.0.41 through 0.0.44 because nothing checked that the two
// sides of this call agreed.
//
// The first test is the point of the file: `serverResponse` is annotated `DoRef[]`, the
// server's own exported type, so if `tenant` is ever renamed or the route's shape
// changes, this stops COMPILING (`bun run typecheck`) rather than silently blanking the
// admin again. The rest cover what a client pointed at an unknown deployment can meet.

import { describe, expect, test } from "bun:test";
import { tenantNames, type TenantsResult } from "../packages/admin/src/api";
import type { DoRef } from "../packages/server/src/runtime/registry";

describe("tenantNames parses what GET /tenants returns", () => {
  test("the server's actual DoRef[] shape", () => {
    const serverResponse: DoRef[] = [
      { tenant: "main", partition: "default" },
      { tenant: "acme", partition: "default" },
    ];
    expect(tenantNames(serverResponse)).toEqual(["acme", "main"]);
  });

  test("dedupes a tenant that spans several partitions", () => {
    const serverResponse: DoRef[] = [
      { tenant: "main", partition: "default" },
      { tenant: "main", partition: "eu" },
      { tenant: "main", partition: "us" },
    ];
    expect(tenantNames(serverResponse)).toEqual(["main"]);
  });

  test("sorts, so KV listing order does not reshuffle the picker", () => {
    const serverResponse: DoRef[] = [
      { tenant: "zeta", partition: "default" },
      { tenant: "alpha", partition: "default" },
    ];
    expect(tenantNames(serverResponse)).toEqual(["alpha", "zeta"]);
  });

  // The admin is pointed at arbitrary deployments, so the server on the other end need
  // not be the version that produced this parser.
  test("tolerates a plain string[]", () => {
    expect(tenantNames(["main", "acme", "main"])).toEqual(["acme", "main"]);
  });

  test("never throws on junk — a broken list must not blank the dashboard", () => {
    expect(tenantNames([])).toEqual([]);
    expect(tenantNames(null)).toEqual([]);
    expect(tenantNames(undefined)).toEqual([]);
    expect(tenantNames({ tenant: "main" })).toEqual([]); // object, not array
    expect(tenantNames([null, undefined, 42, {}, { partition: "default" }])).toEqual([]);
    expect(tenantNames([{ tenant: "" }, { tenant: "main" }])).toEqual(["main"]);
  });

  // What actually broke: an object reaching React as a child. Whatever comes back, every
  // element handed to the picker must be a renderable string.
  test("every result is a string, whatever the input", () => {
    const mixed: TenantsResult = [{ tenant: "main", partition: "default" }, "acme", null, 7];
    for (const name of tenantNames(mixed)) expect(typeof name).toBe("string");
  });
});
