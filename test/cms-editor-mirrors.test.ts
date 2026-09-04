// The editor's mirrors of @pramen/cms constants.
//
// `@pramen/cms-editor` is a standalone browser app with no server-package dependency — it
// speaks to the CMS purely over HTTP — so a handful of constants are DUPLICATED rather than
// imported. That is a deliberate trade, and it comes with an obligation: something has to
// fail when the two copies drift, or the duplication is just a latent bug with a comment on
// it.
//
// This file is that something. It is the only place in the repo that may import from both
// packages at once, which is precisely why the assertions belong here and not beside either
// copy.
//
// Each mirror is checked for the property that actually matters, which is not always
// equality: `NAV_ORDER` must agree exactly (a host writes `navOrder: NAV_ORDER.media` on
// one side and the editor sorts by it on the other), while a cap only has to be no LOOSER
// on the client — the client cap exists to stop offering an edit the server would reject,
// so a client that is stricter is merely conservative, and one that is looser lets a user
// build something that 400s on save.

import { describe, expect, test } from "bun:test";
import {
  FIELD_TYPES,
  MAX_MENU_DEPTH,
  MEDIA_KINDS,
  NAV_ORDER,
  REDIRECT_STATUSES,
} from "../packages/cms/src/index";
import {
  MAX_MENU_DEPTH as EDITOR_MAX_MENU_DEPTH,
  MEDIA_KIND_LABELS,
  MEDIA_KINDS as EDITOR_MEDIA_KINDS,
  MEDIA_SORT_LABELS,
  MEDIA_SORTS as EDITOR_MEDIA_SORTS,
  NAV_ORDER as EDITOR_NAV_ORDER,
  REDIRECT_STATUSES as EDITOR_REDIRECT_STATUSES,
} from "../packages/cms-editor/src/types";
import { FIELD_TYPES as EDITOR_FIELD_TYPES } from "../packages/cms-editor/src/schema-builder";

describe("mirrors that must match exactly", () => {
  test("NAV_ORDER", () => {
    // A host writes `navOrder: NAV_ORDER.media` in app.ts against the SERVER's table; the
    // editor sorts against its own. A drift puts a section somewhere other than where the
    // host asked for it, silently.
    expect(EDITOR_NAV_ORDER).toEqual(NAV_ORDER);
  });

  test("FIELD_TYPES", () => {
    // The builder offers exactly what the runtime knows. A type it offered and the server
    // did not is a 400 on save; one the server knew and it did not is unauthorable.
    expect(EDITOR_FIELD_TYPES).toEqual(FIELD_TYPES);
  });

  test("REDIRECT_STATUSES", () => {
    // The editor renders this as the status dropdown; the server refuses anything outside
    // it. An extra entry on the client is a select option that always 400s.
    expect([...EDITOR_REDIRECT_STATUSES]).toEqual([...REDIRECT_STATUSES]);
  });
});

describe("caps the client may tighten but never loosen", () => {
  test("MAX_MENU_DEPTH", () => {
    // The editor disables its "nest" control at the limit so it does not offer an edit the
    // save would reject. Stricter is conservative; looser hands the user a 400.
    expect(EDITOR_MAX_MENU_DEPTH).toBeLessThanOrEqual(MAX_MENU_DEPTH);
  });
});

describe("the media library's sort and filter vocabularies", () => {
  test("the type buckets match exactly", () => {
    // The editor renders one chip per kind and sends the string back; the server compiles it
    // into a WHERE. A kind the editor offers and the server does not know is a chip that
    // silently shows everything — the server treats an unrecognised value as absent, which is
    // the right failure and still a failure.
    expect([...EDITOR_MEDIA_KINDS]).toEqual([...MEDIA_KINDS]);
  });

  test("every sort and kind the editor offers has a label", () => {
    // A missing entry renders `undefined` in the menu, which is the kind of hole a type can
    // catch and a test should prove has been caught.
    for (const k of EDITOR_MEDIA_KINDS) expect(MEDIA_KIND_LABELS[k]).toBeTruthy();
    for (const s of EDITOR_MEDIA_SORTS) expect(MEDIA_SORT_LABELS[s]).toBeTruthy();
  });

  test("the sorts are the ones the server resolves", () => {
    // `MediaSort` is a type on the server and a runtime array here, so this is the one place
    // the two can be compared at all. Written out rather than imported from a server-side
    // array, because the server's is a Record's keys and the ORDER of that Record is what the
    // editor's menu shows — pinning the list pins the menu.
    expect([...EDITOR_MEDIA_SORTS]).toEqual(["newest", "oldest", "name", "name_desc", "largest", "smallest"]);
  });
});
