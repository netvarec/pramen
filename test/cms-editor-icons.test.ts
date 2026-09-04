// @pramen/cms-editor — every glyph the nav names actually draws.
//
// `NAV_GLYPHS` is `satisfies Record<NavGlyph, Icon>`, so a name added to the union without a
// drawing is already a compile error. What this adds is the RUNTIME, which the types cannot
// reach: the set is Phosphor's, imported by name, and a rename or a removal upstream is an
// `undefined` that typechecks against a stale `.d.ts` and renders a blank square in the rail.
// Cheap enough to just render every one.
//
// It RENDERS rather than calling the component as a function: Phosphor's icons are
// `forwardRef` exotic components, which cannot be invoked directly — a test that called them
// would be asserting on the wrong thing even while it passed.
//
// In its own file because `nav.ts` is deliberately DOM-free and tested as such; this one
// imports JSX.

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DarkThemeIcon,
  GroupFoldedIcon,
  GroupOpenIcon,
  LightThemeIcon,
  MenuToggleIcon,
  NAV_GLYPHS,
  SignOutIcon,
  type Icon,
} from "../packages/cms-editor/src/icons";
import { buildNav, type NavGlyph, type NavInput } from "../packages/cms-editor/src/nav";
import { DEFAULT_CAPABILITIES, type CollectionMeta } from "../packages/cms-editor/src/types";

const EVERY_SECTION: NavInput = {
  collections: [
    { slug: "lectures", label: "Lecture", pluralLabel: "Lectures", fields: [], list: [], titleField: "title", idField: "id" } satisfies CollectionMeta,
  ],
  adminPages: [{ slug: "dispatch", label: "Dispatch" }],
  contentTypes: [{ id: "t", name: "Pages", slug: "page" }],
  cms: { ...DEFAULT_CAPABILITIES, siteFurniture: true, canEdit: true },
  hidePages: false,
  splitByType: false,
  isAdmin: true,
  extraNav: [{ label: "Curate", href: "/curate" }],
};

/** The markup one glyph produces at the size the rail draws it. */
const draw = (Glyph: Icon) => renderToStaticMarkup(createElement(Glyph, { className: "h-[15px] w-[15px]" }));

describe("nav glyphs", () => {
  test("every glyph the nav can ask for renders an <svg>", () => {
    for (const [name, Glyph] of Object.entries(NAV_GLYPHS)) {
      const html = draw(Glyph);
      expect(html, `${name} did not render an svg`).toStartWith("<svg");
      // Phosphor's grid. Asserted because it is what makes the set ONE family: a glyph on
      // another viewBox would be optically a different size at the same `h-[15px]`.
      expect(html, `${name} is not on Phosphor's 256 grid`).toContain('viewBox="0 0 256 256"');
      // The rail colours its rows through `text-*`; an icon with a baked fill would ignore
      // the muted/active distinction entirely.
      expect(html, `${name} does not take its colour from the row`).toContain("currentColor");
    }
  });

  test("the chrome's own controls come from the same family", () => {
    // These are the rail's CONTROLS rather than its destinations, and they used to come from
    // podoba while the destinations came from here — two line sets in one 240px column.
    for (const [name, Glyph] of Object.entries({ MenuToggleIcon, GroupOpenIcon, GroupFoldedIcon, LightThemeIcon, DarkThemeIcon, SignOutIcon })) {
      expect(draw(Glyph), `${name} is off-family`).toContain('viewBox="0 0 256 256"');
    }
  });

  test("a fully-populated nav names only glyphs that exist", () => {
    // The union makes this exhaustive at compile time; this is the same check against the
    // OBJECT, which is what the layout actually indexes.
    const named = buildNav(EVERY_SECTION)
      .map((e) => e.icon)
      .filter((i) => i.kind === "glyph")
      .map((i) => i.name);
    expect(named.length).toBeGreaterThan(8);
    for (const name of named) expect(NAV_GLYPHS[name as NavGlyph]).toBeDefined();
  });
});
