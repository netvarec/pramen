// System roles — the invariant that makes a `__`-prefixed `auth` gate mean anything.
//
// A handler that must be reachable by the server and by NOBODY else names a private role and
// has `callPrivileged` present it (`@pramen/auth`'s OIDC user upsert, `@pramen/analytics`'s
// event ingest). That is only a gate if the role cannot arrive from outside — and it very
// nearly could not be guaranteed: `toIdentity` copies the `roles` claim verbatim, and on the
// verify-only (BYO-IdP) path that claim is written entirely by someone else's directory. A
// group named `__oidc_system` would have been enough to reach a handler that writes arbitrary
// roles to an arbitrary table through an ACL-bypassing `exec`.

import { describe, expect, test } from "bun:test";
import { HmacStrategy, isSystemRole, SYSTEM_ROLE_PREFIX } from "../packages/server/src/auth";
import { resolveIdentity } from "../packages/server/src/auth";
import { OIDC_SYSTEM_ROLE, oidcHandlers, OIDC_UPSERT_HANDLER } from "../packages/auth/src/oidc";
import { authorizeHandler, type HandlerAuth } from "../packages/server/src/sdk/handlers";
import { sign } from "../scripts/jwt";

const SECRET = "a-sufficiently-long-test-secret";

const identityFor = async (claims: Record<string, unknown>) => {
  const jwt = await sign(claims, SECRET);
  return resolveIdentity(new Request("https://x/", { headers: { authorization: `Bearer ${jwt}` } }), new HmacStrategy(SECRET));
};

describe("the reserved prefix", () => {
  test("names the roles only the Worker may present", () => {
    expect(SYSTEM_ROLE_PREFIX).toBe("__");
    expect(isSystemRole(OIDC_SYSTEM_ROLE)).toBe(true);
    expect(isSystemRole("admin")).toBe(false);
    expect(isSystemRole("_admin")).toBe(false);
  });
});

describe("a verified token can never carry one", () => {
  test("an ordinary role survives", async () => {
    expect((await identityFor({ sub: "ada", roles: ["admin", "editor"] }))?.roles).toEqual(["admin", "editor"]);
  });

  // The exact escalation the gate exists to prevent: an IdP group named like a system role.
  test("a system role in the `roles` claim is stripped", async () => {
    const identity = await identityFor({ sub: "mallory", roles: ["user", OIDC_SYSTEM_ROLE] });
    expect(identity?.roles).toEqual(["user"]);
  });

  test("the singular `role` claim is filtered the same way", async () => {
    expect((await identityFor({ sub: "mallory", role: OIDC_SYSTEM_ROLE }))?.roles).toEqual([]);
  });

  // Dropped, not rejected: a colliding directory group is far likelier than an attack, and
  // failing the token would be a denial of service someone else's naming could trigger.
  test("the token still authenticates — the role is dropped, the session is not", async () => {
    const identity = await identityFor({ sub: "mallory", roles: [OIDC_SYSTEM_ROLE] });
    expect(identity).not.toBeNull();
    expect(identity?.userId).toBe("mallory");
  });
});

describe("end to end: the privileged upsert stays out of reach", () => {
  const authOf = (): HandlerAuth => (oidcHandlers[OIDC_UPSERT_HANDLER] as { auth: HandlerAuth }).auth;

  test("a token claiming the system role does NOT satisfy the handler's gate", async () => {
    const forged = await identityFor({ sub: "mallory", roles: [OIDC_SYSTEM_ROLE, "user"] });
    expect(authorizeHandler(authOf(), forged)).toBe(false);
  });

  // Whereas the Worker, which does not go through token verification, still gets in.
  test("callPrivileged's own identity still does", () => {
    expect(authorizeHandler(authOf(), { roles: [OIDC_SYSTEM_ROLE] })).toBe(true);
  });
});
