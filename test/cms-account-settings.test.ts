// The editor's Settings screen offers only the account forms the deployment declares (#81).
// A provider-only deployment (`createOidcAuth`) refuses `changeEmail` and `changePassword`;
// the editor used to draw both anyway, so every save on that screen failed.

import { describe, expect, test } from "bun:test";
import type { HandlerContext } from "@pramen/server";
import { createCmsHandlers } from "../packages/cms/src/index";
import { accountForms } from "../packages/cms-editor/src/components";
import { DEFAULT_CAPABILITIES } from "../packages/cms-editor/src/types";

const accountOf = (opts?: Parameters<typeof createCmsHandlers>[0]) => {
  const h = createCmsHandlers(opts) as unknown as { listCmsCapabilities: { run: (c: HandlerContext) => { account: unknown } } };
  return h.listCmsCapabilities.run({} as HandlerContext).account;
};

describe("listCmsCapabilities().account", () => {
  test("defaults to both forms and no provider", () => {
    expect(accountOf()).toEqual({ changeEmail: true, changePassword: true });
  });

  test("declares what the deployment turns off, and where the account lives", () => {
    expect(
      accountOf({ account: { changeEmail: false, changePassword: false, managedBy: { name: "Graphic Standard", url: "https://app.graphicstandard.com/account" } } }),
    ).toEqual({ changeEmail: false, changePassword: false, managedBy: { name: "Graphic Standard", url: "https://app.graphicstandard.com/account" } });
  });

  test("a provider link that is not http(s) is refused at construction", () => {
    for (const url of ["javascript:alert(1)", "/account", "//evil.example/x", "mailto:a@b.c"]) {
      expect(() => createCmsHandlers({ account: { managedBy: { name: "IdP", url } } })).toThrow("must be an http(s) URL");
    }
    expect(() => createCmsHandlers({ account: { managedBy: { name: "  " } } })).toThrow("managedBy.name is required");
  });
});

describe("accountForms (the Settings card)", () => {
  test("an older server (no `account`) keeps both forms", () => {
    expect(accountForms(DEFAULT_CAPABILITIES.account, true)).toEqual({ showEmail: true, showPassword: true, managedBy: undefined, managedUrl: undefined });
  });

  test("draws nothing account-specific before the probe answers", () => {
    expect(accountForms(DEFAULT_CAPABILITIES.account, false)).toEqual({ showEmail: false, showPassword: false });
  });

  test("a provider-only deployment gets neither form and a link to the provider", () => {
    const out = accountForms({ changeEmail: false, changePassword: false, managedBy: { name: "Graphic Standard", url: "https://gs.example/account" } }, true);
    expect(out).toEqual({ showEmail: false, showPassword: false, managedBy: { name: "Graphic Standard" }, managedUrl: "https://gs.example/account" });
  });

  test("a non-http(s) url from the server is not linked", () => {
    expect(accountForms({ changeEmail: false, changePassword: false, managedBy: { name: "X", url: "javascript:alert(1)" } }, true).managedUrl).toBeUndefined();
  });
});
