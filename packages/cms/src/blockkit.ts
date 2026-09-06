// Block Kit — a custom admin PAGE, described by the server as JSON and rendered by the
// editor. No project JavaScript ever runs in the admin (GitHub #33, motivated by #44).
//
// WHY THIS RATHER THAN "SHIP THE COMPONENT TREE"
//
// Client sites are mostly conventional, but nearly every one grows one section that is not:
// a screen over an external API, a filtered browse UI over data we do not own, a bespoke
// picker. Before this the only seam was `extraNav`, which renders last and opens a NEW TAB
// — so the odd 10% was a separate deployment with its own chrome, and the admin read as
// "the CMS, plus a bolted-on other thing".
//
// The tempting fix is to publish `@pramen/cms-editor`'s components so each project
// assembles its own admin. That trades one maintained application for N per-project forks:
// a public component API to keep stable, version skew between editor internals and CMS
// handlers becoming every project's problem, and the same 80% reassembled everywhere.
//
// So the registry is widened instead, which is how WordPress actually works — plugins there
// do not work because they may ship PHP, they work because there is a registry of named
// hook points and core renders them in its own chrome. `collection()` is already that trick
// at the routing level (one generic editor, N collections, zero per-collection code) and
// `FieldDefinition[]` -> `FieldForm` is already "server-described form, host-rendered". Block
// Kit is those two taken all the way: arbitrary admin PAGES, not just forms over rows.
//
// WHAT IT IS NOT
//
// It is not a way to reach past the ACL. A page's `render` is an ordinary handler body: it
// gets the caller's own `HandlerContext`, so `ctx.db` is scoped by the same policies as
// everywhere else. What Block Kit removes is the browser code, not the boundary.
//
// It is also not a "virtual collection". A `collection()` promises ACL through `ctx.db`,
// row scope, cell-level projection and `where` traversal — all of which follow from it
// being a REAL TABLE. A page here promises none of those, and says so by not being called a
// collection.

import { BadRequest, mutation, query } from "@pramen/server";
import type { HandlerContext, JsonValue, SchemaDef } from "@pramen/server";
import { isSafeHref, normalizeHref } from "./href";
import { NAV_ORDER } from "./nav";
import { isAdminPanel, type AdminPanelDef } from "./panel";

// --- the block/element vocabulary ------------------------------------------------------

/** Text with no formatting. Rendered as text, never as markup — the editor puts every
 * string through React, so there is no HTML path here to sanitize. */
export type AdminText = string;

/** An input a form, an actions row or a table cell can carry.
 *
 * `error` is the per-FIELD failure, rendered under the offending input. The page-level
 * `toast` cannot do that job: it names no field, it is gone in three seconds while the bad
 * value is still on screen, and a form with six inputs gives the reader no way to tell which
 * one "25:00 is not a time" is about. It is a plain part of the render — the whole page
 * comes back on every interaction, so an error lives exactly as long as the response that
 * carried it, and there is nothing to clear. */
export type AdminInput =
  | { type: "text_input"; action_id: string; label?: AdminText; placeholder?: AdminText; initial_value?: string; multiline?: boolean; required?: boolean; error?: AdminText }
  | { type: "number_input"; action_id: string; label?: AdminText; placeholder?: AdminText; initial_value?: number; min?: number; max?: number; required?: boolean; error?: AdminText }
  | { type: "select"; action_id: string; label?: AdminText; options: { value: string; label: AdminText }[]; initial_value?: string; required?: boolean; error?: AdminText }
  | { type: "toggle"; action_id: string; label?: AdminText; initial_value?: boolean; error?: AdminText }
  /** Write-only: never echoed back to the browser once stored. The editor renders it as a
   * password field and sends it only on submit; a page that stores one must NOT put it back
   * in `initial_value` on the next render, which is why there is no such key here. */
  | { type: "secret_input"; action_id: string; label?: AdminText; placeholder?: AdminText; required?: boolean; error?: AdminText };

/** A button. `value` rides back on the interaction, so one `action_id` can serve a row. */
export interface AdminButton {
  type: "button";
  action_id: string;
  label: AdminText;
  style?: "primary" | "secondary" | "danger";
  value?: string;
  /** Ask before firing. Any destructive action should set it — the page cannot put up its
   * own dialog, because it has no code in the browser. */
  confirm?: AdminText;
}

export type AdminElement = AdminButton | AdminInput;

/** Every `AdminElement` tag, as a runtime set.
 *
 * Both halves need this at RUNTIME, which is why it is a value and not only a union: the
 * server checks that an object sitting in a table cell really is an element, and the editor
 * decides from the same set whether a cell draws as text or as a control. The editor keeps
 * its own copy (it has no dependency on this package) and `test/cms-editor-mirrors.test.ts`
 * fails if the two drift. */
export const ADMIN_ELEMENT_TYPES = ["button", "text_input", "number_input", "select", "toggle", "secret_input"] as const;

/** What one table cell holds: a value to READ, or an element to ACT with.
 *
 * The alternative shape was a per-COLUMN element declaration — `columns: [{ key, label,
 * element }]` — and it is the wrong unit. Everything about a row's control is a fact of the
 * ROW: the button's `value` is that row's id, its label is "Hide" or "Show" depending on
 * that row's state, and a row that must not be touched carries no control at all. A column
 * declaration would have to be a template with a substitution language, which is a second
 * vocabulary to design and to escape. A cell already varies per row, so the element goes in
 * the cell and the column keeps saying only where it lands. A cell is a value OR an element,
 * never both; a column that wants both is two columns.
 *
 * The two are told apart by SHAPE: a display value is a primitive, an element is an object,
 * and nothing else may be an object. `normalizeAdminResponse` enforces that, so a page that
 * splats a whole row (`rows: found`) into the table is named at the boundary instead of
 * rendering a column of `[object Object]` — or, worse, of half-elements. */
export type AdminCell = AdminText | number | boolean | null | AdminElement;

/** One block in a rendered admin page. */
export type AdminBlock =
  | { type: "header"; text: AdminText; level?: 1 | 2 | 3 }
  | { type: "section"; text: AdminText }
  | { type: "divider" }
  /** Small muted text — a caption, a timestamp, a hint. */
  | { type: "context"; text: AdminText }
  /** Label/value pairs, for a record's details. */
  | { type: "fields"; fields: { label: AdminText; value: AdminText }[] }
  /** `block_id` rides back on an interaction a CELL fired, the same way an `actions` block's
   * does — so a page with two tables can tell which one a shared `action_id` came from. */
  | { type: "table"; block_id?: string; columns: { key: string; label: AdminText }[]; rows: Record<string, AdminCell>[]; empty?: AdminText }
  | { type: "stats"; stats: { label: AdminText; value: AdminText; hint?: AdminText }[] }
  | { type: "actions"; block_id?: string; elements: AdminElement[] }
  | { type: "form"; block_id: string; fields: AdminInput[]; submit: { label: AdminText; action_id: string } }
  | { type: "image"; url: string; alt?: AdminText; caption?: AdminText }
  | { type: "columns"; columns: AdminBlock[][] }
  | { type: "empty"; text: AdminText; hint?: AdminText }
  | { type: "accordion"; title: AdminText; blocks: AdminBlock[]; open?: boolean };

/** Why the page is being rendered. */
export type AdminInteractionType = "page_load" | "block_action" | "form_submit";

/** What the editor sends. */
export interface AdminPageInteraction {
  /** The registry key. Resolved to a `AdminPageDef` server-side; an unknown one is a 400,
   * never a raw dispatch to something the client named. */
  page: string;
  type: AdminInteractionType;
  /** `block_action` / `form_submit`: which control fired. */
  action_id?: string;
  /** The block the control belongs to. */
  block_id?: string;
  /** A button's `value`. */
  value?: JsonValue;
  /** `form_submit`: `action_id` -> the input's value. */
  values?: Record<string, JsonValue>;
}

/** What a page answers with. The WHOLE page is re-rendered on every interaction — there is
 * no patch protocol — because a page that returns only what changed has to agree with the
 * host about what is currently on screen, and the two drift the first time a render depends
 * on data that moved underneath it. */
export interface AdminPageResponse {
  blocks: AdminBlock[];
  /** A transient message shown over the page. */
  toast?: { text: AdminText; tone?: "info" | "success" | "error" };
}

/** How deep `columns` / `accordion` may nest blocks. Rendering is recursive and the
 * response is server-authored but not necessarily hand-written, so it is capped. */
export const MAX_ADMIN_BLOCK_DEPTH = 4;

// --- the registry ----------------------------------------------------------------------

/** One custom admin page.
 *
 * Generic over the app's schema so `render`'s `ctx.db` is TYPED against it —
 * `adminPage<typeof schema>("…", …)`, the same shape `MigrationContext<typeof schema>` uses.
 * Without it `ctx.db.find({ from: "lectures", where: { title: { contains: q } } })` resolves
 * the table against the default `SchemaDef` and every column reads as a number. */
export interface AdminPageDef<S extends SchemaDef = SchemaDef> {
  /** Discriminates this from an `AdminPanelDef` in the registry the two share. Optional and
   * defaulted, because a Block Kit page is what `adminPage()` has always produced and
   * nothing should have to start saying so. */
  readonly kind?: "blocks";
  /** URL + registry key: the page is served at `/apps/:slug` in the editor. */
  readonly slug: string;
  /** Nav label. */
  readonly label: string;
  /** Optional nav icon (emoji or short string). */
  readonly icon?: string;
  /** Where it sits in the nav — see {@link NAV_ORDER}. Defaults to `NAV_ORDER.adminPages`.
   * This is the half of #44 that makes a project section part of the admin rather than a
   * link at the end of it. */
  readonly navOrder?: number;
  /** Roles that may open and interact with it. Defaults to the deployment's `editorRoles`.
   *
   * A per-page list rather than one gate for all of them: these are project surfaces, and
   * "the finance screen is admin-only while the dispatch screen is not" is the ordinary
   * case. Enforced in the handler, before `render` runs. */
  readonly roles?: readonly string[];
  /** Build the page. An ordinary handler body: `ctx.db` is the caller's, ACL and all. */
  render(ctx: HandlerContext<S>, interaction: AdminPageInteraction): Promise<AdminPageResponse> | AdminPageResponse;
}

/** Declare a custom admin page. Spread the results into `createAdminPageHandlers`:
 *
 *   const dispatch = adminPage("dispatch", {
 *     label: "Dispatch",
 *     icon: "🚚",
 *     navOrder: NAV_ORDER.media + 10,
 *     async render(ctx, i) {
 *       if (i.type === "form_submit" && i.action_id === "assign") { … }
 *       const rows = await ctx.db.find({ from: "orders", limit: 50 });
 *       return { blocks: [{ type: "header", text: "Today" }, { type: "table", columns, rows }] };
 *     },
 *   });
 */
export function adminPage<S extends SchemaDef = SchemaDef>(slug: string, opts: Omit<AdminPageDef<S>, "slug">): AdminPageDef<S> {
  return { ...opts, slug };
}

/** One entry in the custom-screens registry: a Block Kit page, or a panel the browser
 * renders. They share a registry — and so a slug space, a route and a nav band — because
 * from the editor's side they are the same thing (a project's own screen inside the chrome)
 * differing only in where the rendering happens. Two registries would have made a slug
 * collision between them a runtime surprise instead of a boot error. */
export type AdminScreenDef<S extends SchemaDef = SchemaDef> = AdminPageDef<S> | AdminPanelDef;

/** Every screen kind, as a runtime set. A value and not only a union because the editor
 * keeps its own copy and `test/cms-editor-mirrors.test.ts` fails if the two drift — a kind
 * the server sends and the editor has not heard of is a nav entry that renders nothing. */
export const ADMIN_PAGE_KINDS = ["blocks", "panel"] as const;
export type AdminPageKind = (typeof ADMIN_PAGE_KINDS)[number];

/** The client-facing view of a registered screen — what the editor needs to put it in the
 * nav and decide how to render it. Never the `render` function, and never the role list
 * (which is a server fact; a screen the caller may not open is simply absent from the
 * listing). */
export interface AdminPageMeta {
  slug: string;
  label: string;
  icon?: string;
  navOrder: number;
  /** `"blocks"` (Block Kit, rendered from this response) or `"panel"` (a component the
   * deployment's panel bundle registered under this slug). */
  kind: AdminPageKind;
}

/** Validate a registry at boot: slugs are unique and routable, and every screen can be
 * addressed. Called by `createAdminPageHandlers`, so a mistake surfaces when the Worker
 * starts rather than as a 404 the first time someone opens the one page nobody exercised.
 *
 * Pages and panels are validated TOGETHER, against one `seen` set: they share `/apps/:slug`,
 * so two entries with the same slug are a collision whatever their kinds — and the one that
 * would win is decided by insertion order into a Map, which is not a thing to leave to
 * chance. */
export function validateAdminPages(pages: readonly AdminScreenDef[]): void {
  const seen = new Set<string>();
  for (const p of pages) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug) || p.slug.length > 80) {
      throw new Error(`pramen/cms: admin page slug '${p.slug}' must be a URL segment (lowercase letters, digits and single hyphens) — it is routed at /apps/:slug`);
    }
    if (seen.has(p.slug)) throw new Error(`pramen/cms: duplicate admin page slug '${p.slug}' — the slug is the registry's key`);
    seen.add(p.slug);
    if (p.label.trim() === "") throw new Error(`pramen/cms: admin page '${p.slug}' has an empty label — it would render an unnamed nav entry`);
    // A panel has no server render by definition, so the check is skipped for it rather
    // than relaxed for everyone: "no render function" stays a boot error for a Block Kit
    // page, which is the one it was written to catch.
    if (!isAdminPanel(p) && typeof p.render !== "function") throw new Error(`pramen/cms: admin page '${p.slug}' has no render function`);
  }
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const held = (ctx: HandlerContext): string[] => {
  const identity = ctx.identity as { roles?: unknown; role?: unknown } | undefined;
  if (Array.isArray(identity?.roles)) return identity.roles.map(String);
  return typeof identity?.role === "string" ? [identity.role] : [];
};

export interface AdminPageHandlerOpts {
  /** Default roles for a page that declares none. Pass the same `editorRoles` the rest of
   * the CMS uses, so one deployment has one answer to "who may author". */
  editorRoles?: readonly string[];
}

/**
 * Build the two handlers a Block Kit deployment needs. Spread into your app's handlers.
 *
 *   ...createAdminPageHandlers([dispatch, reconciliation], { editorRoles })
 *
 * There is no ACL fragment to spread: a page reads through `ctx.db` under whatever policies
 * the caller already has, so there is nothing here to grant.
 */
export function createAdminPageHandlers(pages: readonly AdminScreenDef[], opts: AdminPageHandlerOpts = {}) {
  validateAdminPages(pages);
  const defaultRoles = opts.editorRoles ?? ["editor", "admin"];
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const rolesFor = (p: AdminScreenDef): readonly string[] => p.roles ?? defaultRoles;
  const mayOpen = (ctx: HandlerContext, p: AdminScreenDef): boolean => held(ctx).some((r) => rolesFor(p).includes(r));

  return {
    /** The screens THIS caller may open — Block Kit pages and panels alike. Filtered rather
     * than role-annotated: a nav entry that 403s when clicked is worse than one that is not
     * there, and the role list is a server fact the browser has no use for.
     *
     * A panel is filtered by exactly the same gate, which is the whole reason it is a
     * registry entry rather than a client-side registration: the browser bundle decides
     * only how the screen DRAWS, never whether this caller has one. */
    listAdminPages: query((ctx): AdminPageMeta[] =>
      pages
        .filter((p) => mayOpen(ctx, p))
        .map((p) => ({ slug: p.slug, label: p.label, icon: p.icon, navOrder: p.navOrder ?? NAV_ORDER.adminPages, kind: isAdminPanel(p) ? "panel" : "blocks" })),
    ),

    /**
     * Render a page, or act on it and render the result.
     *
     * A MUTATION, always — including `page_load`. A page's `render` is arbitrary handler
     * code and a `form_submit` writes, so the call has to run inside the transaction the
     * dispatcher wraps a mutation in. Splitting loads into a query would mean one of the
     * two entry points into the same function was not transactional, and which one you got
     * would depend on the `type` field the CLIENT sent.
     */
    adminPageInteract: mutation(async (ctx, input: AdminPageInteraction): Promise<AdminPageResponse> => {
      // The registry, keyed by slug — the same defence `collectionList` uses. An unknown
      // slug is a 400 naming nothing, never a dispatch to something the client chose.
      const page = bySlug.get(input.page);
      if (!page) throw new BadRequest(`unknown admin page '${input.page}'`);
      // Before `render`, so a page's own code never runs for a caller who may not open it.
      if (!mayOpen(ctx, page)) throw new BadRequest(`unknown admin page '${input.page}'`);
      // A panel renders in the BROWSER, so there is nothing here to interact with. Said
      // plainly rather than folded into "unknown admin page": the caller may open this
      // screen (it passed the gate above), so hiding its existence would only send whoever
      // wired the call looking for a registration mistake that is not there. It is a client
      // bug — the editor routes a panel to its component and never calls this.
      if (isAdminPanel(page)) throw new BadRequest(`admin page '${input.page}' is a panel — it renders in the browser and has no server-side render`);
      const res = await page.render(ctx, input);
      return normalizeAdminResponse(res);
    }, {
      input: (raw): AdminPageInteraction => {
        const o = asObj(raw);
        const slug = typeof o.page === "string" ? o.page : "";
        if (!slug) throw new BadRequest("page is required");
        const type = (typeof o.type === "string" ? o.type : "page_load") as AdminInteractionType;
        if (!["page_load", "block_action", "form_submit"].includes(type)) throw new BadRequest(`unknown interaction type '${String(o.type)}'`);
        const out: AdminPageInteraction = { page: slug, type };
        if (typeof o.action_id === "string") out.action_id = o.action_id;
        if (typeof o.block_id === "string") out.block_id = o.block_id;
        if (o.value !== undefined) out.value = o.value as JsonValue;
        if (o.values !== undefined) {
          if (o.values === null || typeof o.values !== "object" || Array.isArray(o.values)) throw new BadRequest("values must be an object");
          out.values = o.values as Record<string, JsonValue>;
        }
        return out;
      },
    }),
  };
}

// --- response normalization --------------------------------------------------------------

/**
 * Check a page's response on the way OUT.
 *
 * Server-authored is not the same as trustworthy: a page builds blocks from data — a row's
 * title, a URL out of an external API — so the values inside a block can be anything the
 * store holds. Text is safe by construction (the editor renders every string through React,
 * so there is no markup path), which leaves the attributes that are NOT text:
 *
 *   - `image.url` becomes an `<img src>`, so it goes through the same `isSafeHref`
 *     allow-list a rich-text link mark does.
 *   - nesting is capped, because rendering is recursive.
 *   - a table cell that is an OBJECT is claiming to be an element, and is checked as one.
 *   - every input's `action_id` is claimed once per page, because the editor keys the
 *     page's whole value bag by it.
 *
 * A bad block throws rather than being dropped: this is the page author's own output, and a
 * block that silently vanishes is a bug that reads as "the data isn't there".
 */
export function normalizeAdminResponse(res: AdminPageResponse): AdminPageResponse {
  if (!res || !Array.isArray(res.blocks)) throw new Error("pramen/cms: an admin page must return { blocks: [...] }");
  // One set for the WHOLE response, because the value bag it guards is per PAGE, not per
  // block — an input in a form and an input in a table cell collide just as hard as two in
  // one form.
  const inputIds = new Set<string>();
  const out: AdminPageResponse = { blocks: res.blocks.map((b) => normalizeAdminBlock(b, 0, inputIds)) };
  if (res.toast) out.toast = { text: String(res.toast.text), tone: res.toast.tone };
  return out;
}

function normalizeAdminBlock(block: AdminBlock, depth: number, inputIds: Set<string>): AdminBlock {
  if (depth >= MAX_ADMIN_BLOCK_DEPTH) throw new Error(`pramen/cms: admin blocks nest deeper than ${MAX_ADMIN_BLOCK_DEPTH} levels`);
  switch (block.type) {
    case "image": {
      const url = normalizeHref(block.url);
      if (!isSafeHref(url)) throw new Error(`pramen/cms: admin page image url ${JSON.stringify(block.url)} is not an allowed href`);
      return { ...block, url };
    }
    case "columns":
      return { ...block, columns: block.columns.map((col) => col.map((b) => normalizeAdminBlock(b, depth + 1, inputIds))) };
    case "accordion":
      return { ...block, blocks: block.blocks.map((b) => normalizeAdminBlock(b, depth + 1, inputIds)) };
    case "form":
      // `block_id` is how the editor keys a form's local values. Two forms sharing one would
      // share their state, so the second would submit the first one's inputs.
      if (!block.block_id) throw new Error("pramen/cms: a `form` block needs a block_id");
      for (const f of block.fields) claimInputId(f, `form '${block.block_id}'`, inputIds);
      return block;
    case "actions":
      for (const el of block.elements) if (el.type !== "button") claimInputId(el, "an `actions` block", inputIds);
      return block;
    case "table": {
      // Only the cells a COLUMN names are looked at, because only those are rendered. A key
      // in `rows` with no column is data the table happens to carry along; checking it would
      // reject rows a page is free to build wide and display narrow.
      for (const [i, row] of block.rows.entries()) {
        for (const c of block.columns) {
          const cell = row[c.key];
          if (!isElementCell(cell)) continue;
          checkCellElement(cell, c.key, i);
          if (cell.type !== "button") claimInputId(cell, `table column '${c.key}'`, inputIds);
        }
      }
      return block;
    }
    default:
      return block;
  }
}

/** An object in a cell is claiming to be an element — nothing else may be one. Narrowed to
 * `AdminElement` here only so the check that follows can read its tag; whether it IS one is
 * exactly what {@link checkCellElement} decides. */
const isElementCell = (cell: AdminCell | undefined): cell is AdminElement => cell !== null && typeof cell === "object";

function checkCellElement(cell: AdminElement, column: string, rowIndex: number): void {
  const where = `table column '${column}', row ${rowIndex}`;
  const kinds = ADMIN_ELEMENT_TYPES as readonly string[];
  if (!kinds.includes(cell.type)) {
    throw new Error(`pramen/cms: ${where} holds an object that is not an admin element (type ${JSON.stringify(cell.type)}). A cell is a value or one of ${kinds.join(", ")} — a whole row object put in a cell would render as [object Object]`);
  }
  if (!cell.action_id) throw new Error(`pramen/cms: the element in ${where} has no action_id — nothing would come back when it fires`);
  if (cell.type === "button" && !cell.label) throw new Error(`pramen/cms: the button in ${where} has no label — it would draw as an empty control`);
}

/** Claim one input's `action_id` for the page.
 *
 * The editor holds ONE value bag for the whole page, keyed by `action_id`, because that is
 * what makes a filter in one block reach a button in another. So two inputs sharing an id
 * are one field wearing two hats, which is only ever a bug — and the way to write it by
 * accident is to build a table and put the same input literal in every row. */
function claimInputId(input: AdminInput, where: string, seen: Set<string>): void {
  if (seen.has(input.action_id)) {
    throw new Error(
      `pramen/cms: action_id '${input.action_id}' is used by more than one input on this page (${where}) — the editor keys the page's value bag by action_id, so they would be ONE field: same value shown in every copy, and the last write wins on submit. A per-ROW input has to mint a per-row id (\`hours:\${row.id}\`); a per-row BUTTON does not, because its \`value\` rides back on the interaction instead`,
    );
  }
  seen.add(input.action_id);
}
