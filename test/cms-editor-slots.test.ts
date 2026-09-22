// @pramen/cms-editor: the seams a theme uses, as pure functions.
//
// Every hook here replaced a build-time string replacement a real deployment was running
// against our source (see the CHANGELOG entry "Override slots and nav hooks"), so the cases are
// that deployment's cases: hide an entry in favour of a panel and keep something lit, move a
// schema link from the nav into the account menu, turn search off. The components that render
// the answers are thin; the answers are decided here, where a test needs no DOM.
//
// The build-time half (that a slot module actually lands in the bundle) is in
// `cms-editor-host-build.test.ts`.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EDITOR_CONTROLS, readControlsConfig, resolveHiddenControls } from "../packages/cms-editor/src/controls";
import { homeLanding, mediaTile } from "../packages/cms-editor/src/components";
import {
  accountMenuFor,
  applyNavTransform,
  buildNav,
  navSections,
  readAccountMenuConfig,
  resolveAccountMenu,
  type NavEntry,
  type NavSection,
} from "../packages/cms-editor/src/nav";
import { EDITOR_PAGES, type AccountMenuItem, type NavContext, type NavHooks } from "../packages/cms-editor/src/slots";
import { DEFAULT_CAPABILITIES, type AdminPageMeta, type ContentType, type Media } from "../packages/cms-editor/src/types";

// Every resolver here warns rather than throws, by design; keep the suite's output readable and
// let the tests that care assert on the warning.
let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

const TYPES: ContentType[] = [
  { id: "t-page", name: "Pages", slug: "page" },
  { id: "t-akce", name: "Events", slug: "akce" },
];
const EVENTS_PANEL: AdminPageMeta = { slug: "akce", label: "Events · venues and times", kind: "panel" };

/** The nav a split-by-type deployment with an events panel builds for an admin who may author
 * the schema: the shape the first deployment to need these hooks has. */
function builtNav(): NavSection[] {
  return navSections(
    buildNav({
      collections: [],
      adminPages: [EVENTS_PANEL],
      contentTypes: TYPES,
      cms: { ...DEFAULT_CAPABILITIES, pagesByType: true, canEdit: true },
      hidePages: false,
      splitByType: true,
      isAdmin: true,
      extraNav: [],
    }),
  );
}

const keys = (sections: NavSection[]) => sections.map((s) => s.entries.map((e) => e.key));
const ctx = (over: Partial<NavContext> = {}): NavContext => ({ sections: builtNav(), active: "", isAdmin: true, me: { userId: "ed" }, ...over });

/** That deployment's own transform, ported: one "Events" entry (the panel) instead of the
 * content type AND the panel, Types and Settings gone from the nav, and the content type's
 * route lighting the panel's entry. */
const praha: NavHooks = {
  transformNav: ({ sections, active }) => {
    const hasPanel = sections.some((s) => s.entries.some((e) => e.key === "app:akce"));
    const drop = (e: NavEntry) => (hasPanel && e.key === "type:akce") || e.key === "types" || e.key === "settings";
    const rename = (e: NavEntry): NavEntry => (e.kind === "route" && e.key === "app:akce" ? { ...e, label: "Events" } : e);
    return {
      sections: sections.map((s) => ({ ...s, entries: s.entries.filter((e) => !drop(e)).map(rename) })),
      active: hasPanel && active === "type:akce" ? "app:akce" : active,
    };
  },
  accountMenu: [{ label: "Content structure", page: "schema", icon: "types", requiresNav: "types" }],
};

describe("transformNav", () => {
  test("no hook is the editor's own nav, untouched", () => {
    const c = ctx({ active: "media" });
    const out = applyNavTransform({}, c);
    expect(out.sections).toBe(c.sections);
    expect(out.active).toBe("media");
  });

  test("renames, hides and remaps the lit entry, for both chromes at once", () => {
    const out = applyNavTransform(praha, ctx({ active: "type:akce" }));
    const flat = out.sections.flatMap((s) => s.entries);
    expect(flat.map((e) => e.key)).not.toContain("type:akce");
    expect(flat.map((e) => e.key)).not.toContain("types");
    expect(flat.find((e) => e.key === "app:akce")).toMatchObject({ label: "Events" });
    // The content type's route still lights something: the panel that replaced its entry.
    expect(out.active).toBe("app:akce");
  });

  test("a section the transform emptied is dropped, not rendered as a dead dropdown", () => {
    const out = applyNavTransform({ transformNav: ({ sections, active }) => ({ sections: sections.map((s) => (s.id === "apps" ? { ...s, entries: [] } : s)), active }) }, ctx());
    expect(out.sections.map((s) => s.id)).not.toContain("apps");
    expect(out.sections.every((s) => s.entries.length > 0)).toBe(true);
  });

  test("the input is left alone, since it is also what `requiresNav` reads", () => {
    const c = ctx();
    const before = JSON.stringify(c.sections);
    applyNavTransform(praha, c);
    expect(JSON.stringify(c.sections)).toBe(before);
  });

  test("a hook that throws or returns junk costs the transform, never the admin", () => {
    const c = ctx({ active: "media" });
    const threw = applyNavTransform({ transformNav: () => { throw new Error("boom"); } }, c);
    expect(threw).toEqual({ sections: c.sections, active: "media" });
    for (const junk of [undefined, null, {}, { sections: "x", active: "" }, { sections: [], active: 1 }, { sections: [{}], active: "" }]) {
      expect(applyNavTransform({ transformNav: () => junk as never }, c)).toEqual({ sections: c.sections, active: "media" });
    }
    expect(error).toHaveBeenCalled();
  });
});

describe("account menu rows", () => {
  test("`requiresNav` reads the nav as BUILT, so hiding an entry does not hide its replacement", () => {
    // Praha hides `types` from the nav and offers it here; checked after the transform the
    // row would vanish with the entry it stands in for.
    const rows = accountMenuFor(praha.accountMenu ?? [], ctx());
    expect(rows.map((r) => r.label)).toEqual(["Content structure"]);
  });

  test("a session without the capability does not get the row", () => {
    const withoutTypes = builtNav().map((s) => ({ ...s, entries: s.entries.filter((e) => e.key !== "types") }));
    expect(accountMenuFor(praha.accountMenu ?? [], ctx({ sections: withoutTypes }))).toEqual([]);
  });

  test("`visible` decides for a theme, and a throwing predicate hides only its own row", () => {
    const items: AccountMenuItem[] = [
      { label: "Admins only", page: "users", visible: (c) => c.isAdmin },
      { label: "Broken", page: "media", visible: () => { throw new Error("nope"); } },
      { label: "Always", page: "settings" },
    ];
    expect(accountMenuFor(items, ctx()).map((r) => r.label)).toEqual(["Admins only", "Always"]);
    expect(accountMenuFor(items, ctx({ isAdmin: false })).map((r) => r.label)).toEqual(["Always"]);
  });
});

describe("accountMenu in runtime config", () => {
  test("unconfigured is no rows", () => {
    expect(resolveAccountMenu(undefined)).toEqual([]);
    expect(resolveAccountMenu(null)).toEqual([]);
    expect(readAccountMenuConfig(undefined)).toBeUndefined();
    expect(readAccountMenuConfig({ PRAMEN_CMS_EDITOR: {} })).toBeUndefined();
  });

  test("a well-formed row is kept, trimmed, with only the fields it may carry", () => {
    const host = { PRAMEN_CMS_EDITOR: { accountMenu: [{ label: " Structure ", page: "schema", icon: "types", requiresNav: " types ", visible: "x" }] } };
    expect(resolveAccountMenu(readAccountMenuConfig(host))).toEqual([{ label: "Structure", page: "schema", icon: "types", requiresNav: "types" }]);
    expect(resolveAccountMenu([{ label: "Lectures", page: "collection", params: { slug: "lectures", n: 3 } }])).toEqual([
      { label: "Lectures", page: "collection", params: { slug: "lectures" } },
    ]);
  });

  test("a row that would navigate nowhere is dropped with a warning, never thrown on", () => {
    const junk: unknown[] = [
      { label: "x", page: "nope" },
      { label: "", page: "schema" },
      { page: "schema" },
      { label: "x" },
      "schema",
      null,
      42,
    ];
    expect(() => resolveAccountMenu(junk)).not.toThrow();
    expect(resolveAccountMenu(junk)).toEqual([]);
    expect(resolveAccountMenu({ label: "x", page: "schema" })).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  test("an unknown icon is dropped rather than drawn as a blank", () => {
    expect(resolveAccountMenu([{ label: "x", page: "schema", icon: "rocket" }])).toEqual([{ label: "x", page: "schema" }]);
  });
});

describe("hideControls", () => {
  test("unconfigured hides nothing: search and filters stay the default", () => {
    expect(resolveHiddenControls(undefined).size).toBe(0);
    expect(resolveHiddenControls(null).size).toBe(0);
    expect(readControlsConfig(undefined)).toBeUndefined();
    expect(readControlsConfig({ PRAMEN_CMS_EDITOR: {} })).toBeUndefined();
  });

  test("every documented control can be hidden", () => {
    const hidden = resolveHiddenControls(readControlsConfig({ PRAMEN_CMS_EDITOR: { hideControls: [...EDITOR_CONTROLS] } }));
    expect([...hidden].sort()).toEqual([...EDITOR_CONTROLS].sort());
    expect([...resolveHiddenControls([" mediaSearch "])]).toEqual(["mediaSearch"]);
  });

  test("a typo is warned about and ignored, and nothing malformed throws", () => {
    expect([...resolveHiddenControls(["mediaSeach", "relationSearch"])]).toEqual(["relationSearch"]);
    for (const v of [true, "mediaSearch", {}, 3, [null, 4, {}]]) {
      expect(() => resolveHiddenControls(v)).not.toThrow();
    }
    expect(resolveHiddenControls("mediaSearch").size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});

describe("home landing", () => {
  const cms = { ...DEFAULT_CAPABILITIES, pagesByType: true };
  const col = { slug: "lectures", label: "Lecture", pluralLabel: "Lectures", fields: [], list: [], titleField: "title", idField: "id" };

  test("collections-only lands on the first collection, or nowhere", () => {
    expect(homeLanding({ hidePages: true, collections: [col], contentTypes: null, cms })).toEqual({ kind: "collection", slug: "lectures" });
    expect(homeLanding({ hidePages: true, collections: [], contentTypes: TYPES, cms })).toEqual({ kind: "none" });
  });

  test("split by type lands on the first type with a usable slug", () => {
    expect(homeLanding({ hidePages: false, collections: [], contentTypes: TYPES, cms })).toEqual({ kind: "type", slug: "page" });
    expect(homeLanding({ hidePages: false, collections: [], contentTypes: [{ id: "x", name: "X", slug: "" }, ...TYPES], cms })).toEqual({ kind: "type", slug: "page" });
  });

  test("nothing is decided before the content types are answered", () => {
    expect(homeLanding({ hidePages: false, collections: [], contentTypes: null, cms })).toEqual({ kind: "pending" });
  });

  test("one type, or a server that cannot split, keeps the pooled list as home", () => {
    expect(homeLanding({ hidePages: false, collections: [], contentTypes: [TYPES[0]!], cms })).toEqual({ kind: "pages" });
    expect(homeLanding({ hidePages: false, collections: [], contentTypes: TYPES, cms: { ...cms, pagesByType: false } })).toEqual({ kind: "pages" });
  });
});

describe("what a media grid slot is handed", () => {
  const api = { resolve: (p: string) => `https://cms.test${p}` };

  test("an image carries its URL; anything else carries none, so a theme never renders a PDF as an <img>", () => {
    const image: Media = { id: "m1", file: { key: "k/a.png", contentType: "image/png", filename: "a.png", size: 2048 }, alt: "Logo" };
    const pdf: Media = { id: "m2", file: { key: "k/b", contentType: "application/pdf", filename: "brochure.pdf" } };
    let opened = "";
    const tile = mediaTile(api, image, true, () => { opened = "m1"; });
    expect(tile).toMatchObject({ id: "m1", filename: "a.png", size: 2048, sizeLabel: "2.0 KB", ext: "PNG", contentType: "image/png", src: "https://cms.test/media/k/a.png", alt: "Logo", selected: true });
    tile.onOpen();
    expect(opened).toBe("m1");
    expect(mediaTile(api, pdf, false, () => {})).toMatchObject({ filename: "brochure.pdf", ext: "PDF", src: null, alt: "", selected: false });
  });

  test("a file stored without a name is still labelled", () => {
    expect(mediaTile(api, { id: "m3", file: { key: "k" } }, false, () => {}).filename).toBe("m3");
  });
});

describe("the public page list", () => {
  test("is exactly the router's registry", async () => {
    // The compile-time half is `EditorPagesMatchRouter` in `routes/_layout.tsx`; this is the
    // runtime half, read off the generated table's text so the test does not import every route.
    const gen = await readFile(resolve(import.meta.dir, "../packages/cms-editor/src/buzola.gen.ts"), "utf8");
    const registry = gen.slice(gen.indexOf("export const pageRegistry"));
    const ids = [...registry.slice(0, registry.indexOf("};")).matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect([...EDITOR_PAGES].sort()).toEqual(ids.sort());
  });
});

describe("keys used above", () => {
  test("the built nav has the entries the scenarios rely on", () => {
    // Guards the fixtures: if the nav stopped building these keys, every test above would pass
    // vacuously by filtering nothing.
    const all = keys(builtNav()).flat();
    for (const k of ["type:page", "type:akce", "app:akce", "types", "users", "settings", "media"]) expect(all).toContain(k);
  });
});
