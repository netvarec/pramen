// Where the editor sends a minted preview link.
//
// `signPagePreview` returns a token and a url the CMS Worker itself redeems — and that
// endpoint answers with JSON, because a headless CMS has the draft and no idea what it
// should look like. Correct for a machine, and useless for the person a preview link is
// FOR: a stakeholder with no account who opens a wall of braces. So a host may declare
// where ITS OWN site renders one.

import { describe, expect, test } from "bun:test";
import { pagePreviewHref, sitePreviewUrl } from "../packages/cms-editor/src/preview";

const MINT = { url: "/cms/preview?token=abc.def", token: "abc.def" };
/** What `api.resolve` does: make a backend-relative path absolute. */
const resolve = (p: string) => `https://cms.example.com${p}`;
/** The editor's own page — what a declared site route is resolved against. */
const origin = "https://www.example.com/__admin/pages/p1";

describe("the preview href", () => {
  test("with no site route declared, it points at the CMS's own redeem endpoint", () => {
    // The behaviour before this seam existed, and still the right default: a deployment
    // that has not written a preview page has nowhere better to send anyone.
    expect(pagePreviewHref(MINT, { origin, resolve })).toBe("https://cms.example.com/cms/preview?token=abc.def");
  });

  test("a declared site route gets the TOKEN, not the CMS path", () => {
    expect(pagePreviewHref(MINT, { siteUrl: "/preview", origin, resolve }))
      .toBe("https://www.example.com/preview?token=abc.def");
  });

  // The result is COPIED and shown, not only navigated to — half the reason the button exists
  // is to send the link to someone with no account, and `/preview?token=…` in a Slack message
  // is dead. `previewUrl` is normally written as a path, so the CONFIGURED path was the broken
  // one; the new tab hid it, because a blank window opened by the editor inherits its base URL
  // and resolves a relative href perfectly well.
  test("a path-shaped site route is made absolute", () => {
    for (const site of ["/preview", "preview", "/preview?layout=bare"]) {
      expect(pagePreviewHref(MINT, { siteUrl: site, origin, resolve })).toStartWith("https://www.example.com/");
    }
  });

  test("an absolute site route works too — the site is often a different origin", () => {
    expect(pagePreviewHref(MINT, { siteUrl: "https://preview.example.com/p", origin, resolve }))
      .toBe("https://preview.example.com/p?token=abc.def");
  });

  test("a route that already has query params keeps them", () => {
    // `?` twice drops the token into a parameter NAME, and the link fails as a broken page
    // rather than as anything anyone can see.
    expect(pagePreviewHref(MINT, { siteUrl: "/preview?layout=bare", origin, resolve }))
      .toBe("https://www.example.com/preview?layout=bare&token=abc.def");
  });

  test("the token is url-encoded", () => {
    // A JWT is base64url and safe, but the token is a value from the server and this is the
    // one place it becomes a URL — encoding it is not conditional on today's alphabet.
    const href = pagePreviewHref({ url: "/cms/preview", token: "a+b/c=d" }, { siteUrl: "/preview", origin, resolve });
    expect(href).toBe("https://www.example.com/preview?token=a%2Bb%2Fc%3Dd");
  });

  test("an unusable origin degrades to the relative href rather than throwing", () => {
    // Mid-mint is the wrong place to raise on a configuration mistake: the relative href is
    // what this returned before and still opens in the tab that was already opened for it.
    expect(pagePreviewHref(MINT, { siteUrl: "/preview", origin: "not a url", resolve }))
      .toBe("/preview?token=abc.def");
  });
});

describe("reading the declared route", () => {
  test("a non-empty string is taken", () => {
    expect(sitePreviewUrl({ PRAMEN_CMS_EDITOR: { previewUrl: "/preview" } })).toBe("/preview");
    expect(sitePreviewUrl({ PRAMEN_CMS_EDITOR: { previewUrl: "  /preview  " } })).toBe("/preview");
  });

  test("absent, empty or the wrong type falls back rather than building a broken link", () => {
    // `previewUrl: true` would otherwise produce `true?token=…`, which fails as a 404 on the
    // site instead of as a configuration error anyone can read.
    expect(sitePreviewUrl({})).toBeUndefined();
    expect(sitePreviewUrl({ PRAMEN_CMS_EDITOR: {} })).toBeUndefined();
    expect(sitePreviewUrl({ PRAMEN_CMS_EDITOR: { previewUrl: "" } })).toBeUndefined();
    expect(sitePreviewUrl({ PRAMEN_CMS_EDITOR: { previewUrl: "   " } })).toBeUndefined();
    expect(sitePreviewUrl({ PRAMEN_CMS_EDITOR: { previewUrl: true } })).toBeUndefined();
    expect(sitePreviewUrl({ PRAMEN_CMS_EDITOR: { previewUrl: 0 } })).toBeUndefined();
  });
});
