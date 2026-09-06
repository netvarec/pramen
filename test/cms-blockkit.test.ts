// @pramen/cms — Block Kit: custom admin pages described as JSON (GitHub #33, #44 tier 3).
//
// The contract these tests hold is narrow and worth stating: Block Kit removes the browser
// CODE from a project's admin screen, not the boundary around it. A page's `render` is an
// ordinary handler body with the caller's own ctx, the registry is keyed server-side so a
// client cannot name what runs, and the response is checked on the way out for the one
// thing in it that is not text.

import { describe, expect, test } from "bun:test";
import {
  adminPage,
  createAdminPageHandlers,
  MAX_ADMIN_BLOCK_DEPTH,
  NAV_ORDER,
  normalizeAdminResponse,
  validateAdminPages,
  type AdminBlock,
  type AdminButton,
  type AdminCell,
  type AdminPageInteraction,
  type AdminPageMeta,
  type AdminPageResponse,
} from "../packages/cms/src/index";
import type { HandlerContext, JsonValue } from "@pramen/server";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlockList, seedValues } from "../packages/cms-editor/src/blockkit";

const ctxAs = (...roles: string[]) => ({ identity: { roles } }) as unknown as HandlerContext;

const page = (over: Partial<Parameters<typeof adminPage>[1]> = {}) =>
  adminPage("dispatch", {
    label: "Dispatch",
    render: () => ({ blocks: [{ type: "header", text: "Today" }] }),
    ...over,
  });

type Handlers = {
  listAdminPages: { run: (c: HandlerContext) => AdminPageMeta[] };
  adminPageInteract: { run: (c: HandlerContext, i: AdminPageInteraction) => Promise<AdminPageResponse>; input: (raw: unknown) => AdminPageInteraction };
};
const H = (...pages: ReturnType<typeof adminPage>[]) => createAdminPageHandlers(pages) as unknown as Handlers;

describe("the registry", () => {
  test("a slug must be routable — it is served at /apps/:slug", () => {
    expect(() => validateAdminPages([adminPage("My Page", { label: "x", render: () => ({ blocks: [] }) })])).toThrow(/URL segment/);
    expect(() => validateAdminPages([adminPage("my_page", { label: "x", render: () => ({ blocks: [] }) })])).toThrow(/URL segment/);
  });

  test("duplicate slugs are refused — the slug IS the registry's key", () => {
    expect(() => validateAdminPages([page(), page()])).toThrow(/duplicate admin page slug/);
  });

  test("an empty label would render an unnamed nav entry", () => {
    expect(() => validateAdminPages([adminPage("x", { label: "  ", render: () => ({ blocks: [] }) })])).toThrow(/empty label/);
  });

  test("the registry is validated at handler-construction time, not on first open", () => {
    expect(() => createAdminPageHandlers([page(), page()])).toThrow(/duplicate/);
  });
});

describe("who sees and who may open", () => {
  test("the listing is FILTERED, not annotated — a nav entry that 403s is worse than none", () => {
    const h = H(page(), adminPage("finance", { label: "Finance", roles: ["admin"], render: () => ({ blocks: [] }) }));
    expect(h.listAdminPages.run(ctxAs("editor")).map((p) => p.slug)).toEqual(["dispatch"]);
    expect(h.listAdminPages.run(ctxAs("admin")).map((p) => p.slug)).toEqual(["dispatch", "finance"]);
  });

  test("a page carries its nav position, defaulting beside the other project surfaces", () => {
    const h = H(page(), adminPage("finance", { label: "Finance", navOrder: 150, render: () => ({ blocks: [] }) }));
    const [dispatch, finance] = h.listAdminPages.run(ctxAs("editor"));
    expect(dispatch!.navOrder).toBe(NAV_ORDER.adminPages);
    expect(finance!.navOrder).toBe(150);
  });

  test("the listing never carries the role list or the render function", () => {
    const h = H(adminPage("finance", { label: "Finance", roles: ["admin"], render: () => ({ blocks: [] }) }));
    expect(Object.keys(h.listAdminPages.run(ctxAs("admin"))[0]!).sort()).toEqual(["icon", "label", "navOrder", "slug"]);
  });

  test("an unknown slug and a forbidden one answer the same way", async () => {
    // Deliberately identical: a distinct "you may not open that" tells an unauthorized
    // caller which pages exist.
    const h = H(adminPage("finance", { label: "Finance", roles: ["admin"], render: () => ({ blocks: [] }) }));
    await expect(h.adminPageInteract.run(ctxAs("editor"), { page: "finance", type: "page_load" })).rejects.toThrow(/unknown admin page/);
    await expect(h.adminPageInteract.run(ctxAs("editor"), { page: "nope", type: "page_load" })).rejects.toThrow(/unknown admin page/);
  });

  test("a forbidden page's render never runs", async () => {
    let ran = false;
    const h = H(adminPage("finance", { label: "Finance", roles: ["admin"], render: () => { ran = true; return { blocks: [] }; } }));
    await expect(h.adminPageInteract.run(ctxAs("editor"), { page: "finance", type: "page_load" })).rejects.toThrow();
    expect(ran).toBe(false);
  });
});

describe("the interaction envelope", () => {
  test("an unknown interaction type is refused", () => {
    const h = H(page());
    expect(() => h.adminPageInteract.input({ page: "dispatch", type: "eval" })).toThrow(/unknown interaction type/);
    expect(h.adminPageInteract.input({ page: "dispatch" }).type).toBe("page_load");
  });

  test("`values` must be an object, not an array a page would spread", () => {
    const h = H(page());
    expect(() => h.adminPageInteract.input({ page: "dispatch", type: "form_submit", values: [1, 2] })).toThrow(/must be an object/);
  });

  test("the interaction reaches render intact", async () => {
    let seen: AdminPageInteraction | null = null;
    const h = H(adminPage("dispatch", { label: "D", render: (_c, i) => { seen = i; return { blocks: [] }; } }));
    await h.adminPageInteract.run(ctxAs("editor"), h.adminPageInteract.input({ page: "dispatch", type: "form_submit", action_id: "save", block_id: "settings", values: { url: "x" } }));
    expect(seen).toEqual({ page: "dispatch", type: "form_submit", action_id: "save", block_id: "settings", values: { url: "x" } });
  });

  test("render gets the CALLER's ctx — Block Kit removes the browser code, not the ACL", async () => {
    let seen: HandlerContext | null = null;
    const h = H(adminPage("dispatch", { label: "D", render: (c) => { seen = c; return { blocks: [] }; } }));
    const ctx = ctxAs("editor");
    await h.adminPageInteract.run(ctx, { page: "dispatch", type: "page_load" });
    expect(seen).toBe(ctx);
  });
});

describe("the response is checked on the way out", () => {
  test("an image url goes through the same allow-list a rich-text link does", () => {
    // Server-authored is not the same as trustworthy: a page builds blocks from data, so a
    // url can come out of a row or an external API.
    expect(() => normalizeAdminResponse({ blocks: [{ type: "image", url: "javascript:alert(1)" }] })).toThrow(/not an allowed href/);
    expect(normalizeAdminResponse({ blocks: [{ type: "image", url: " /media/x.png " }] }).blocks[0]).toEqual({ type: "image", url: "/media/x.png" });
  });

  test("a form needs a block_id, because that is what keys its local values", () => {
    // Two forms sharing one would share their state, so the second would submit the first's.
    expect(() => normalizeAdminResponse({ blocks: [{ type: "form", block_id: "", fields: [], submit: { label: "Go", action_id: "go" } }] })).toThrow(/needs a block_id/);
  });

  test("nesting is capped, because rendering is recursive", () => {
    let deep: AdminBlock = { type: "section", text: "leaf" };
    for (let i = 0; i < MAX_ADMIN_BLOCK_DEPTH; i++) deep = { type: "accordion", title: `a${i}`, blocks: [deep] };
    expect(() => normalizeAdminResponse({ blocks: [deep] })).toThrow(/nest deeper than/);
  });

  test("a page that returns the wrong shape is named, not silently blank", () => {
    expect(() => normalizeAdminResponse(undefined as unknown as AdminPageResponse)).toThrow(/must return \{ blocks/);
  });

  test("a nested image is checked too", () => {
    expect(() => normalizeAdminResponse({
      blocks: [{ type: "columns", columns: [[{ type: "image", url: "data:text/html,<script>" }]] }],
    })).toThrow(/not an allowed href/);
  });

  test("a toast rides back alongside the blocks", async () => {
    const h = H(adminPage("dispatch", { label: "D", render: () => ({ blocks: [], toast: { text: "Saved", tone: "success" } }) }));
    const res = await h.adminPageInteract.run(ctxAs("editor"), { page: "dispatch", type: "block_action" });
    expect(res.toast).toEqual({ text: "Saved", tone: "success" });
  });
});

// --- a row that can act, and a field that can be wrong -------------------------------------
//
// The two additions below are one contract spanning both halves of Block Kit, so they are
// asserted on both halves in this one file rather than split across a server file and an
// editor file that could then agree with nothing. The server half says what may be
// described; the editor half says what is drawn and what comes back when it is pressed. A
// test of either alone would pass while the feature did not work.

describe("a table row can carry a control", () => {
  const rowButton = (id: string, label: string): AdminCell => ({ type: "button", action_id: "toggle", label, value: id });
  /** A cell a page had no business producing. The escape lives in ONE place, because what
   * these checks are for is precisely the value the types said could not be there. */
  const badCell = (v: object): AdminCell => v as unknown as AdminCell;

  test("a cell may hold an element — that is how one row acts without becoming its own block", () => {
    // The alternative was an `actions` block per row: 830 venues, 830 blocks, and a table
    // with the table taken out of it.
    const res = normalizeAdminResponse({
      blocks: [{
        type: "table",
        block_id: "venues",
        columns: [{ key: "name", label: "Name" }, { key: "act", label: "" }],
        rows: [{ name: "Sparta", act: rowButton("v-1", "Hide") }, { name: "Slavia", act: rowButton("v-2", "Show") }],
      }],
    });
    const table = res.blocks[0] as Extract<AdminBlock, { type: "table" }>;
    expect(table.rows[1]!.act).toEqual({ type: "button", action_id: "toggle", label: "Show", value: "v-2" });
  });

  test("one action_id serves every row — the button's `value` is what says which row", () => {
    // The existing idiom, kept working. Buttons are deliberately NOT claimed the way inputs
    // are: repeating a button's action_id down a column is how a row column is written.
    expect(() => normalizeAdminResponse({
      blocks: [{
        type: "table",
        columns: [{ key: "act", label: "" }],
        rows: [{ act: rowButton("v-1", "Hide") }, { act: rowButton("v-2", "Hide") }, { act: rowButton("v-3", "Hide") }],
      }],
    })).not.toThrow();
  });

  test("a whole row object splatted into a cell is named, not rendered as [object Object]", () => {
    // `rows: found` is the obvious mistake now that a cell may be an object, and the failure
    // it used to produce (a column of `[object Object]`) is one nobody reads as a type error.
    expect(() => normalizeAdminResponse({
      blocks: [{ type: "table", columns: [{ key: "a", label: "A" }], rows: [{ a: badCell({ id: 7, title: "x" }) }] }],
    })).toThrow(/is not an admin element/);
  });

  test("an element in a cell must be able to fire and to be read", () => {
    const cell = (over: Partial<AdminButton>): AdminCell => ({ type: "button", action_id: "toggle", label: "Hide", ...over });
    const table = (c: AdminCell): AdminPageResponse => ({ blocks: [{ type: "table", columns: [{ key: "a", label: "A" }], rows: [{ a: c }] }] });
    expect(() => normalizeAdminResponse(table(cell({ action_id: "" })))).toThrow(/no action_id/);
    expect(() => normalizeAdminResponse(table(cell({ label: "" })))).toThrow(/no label/);
  });

  test("an empty cell is still an empty cell — null is a value, not a broken element", () => {
    // `isElementCell` decides by shape, and `typeof null === "object"`: read the check
    // wrongly and every blank cell becomes an element with no type.
    expect(() => normalizeAdminResponse({
      blocks: [{ type: "table", columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }], rows: [{ a: null, b: "x" }] }],
    })).not.toThrow();
  });

  test("only the cells a COLUMN names are checked — a row may carry data it does not show", () => {
    // The editor renders by column, so an element under an unnamed key is invisible. Both
    // halves walk the same set, so neither can act on something the other cannot see.
    expect(() => normalizeAdminResponse({
      blocks: [{ type: "table", columns: [{ key: "name", label: "Name" }], rows: [{ name: "Sparta", raw: badCell({ id: 1 }) }] }],
    })).not.toThrow();
  });
});

describe("a per-row input has to mint a per-row action_id", () => {
  // The editor keys the page's WHOLE value bag by action_id — that is what lets a filter in
  // one block reach a button in another. A row input therefore cannot be `action_id: "hours"`
  // repeated 830 times, and the response is where that is caught, because on screen it looks
  // like one field that mysteriously shows the same value everywhere.
  const hours = (id: string, v: string): AdminCell => ({ type: "text_input", action_id: `hours:${id}`, initial_value: v });

  test("per-row ids are what a table of inputs looks like", () => {
    expect(() => normalizeAdminResponse({
      blocks: [{ type: "table", columns: [{ key: "h", label: "Hours" }], rows: [{ h: hours("v-1", "07:00") }, { h: hours("v-2", "08:00") }] }],
    })).not.toThrow();
  });

  test("the same input literal in every row is refused, and the message says how to fix it", () => {
    let err: Error | null = null;
    try {
      normalizeAdminResponse({
        blocks: [{
          type: "table",
          columns: [{ key: "h", label: "Hours" }],
          rows: [{ h: { type: "text_input", action_id: "hours" } }, { h: { type: "text_input", action_id: "hours" } }],
        }],
      });
    } catch (e) { err = e as Error; }
    expect(err?.message).toMatch(/action_id 'hours' is used by more than one input/);
    expect(err?.message).toMatch(/per-row id/);
    expect(err?.message).toMatch(/table column 'h'/);
  });

  test("the bag is per PAGE, so a form field and a table cell collide too", () => {
    expect(() => normalizeAdminResponse({
      blocks: [
        { type: "form", block_id: "f", fields: [{ type: "text_input", action_id: "q" }], submit: { label: "Go", action_id: "go" } },
        { type: "table", columns: [{ key: "c", label: "C" }], rows: [{ c: { type: "text_input", action_id: "q" } }] },
      ],
    })).toThrow(/more than one input/);
  });

  test("a collision inside a column or an accordion is caught by the same walk", () => {
    expect(() => normalizeAdminResponse({
      blocks: [
        { type: "actions", elements: [{ type: "text_input", action_id: "q" }] },
        { type: "accordion", title: "More", blocks: [{ type: "form", block_id: "f", fields: [{ type: "text_input", action_id: "q" }], submit: { label: "Go", action_id: "go" } }] },
      ],
    })).toThrow(/more than one input/);
  });

  test("two different ids are simply two fields", () => {
    expect(() => normalizeAdminResponse({
      blocks: [{ type: "form", block_id: "f", fields: [{ type: "text_input", action_id: "a" }, { type: "text_input", action_id: "b" }], submit: { label: "Go", action_id: "go" } }],
    })).not.toThrow();
  });
});

describe("a field can be wrong on its own", () => {
  test("an error rides on the FIELD and is not a toast", async () => {
    // A page validating "25:00" has to be able to say so under the input it is about. The
    // toast names no field and is gone in three seconds, which is why this is not one.
    const h = H(adminPage("dispatch", {
      label: "D",
      render: () => ({
        blocks: [{ type: "form", block_id: "hours", fields: [{ type: "text_input", action_id: "from", initial_value: "25:00", error: "25:00 is not a time" }], submit: { label: "Save", action_id: "save" } }],
      }),
    }));
    const res = await h.adminPageInteract.run(ctxAs("editor"), { page: "dispatch", type: "form_submit", action_id: "save" });
    const form = res.blocks[0] as Extract<AdminBlock, { type: "form" }>;
    expect(form.fields[0]!.error).toBe("25:00 is not a time");
    expect(res.toast).toBeUndefined();
  });
});

// --- the editor half ----------------------------------------------------------------------
//
// Rendered rather than described: the additions above are only real if the editor draws them
// and if pressing what it drew comes back with enough to act on. There is no DOM here — the
// component tree is expanded by hand down to the leaf that carries the handler, which is
// where the wiring actually lives.

/** Our own components, expanded by NAME. Podoba's `Button` is deliberately NOT in the set:
 * it stays a leaf, and the props on that leaf (`onPress`, `children`) are exactly the wiring
 * under test — calling it would need a renderer and would assert on react-aria instead. A
 * component renamed out of this set makes the tests below fail to find their control, which
 * is the failure you want. */
const OURS = new Set(["BlockList", "BlockView", "TableBlock", "CellView", "ElementView", "ActionsBlock", "FormBlock", "InputView"]);

/** The props this file reads off a leaf. Named rather than a bag of `unknown`s: these are
 * the handlers the additions are made of, so the test says which ones it depends on. */
interface LeafProps {
  children?: ReactNode;
  "aria-label"?: string;
  value?: string | number;
  isDisabled?: boolean;
  size?: string;
  onPress?: () => void;
  onChange?: (e: { target: { value: string } }) => void;
  onSubmit?: (e: { preventDefault: () => void }) => void;
}

const propsOf = (node: ReactElement): LeafProps => node.props as LeafProps;

function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node as ReactNode[]) walk(n, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  const expand = node.type;
  if (typeof expand === "function" && OURS.has(expand.name)) return walk((expand as (p: unknown) => ReactNode)(node.props), out);
  return walk(propsOf(node).children, out);
}

/** What a control hands back when it fires — the editor's own `Fired`, which is internal, so
 * the shape it must produce is written out here instead of imported. */
interface FiredLike {
  type: "block_action" | "form_submit";
  action_id: string;
  block_id?: string;
  value?: JsonValue;
  values?: Record<string, JsonValue>;
}

interface Bag {
  values?: Record<string, JsonValue>;
  setValue?: (actionId: string, v: JsonValue) => void;
  disabled?: boolean;
  onFire?: (f: FiredLike) => void;
}

const withBag = (blocks: AdminBlock[], over: Bag) =>
  createElement(BlockList, { blocks, values: {}, setValue: () => {}, disabled: false, onFire: () => {}, ...over });

const tree = (blocks: AdminBlock[], over: Bag = {}): ReactElement[] => walk(withBag(blocks, over));

const draw = (blocks: AdminBlock[], over: Bag = {}): string => renderToStaticMarkup(withBag(blocks, over));

/** The one control drawn under this label. `pressable` additionally insists it carries a
 * press handler, which a row's button must and a form's submit (fired by the form) must not. */
const labelled = (nodes: ReactElement[], label: string): LeafProps => {
  const hit = nodes.map(propsOf).filter((p) => p.children === label);
  expect(hit).toHaveLength(1);
  return hit[0]!;
};

interface Press { onPress: () => void }

const pressable = (nodes: ReactElement[], label: string): Press => {
  const props = labelled(nodes, label);
  expect(props.onPress).toBeFunction();
  return { onPress: props.onPress! };
};

const HOST_CONTROLS = new Set<unknown>(["input", "select", "textarea"]);

/** The `<input>`/`<select>` leaf the editor drew for one input. */
const control = (nodes: ReactElement[], ariaLabel: string): LeafProps => {
  const hit = nodes.filter((n) => HOST_CONTROLS.has(n.type) && propsOf(n)["aria-label"] === ariaLabel).map(propsOf);
  expect(hit).toHaveLength(1);
  return hit[0]!;
};

const VENUES: AdminBlock = {
  type: "table",
  block_id: "venues",
  columns: [{ key: "name", label: "Name" }, { key: "shown", label: "Shown" }, { key: "act", label: "" }],
  rows: [
    { name: "Sparta", shown: true, act: { type: "button", action_id: "toggle", label: "Hide", value: "v-1" } },
    { name: "Slavia", shown: false, act: { type: "button", action_id: "toggle", label: "Show", value: "v-830" } },
  ],
};

describe("a row's control, drawn and pressed", () => {
  test("the button a row carries fires an interaction that names THAT row", () => {
    // The whole point of the addition: one `action_id` down the column, and the `value`
    // saying which of 830 rows it was. Without this the handler is told a button was pressed
    // and nothing else.
    const fired: FiredLike[] = [];
    const nodes = tree([VENUES], { onFire: (f) => fired.push(f) });
    pressable(nodes, "Show").onPress();
    expect(fired).toEqual([{ type: "block_action", action_id: "toggle", block_id: "venues", value: "v-830" }]);
  });

  test("each row fires its own value, not the first row's", () => {
    const fired: FiredLike[] = [];
    const nodes = tree([VENUES], { onFire: (f) => fired.push(f) });
    pressable(nodes, "Hide").onPress();
    expect(fired[0]!.value).toBe("v-1");
  });

  test("the control is drawn INSIDE its cell, not as a stray block after the table", () => {
    const html = draw([VENUES]);
    expect(html).toMatch(/<td[^>]*>(?:(?!<\/td>).)*<button[^>]*>Show<\/button>/);
    // …and the plain cells still read as values, each next to the row it belongs to: Sparta
    // is shown, Slavia is not, and a table that renders both words somewhere is not the
    // same claim.
    expect(html).toMatch(/>Sparta<\/td><td[^>]*>yes</);
    expect(html).toMatch(/>Slavia<\/td><td[^>]*>no</);
  });

  test("a table with no block_id still fires — the id is how you tell two tables apart", () => {
    const fired: FiredLike[] = [];
    const nodes = tree([{ type: "table", columns: [{ key: "a", label: "A" }], rows: [{ a: { type: "button", action_id: "go", label: "Go" } }] }], { onFire: (f) => fired.push(f) });
    pressable(nodes, "Go").onPress();
    expect(fired).toEqual([{ type: "block_action", action_id: "go", block_id: undefined, value: null }]);
  });

  test("a row's input writes to the page bag under its OWN action_id", () => {
    const wrote: [string, JsonValue][] = [];
    const rows = [{ h: { type: "text_input", action_id: "hours:v-1", label: "Sparta hours", initial_value: "07:00" } }, { h: { type: "text_input", action_id: "hours:v-2", label: "Slavia hours", initial_value: "08:00" } }];
    const block: AdminBlock = { type: "table", block_id: "venues", columns: [{ key: "h", label: "Hours" }], rows };
    const nodes = tree([block], { values: { "hours:v-1": "07:00", "hours:v-2": "08:00" }, setValue: (id, v) => wrote.push([id, v]) });
    const cell = control(nodes, "Slavia hours");
    expect(cell.value).toBe("08:00");
    cell.onChange!({ target: { value: "09:30" } });
    expect(wrote).toEqual([["hours:v-2", "09:30"]]);
  });

  test("a cell's input is seeded like any other — the walk reaches into rows", () => {
    // An input the seed walk misses draws empty however good its `initial_value` was, and
    // then submits that emptiness over the value it was showing a moment ago.
    expect(seedValues([{ type: "table", columns: [{ key: "h", label: "H" }, { key: "on", label: "On" }], rows: [{ h: { type: "text_input", action_id: "hours:v-1", initial_value: "07:00" }, on: { type: "toggle", action_id: "on:v-1", initial_value: true } }] }]))
      .toEqual({ "hours:v-1": "07:00", "on:v-1": true });
  });

  test("only the cells a column names are seeded — the same set the server checks", () => {
    expect(seedValues([{ type: "table", columns: [{ key: "h", label: "H" }], rows: [{ h: { type: "text_input", action_id: "shown", initial_value: "x" }, hidden: { type: "text_input", action_id: "unseen", initial_value: "y" } }] }]))
      .toEqual({ shown: "x" });
  });

  test("a row's control is disabled while the page is busy, like every other control", () => {
    const nodes = tree([VENUES], { disabled: true });
    expect(labelled(nodes, "Hide").isDisabled).toBe(true);
  });

  test("a control in a row draws small — 830 call-to-action pills are not a table", () => {
    // The server says what the control IS; how big it draws is the host's call, and a data
    // row is not a toolbar. The same button in an `actions` block keeps the toolbar size.
    expect(labelled(tree([VENUES]), "Hide").size).toBe("sm");
    expect(labelled(tree([{ type: "actions", elements: [{ type: "button", action_id: "toggle", label: "Hide" }] }]), "Hide").size).toBeUndefined();
  });

  test("a cell the editor cannot draw says so instead of drawing a dead control", () => {
    // A server newer than this build could put an element type here that does not exist yet.
    // Named, like an unknown BLOCK is — a control that silently vanished from one row of 830
    // reads as data that is not there.
    const html = draw([{ type: "table", columns: [{ key: "a", label: "A" }], rows: [{ a: { type: "colour_picker", action_id: "c" } as unknown as AdminCell }] }]);
    expect(html).toContain("[unsupported cell: colour_picker]");
  });
});

describe("an error draws at the field", () => {
  const form: AdminBlock = {
    type: "form",
    block_id: "hours",
    fields: [
      { type: "text_input", action_id: "from", label: "From", initial_value: "25:00", error: "25:00 is not a time" },
      { type: "text_input", action_id: "to", label: "To", initial_value: "18:00" },
    ],
    submit: { label: "Save", action_id: "save" },
  };

  test("the message is under the input it is about, not floating over the page", () => {
    const html = draw([form], { values: { from: "25:00", to: "18:00" } });
    const field = html.indexOf('aria-label="From"');
    const message = html.indexOf("25:00 is not a time");
    const next = html.indexOf('aria-label="To"');
    expect(field).toBeGreaterThan(-1);
    expect(message).toBeGreaterThan(field);
    expect(message).toBeLessThan(next);
  });

  test("the offending control says so to a screen reader too", () => {
    const html = draw([form]);
    expect(html).toContain('role="alert"');
    expect(html.match(/aria-invalid="true"/g) ?? []).toHaveLength(1);
  });

  test("a field with no error draws nothing — an empty slot under every input is noise", () => {
    const html = draw([{ ...form, fields: [{ type: "text_input", action_id: "to", label: "To" }] }]);
    expect(html).not.toContain("role=\"alert\"");
    expect(html).not.toContain("aria-invalid");
  });

  test("a toggle can be wrong too — it is the one input that returns early", () => {
    const html = draw([{ type: "form", block_id: "f", fields: [{ type: "toggle", action_id: "on", label: "Published", error: "A hidden venue cannot be published" }], submit: { label: "Save", action_id: "save" } }]);
    expect(html).toContain("A hidden venue cannot be published");
    expect(html).toContain('aria-invalid="true"');
  });

  test("the generic missing-required hint still works beside it", () => {
    // The two answer different questions — "you have not filled this in yet" is decided in
    // the browser with no round trip, "25:00 is not a time" needs the server. Neither
    // replaces the other.
    const html = draw([{ type: "form", block_id: "f", fields: [{ type: "text_input", action_id: "from", label: "From", required: true }], submit: { label: "Save", action_id: "save" } }], { values: { from: "" } });
    expect(html).toContain("Fill in: From");
  });

  test("an error does not block submitting the fix", () => {
    // It came back WITH the response; nothing in the browser clears it, so a form that
    // refused to submit while an error was on screen could never be corrected.
    const fired: FiredLike[] = [];
    const nodes = tree([form], { values: { from: "25:00", to: "18:00" }, onFire: (f) => fired.push(f) });
    expect(labelled(nodes, "Save").isDisabled).toBe(false);
    propsOf(nodes.find((n) => n.type === "form")!).onSubmit!({ preventDefault: () => {} });
    expect(fired).toEqual([{ type: "form_submit", action_id: "save", block_id: "hours" }]);
  });
});
