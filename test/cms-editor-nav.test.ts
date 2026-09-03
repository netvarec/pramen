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
import { buildNav, type NavInput } from "../packages/cms-editor/src/nav";
import { DEFAULT_CAPABILITIES, NAV_ORDER, type CollectionMeta, type ContentType } from "../packages/cms-editor/src/types";
import { NAV_ORDER as SERVER_NAV_ORDER } from "../packages/cms/src/index";

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

  test("the editor's NAV_ORDER mirror matches the server's", () => {
    // The editor cannot import from @pramen/cms — it is a standalone browser app that
    // speaks HTTP only — so the table is duplicated, and a drift would put a host's declared
    // `navOrder: NAV_ORDER.media` somewhere other than beside Media.
    expect(NAV_ORDER).toEqual(SERVER_NAV_ORDER);
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
