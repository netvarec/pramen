// The page editor's workflow transitions.
//
// These were a `status === "review" ? [...] : ...` chain inside a panel component, behind an
// inspector tab labelled "workflow". Publishing is what someone opens the page editor to do,
// so it moved to the toolbar — and on the way out the table became a pure function, which is
// the only form the ORDER can be asserted in: the head is the toolbar's primary button and
// the tail is its overflow menu, so "what is the obvious next move from here" is a contract,
// not a rendering detail.

import { describe, expect, test } from "bun:test";
import { INSPECTOR_TAB_LABELS, INSPECTOR_TABS, pageWorkflowActions } from "../packages/cms-editor/src/components";

const labels = (status: string) => pageWorkflowActions(status).map((a) => a.label);
const handlers = (status: string) => pageWorkflowActions(status).map((a) => a.action);

describe("what a page can do from where it is", () => {
  test("a draft's primary move is Publish", () => {
    expect(handlers("draft")[0]).toBe("publishPage");
    expect(labels("draft")).toEqual(["Publish", "Submit for review"]);
  });

  test("a page in review is waiting for Approve, not for Publish", () => {
    // The reviewer's step comes first; `publishPage` stays reachable so a solo operator is
    // not forced through their own review, but it is not what the primary button offers.
    expect(handlers("review")[0]).toBe("approve");
    expect(handlers("review")).toContain("publishPage");
    expect(handlers("review")).toContain("reject");
  });

  test("a live page can be re-published — that is how an edit reaches the site", () => {
    // The public content API serves the revision snapshot `publishPage` bakes, NOT the page
    // row. Without this action an edit to a live page saves, versions and shows in History
    // while the site keeps serving the text it had at first publish, and the only way
    // through is Unpublish → Publish, which takes the page off the internet to fix a typo.
    expect(handlers("published")[0]).toBe("publishPage");
    expect(labels("published")[0]).toBe("Publish changes");
  });

  test("taking a live page down is still offered, but not as the primary button", () => {
    // Unpublish is the destructive half of this pair and it is no longer what the toolbar
    // pushes at you; it stays reachable in the overflow menu.
    expect(handlers("published")).toContain("unpublishPage");
    expect(handlers("published")[0]).not.toBe("unpublishPage");
  });

  test("the live page's primary label does not read as a no-op", () => {
    // A bare "Publish" on a page that is already published reads as a button belonging to
    // some other page. The word that carries the meaning is what is being published.
    expect(labels("published")[0]).not.toBe("Publish");
    expect(labels("published")[0]).toContain("changes");
  });

  test("rejected and archived get the draft actions — they are editable again", () => {
    // The old chain's `default` branch, made explicit: these are the states you fix and
    // resubmit from, so offering nothing (or offering Approve) would strand the page.
    for (const status of ["rejected", "archived"]) expect(handlers(status)).toEqual(handlers("draft"));
  });

  test("an unknown status still offers a way forward rather than nothing", () => {
    // A status this build has not heard of must not render a toolbar with no actions —
    // the server refuses an invalid transition anyway, and a dead toolbar cannot be argued
    // with. Falls back to the draft set.
    expect(handlers("something-new")).toEqual(handlers("draft"));
  });

  test("every action names a handler and reads as an action", () => {
    for (const status of ["draft", "review", "published", "rejected", "archived"]) {
      for (const a of pageWorkflowActions(status)) {
        expect(a.action).toMatch(/^[a-zA-Z]+$/);
        expect(a.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("the inspector tabs", () => {
  test("every tab has a written-out label", () => {
    // Not a CSS `capitalize`, which renders "seo" as "Seo" and "i18n" as "I18n" — both wrong,
    // in the one place a reader is scanning for the word they want.
    for (const t of INSPECTOR_TABS) expect(INSPECTOR_TAB_LABELS[t]).toBeTruthy();
    expect(INSPECTOR_TAB_LABELS.seo).toBe("SEO");
    expect(INSPECTOR_TAB_LABELS.i18n).not.toBe("I18n");
  });

  test("workflow is not among them", () => {
    expect(INSPECTOR_TABS).not.toContain("workflow");
  });
});
