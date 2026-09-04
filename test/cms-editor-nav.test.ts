// @pramen/cms-editor — the primary nav, as data (GitHub #44 tier 1).
//
// The nav used to be a fixed sequence written out in JSX, which is why a project-specific
// section could not be part of the admin: `extraNav` renders dead LAST and opens a new tab,
// so anything not backed by a `collection()` was structurally the final item and
// structurally a different app. `buildNav` makes the order a number a host can set.
//
// Tested here rather than in the layout because that is the point of splitting it out: the
// ordering rule is a pure function of the session's facts, and a DOM adds nothing to it.

import { describe, expect, test } from "bun:test";
import { buildNav, NAV_SECTION_IDS, navSections, navSectionsAreLabelled, type NavInput } from "../packages/cms-editor/src/nav";
import { DEFAULT_CAPABILITIES, NAV_ORDER, type CollectionMeta, type ContentType } from "../packages/cms-editor/src/types";

const TYPES: ContentType[] = [
  { id: "t-page", name: "Pages", slug: "page" },
  { id: "t-article", name: "Articles", slug: "article" },
];

const col = (slug: string, navOrder?: number): CollectionMeta => ({
  slug,
  label: slug,
  pluralLabel: slug,
  fields: [],
  list: [],
  titleField: "title",
  idField: "id",
  ...(navOrder === undefined ? {} : { navOrder }),
});

/** The nav's keys, in order.
 *
 * The base session cannot author, so the ordering tests below are about POSITION and are
 * not also re-asserting which optional sections exist — those get their own block. */
const nav = (over: Partial<NavInput> = {}) =>
  buildNav({
    collections: [],
    adminPages: [],
    contentTypes: TYPES,
    cms: { ...DEFAULT_CAPABILITIES, canEdit: false },
    hidePages: false,
    splitByType: false,
    isAdmin: false,
    extraNav: [],
    ...over,
  }).map((e) => e.key);

describe("nav ordering", () => {
  test("the built-ins keep the order they always had", () => {
    // The whole point of giving them default positions: an existing deployment that sets no
    // `navOrder` anywhere must render exactly as before.
    expect(nav({ collections: [col("lectures")], isAdmin: true })).toEqual([
      "pages", "col:lectures", "media", "users", "settings",
    ]);
  });

  test("a collection can place itself BEFORE Pages", () => {
    expect(nav({ collections: [col("lectures", NAV_ORDER.pages - 50)] })).toEqual(["col:lectures", "pages", "media", "settings"]);
  });

  test("a host link can sit between two built-ins instead of after Settings", () => {
    // This is the case the issue is about. Before, `extraNav` had exactly one position.
    expect(nav({ extraNav: [{ label: "Curate", href: "/curate", order: NAV_ORDER.media - 1 }] })).toEqual([
      "pages", "extra:/curate|Curate", "media", "settings",
    ]);
  });

  test("a host link with no order is still last, as it always was", () => {
    expect(nav({ extraNav: [{ label: "Curate", href: "/curate" }] })).toEqual(["pages", "media", "settings", "extra:/curate|Curate"]);
  });

  test("ties keep declaration order, which is the only answer a host can predict", () => {
    // The sort is stable (ES2019), and this is what carries the two groupings that have no
    // numeric expression: content-type tabs among themselves, and collections sharing a
    // position.
    expect(nav({ collections: [col("b"), col("a"), col("c")] })).toEqual(["pages", "col:b", "col:a", "col:c", "media", "settings"]);
  });

  test("split by type, each content type is a tab where Pages was", () => {
    expect(nav({ splitByType: true })).toEqual(["type:page", "type:article", "media", "settings"]);
  });

});

describe("what the nav shows at all", () => {
  test("site-furniture sections appear only where the server declares the handlers", () => {
    expect(nav()).not.toContain("menus");
    expect(nav({ cms: { ...DEFAULT_CAPABILITIES, siteFurniture: true, canEdit: true } })).toEqual([
      "pages", "media", "menus", "taxonomies", "widgets", "redirects", "types", "settings",
    ]);
  });

  test("taxonomies are hidden where there are no pages to classify", () => {
    // `cms_page_terms` links a term to a PAGE and to nothing else, so a collections-only
    // deployment would get a vocabulary editor with no subject.
    const keys = nav({ cms: { ...DEFAULT_CAPABILITIES, siteFurniture: true, canEdit: true }, hidePages: true });
    expect(keys).not.toContain("taxonomies");
    expect(keys).toContain("menus");
  });

  test("Types is hidden from a session that cannot author", () => {
    // Every handler behind it is editor-gated; a reviewer would get a builder where each
    // save 403s.
    expect(nav({ cms: { ...DEFAULT_CAPABILITIES, canEdit: false } })).not.toContain("types");
    expect(nav({ cms: { ...DEFAULT_CAPABILITIES, canEdit: true } })).toContain("types");
  });

  test("a Block Kit page sits INSIDE the chrome, at a position it chooses", () => {
    // The point of #33/#44 tier 3: before this, a project screen could only be an
    // `extraNav` link — last in the nav, and opening a new tab.
    expect(nav({ adminPages: [{ slug: "dispatch", label: "Dispatch" }] })).toEqual(["pages", "media", "app:dispatch", "settings"]);
    expect(nav({ adminPages: [{ slug: "dispatch", label: "Dispatch", navOrder: NAV_ORDER.pages + 10 }] })).toEqual(["pages", "app:dispatch", "media", "settings"]);
  });

  test("hiding the page builder hides Pages and Types with it", () => {
    const keys = nav({ hidePages: true, collections: [col("lectures")] });
    expect(keys).toEqual(["col:lectures", "media", "settings"]);
  });
});

// --- icons ------------------------------------------------------------------------------

/** The full entry objects, not just the keys — the icon tests are about the payload. */
const entries = (over: Partial<NavInput> = {}) =>
  buildNav({
    collections: [],
    adminPages: [],
    contentTypes: TYPES,
    cms: { ...DEFAULT_CAPABILITIES, canEdit: false },
    hidePages: false,
    splitByType: false,
    isAdmin: false,
    extraNav: [],
    ...over,
  });

describe("nav icons", () => {
  test("every entry carries one, so the rail has no ragged icon column", () => {
    // A missing icon is not a missing decoration: the label would start where every other
    // label's ICON starts, and the column stops reading as a column.
    const all = entries({
      collections: [col("lectures")],
      adminPages: [{ slug: "dispatch", label: "Dispatch" }],
      cms: { ...DEFAULT_CAPABILITIES, siteFurniture: true, canEdit: true },
      isAdmin: true,
      extraNav: [{ label: "Curate", href: "/curate" }],
    });
    expect(all.length).toBeGreaterThan(8);
    for (const e of all) expect(e.icon).toBeDefined();
  });

  test("a server-declared icon goes in the ICON slot, not into the label", () => {
    // It used to be prepended to the label, where it read as part of the words and wrapped
    // with them. Two assertions, because getting the icon right while leaving the emoji in
    // the label would render it twice.
    const [, lectures] = entries({ collections: [{ ...col("lectures"), icon: "🎓", pluralLabel: "Lectures" }] });
    expect(lectures?.icon).toEqual({ kind: "emoji", char: "🎓" });
    expect(lectures?.kind === "route" ? lectures.label : "").toBe("Lectures");
  });

  test("a Block Kit page's icon works the same way", () => {
    const page = entries({ adminPages: [{ slug: "dispatch", label: "Dispatch", icon: "🚚" }] }).find((e) => e.key === "app:dispatch");
    expect(page?.icon).toEqual({ kind: "emoji", char: "🚚" });
    expect(page?.kind === "route" ? page.label : "").toBe("Dispatch");
  });

  test("with no declared icon the section's own glyph stands in", () => {
    expect(entries({ collections: [col("lectures")] })[1]?.icon).toEqual({ kind: "glyph", name: "collection" });
    expect(entries({ adminPages: [{ slug: "dispatch", label: "Dispatch" }] }).find((e) => e.key === "app:dispatch")?.icon)
      .toEqual({ kind: "glyph", name: "app" });
  });

  test("a blank declared icon is not an icon", () => {
    // `icon: ""` (or a whitespace string) is what a template that resolved to nothing
    // produces; an empty box in the icon column is worse than the glyph it replaced.
    expect(entries({ collections: [{ ...col("lectures"), icon: "  " }] })[1]?.icon).toEqual({ kind: "glyph", name: "collection" });
  });
});

// --- sections ---------------------------------------------------------------------------

const sections = (over: Partial<NavInput> = {}) =>
  navSections(entries(over)).map((s) => [s.id, ...s.entries.map((e) => e.key)]);

describe("nav sections", () => {
  test("the built-ins group the way a reader would look for them", () => {
    expect(
      sections({
        collections: [col("lectures")],
        adminPages: [{ slug: "dispatch", label: "Dispatch" }],
        cms: { ...DEFAULT_CAPABILITIES, siteFurniture: true, canEdit: true },
        isAdmin: true,
      }),
    ).toEqual([
      ["content", "pages", "col:lectures", "media"],
      ["site", "menus", "taxonomies", "widgets", "redirects"],
      ["apps", "app:dispatch"],
      ["system", "types", "users", "settings"],
    ]);
  });

  test("an empty section is dropped, not rendered as a heading over nothing", () => {
    // The common deployment: no site furniture, no Block Kit pages.
    expect(sections()).toEqual([["content", "pages", "media"], ["system", "settings"]]);
  });

  test("a section is where its ORDER says, not where its kind says", () => {
    // The one contract this module has is that position is a number a host sets. A
    // collection placed before Pages is Content; one placed among the furniture is Site.
    expect(sections({ collections: [col("lectures", NAV_ORDER.menus + 10)] })).toEqual([
      ["content", "pages", "media"],
      ["site", "col:lectures"],
      ["system", "settings"],
    ]);
    expect(sections({ extraNav: [{ label: "Curate", href: "/curate", order: NAV_ORDER.adminPages + 10 }] })).toEqual([
      ["content", "pages", "media"],
      ["apps", "extra:/curate|Curate"],
      ["system", "settings"],
    ]);
  });

  test("a host link with no order lands in System, where it has always rendered last", () => {
    expect(sections({ extraNav: [{ label: "Curate", href: "/curate" }] })).toEqual([
      ["content", "pages", "media"],
      ["system", "settings", "extra:/curate|Curate"],
    ]);
  });

  test("headings appear only once there is more than one group to tell apart", () => {
    // A single heading over the whole rail captions a list with no sibling to distinguish
    // it from. A collections-only deployment genuinely is one group.
    const collectionsOnly = navSections(entries({ hidePages: true, collections: [col("lectures")] }));
    expect(collectionsOnly.map((s) => s.id)).toEqual(["content", "system"]);
    expect(navSectionsAreLabelled(collectionsOnly)).toBe(true);
    expect(navSectionsAreLabelled([{ id: "content", label: "Content", entries: [] }])).toBe(false);
  });
});

describe("section ids", () => {
  test("every band is enumerated, in rail order", () => {
    // The layout persists FOLDS by id and parses what comes back out of localStorage against
    // this list. A band missing here is a group that can never stay folded; an id here with
    // no band is one the reader can fold and never unfold.
    expect(NAV_SECTION_IDS).toEqual(["content", "site", "apps", "system"]);
  });

  test("the ids cover every section the nav can actually produce", () => {
    // Derived from the same `BANDS` the grouping uses, so this is an identity — asserted
    // because the two would otherwise be free to drift into a group with no id.
    const produced = navSections(
      buildNav({
        collections: [col("lectures")],
        adminPages: [{ slug: "dispatch", label: "Dispatch" }],
        contentTypes: TYPES,
        cms: { ...DEFAULT_CAPABILITIES, siteFurniture: true, canEdit: true },
        hidePages: false,
        splitByType: false,
        isAdmin: true,
        extraNav: [],
      }),
    ).map((s) => s.id);
    expect(produced).toEqual([...NAV_SECTION_IDS]);
  });
});
