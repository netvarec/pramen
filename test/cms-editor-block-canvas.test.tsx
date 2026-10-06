// @pramen/cms-editor: the page canvas's between-blocks inserter.
//
// Inserting between two blocks was already possible, and nobody found it: the affordance
// was a 12px strip at opacity 0 that showed only under a pointer resting exactly in the gap.
// Editors concluded a block could only be appended at the end. What is pinned here is that
// the closed inserter is visible and SAYS what it does, in the editor's language.

import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Inserter } from "../packages/cms-editor/src/components";
import { configureI18n } from "../packages/cms-editor/src/i18n";

const btBySlug = new Map([["rich_text", { slug: "rich_text", name: "Text" }]]) as never;

describe("cms-editor between-blocks inserter", () => {
  afterEach(() => configureI18n({}));

  test("is labelled with what it does, in the editor's locale", () => {
    configureI18n({ locale: "cs" });
    const html = renderToStaticMarkup(<Inserter compact allowed={["rich_text"]} btBySlug={btBySlug} onAdd={() => {}} />);
    expect(html).toContain("Vložit blok sem");
  });

  test("is not hidden at rest", () => {
    const html = renderToStaticMarkup(<Inserter compact allowed={["rich_text"]} btBySlug={btBySlug} onAdd={() => {}} />);
    // opacity-0 is what made it undiscoverable; it may be faint, never invisible.
    expect(html).not.toContain("opacity-0");
    expect(html).toContain("Insert block here");
  });
});
