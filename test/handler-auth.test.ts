// Unit test for per-handler authorization (the `auth` option enforced by dispatch).

import { describe, expect, test } from "bun:test";
import { authorizeHandler } from "../packages/server/src/sdk/handlers";
import type { Identity } from "../packages/server/src/sdk/acl";

const anon: Identity | null = null;
const user: Identity = { userId: "u", roles: ["user"] };
const admin: Identity = { userId: "a", roles: ["admin"] };
const editor: Identity = { userId: "e", role: "editor" }; // singular `role` field

describe("authorizeHandler", () => {
  test('"authenticated" requires a non-null identity', () => {
    expect(authorizeHandler("authenticated", anon)).toBe(false);
    expect(authorizeHandler("authenticated", user)).toBe(true);
  });

  test("a role list requires one of the roles; anonymous never qualifies", () => {
    expect(authorizeHandler(["admin"], anon)).toBe(false);
    expect(authorizeHandler(["admin"], user)).toBe(false);
    expect(authorizeHandler(["admin"], admin)).toBe(true);
    expect(authorizeHandler(["admin", "user"], user)).toBe(true);
  });

  test("honors the singular `role` field too", () => {
    expect(authorizeHandler(["editor"], editor)).toBe(true);
    expect(authorizeHandler(["admin"], editor)).toBe(false);
  });

  test("a custom predicate is evaluated as-is", () => {
    expect(authorizeHandler((id) => id?.userId === "u", user)).toBe(true);
    expect(authorizeHandler((id) => id?.userId === "u", admin)).toBe(false);
    expect(authorizeHandler(() => true, anon)).toBe(true); // a predicate may allow anonymous
  });
});
