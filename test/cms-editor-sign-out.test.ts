// @pramen/cms-editor: where a deliberate sign-out goes (`signOutUrl`), and that it still
// passes the unsaved-changes guard. The REAL helpers the editor uses, not a restatement.

import { describe, expect, test } from "bun:test";
import { guardNavigation, signOutDestination } from "../packages/cms-editor/src/app-context";

describe("signOutDestination", () => {
  test("signOutUrl wins over signInUrl", () => {
    expect(signOutDestination({ signInUrl: "/signin/", signOutUrl: "/signout/" }, "")).toBe("/signout/");
  });

  test("without signOutUrl, signing out goes to signInUrl as before", () => {
    expect(signOutDestination({ signInUrl: "/signin/" }, "")).toBe("/signin/");
    expect(signOutDestination({ signInUrl: "/signin/", signOutUrl: "" }, "")).toBe("/signin/");
  });

  test("no external sign-in (or ?setup) means the built-in screen, signOutUrl alone included", () => {
    expect(signOutDestination(undefined, "")).toBeUndefined();
    expect(signOutDestination({ signOutUrl: "/signout/" }, "")).toBeUndefined();
    expect(signOutDestination({ signInUrl: "/signin/", signOutUrl: "/signout/" }, "?setup=1")).toBeUndefined();
  });
});

describe("guardNavigation", () => {
  test("a refused guard keeps the session: nothing runs and it reports false", () => {
    let went = 0;
    expect(guardNavigation(() => false, () => { went++; })()).toBe(false);
    expect(went).toBe(0);
  });

  test("an allowed guard runs the sign-out and reports true", () => {
    let went = 0;
    expect(guardNavigation(() => true, () => { went++; })()).toBe(true);
    expect(went).toBe(1);
  });
});
