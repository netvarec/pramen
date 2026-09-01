// @pramen/cms-editor — a token the SERVER won't accept must end the session.
//
// The editor decided it was signed in from the token's own `exp` claim, parsed client-side.
// That covers exactly one way to stop being signed in. Every other way — the signing secret
// rotated, the account deleted or deactivated, the token revoked onto the denylist, a stored
// token left over from an older deployment — leaves an unexpired `exp` on a token the server
// resolves to NOBODY. And anonymous isn't an error in pramen: the ACL answers it. So the
// editor mounted, `listContentTypes` and `listBlockTypes` 403ed into catches that swallow
// them, `me` came back null, and what rendered was a shell that looked signed in and was
// empty — the tabs collapsed to the pre-types default, no Users tab, no error, nothing to
// click and no way back to the sign-in page.
//
// `me` is the one call that asks the server who it thinks you are, so it is the one that can
// tell "signed in" from "carrying a token nobody accepts".

import { describe, expect, test } from "bun:test";
import { hasIdentity } from "../packages/cms-editor/src/app-context";

describe("hasIdentity", () => {
  test("the server's answer for a token it does not accept is null — that is not a session", () => {
    // Verified against production: `me` with no Authorization header, and with a garbage
    // bearer token, both answer `{ ok: true, result: null }` — a 200, not an error.
    expect(hasIdentity(null)).toBe(false);
    expect(hasIdentity(undefined)).toBe(false);
  });

  test("an identity with a subject is a session", () => {
    expect(hasIdentity({ userId: "someone@example.com", roles: ["admin"] })).toBe(true);
  });

  // The Users tab and the whole editor surface hang off roles, but roles are not what makes
  // a session: an authenticated user with no roles yet (a fresh magic-link recipient, before
  // an admin promotes them) is signed IN. Bouncing them to sign-in would loop them straight
  // back here; they belong in the editor, seeing the access-denied banner.
  test("no roles is still a session — a signed-in user awaiting promotion must not be bounced", () => {
    expect(hasIdentity({ userId: "new@example.com", roles: [] })).toBe(true);
    expect(hasIdentity({ userId: "new@example.com" })).toBe(true);
  });

  test("an identity carrying no subject is the same non-answer as null", () => {
    expect(hasIdentity({})).toBe(false);
    expect(hasIdentity({ userId: "" })).toBe(false);
    expect(hasIdentity({ roles: ["admin"] })).toBe(false);
  });
});
