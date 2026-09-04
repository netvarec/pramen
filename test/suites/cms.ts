// @pramen/cms e2e — the block/page builder wired into the example app. Exercises the
// full flow against a real wrangler-dev DO: define block/content types, build a page from
// typed blocks in named regions, field validation + region allow-lists, publish (snapshot),
// the public content API (anonymous sees only the published snapshot), preview gating,
// reusable-block overrides, and scheduled publish (an outbox task).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, http, token } from "../lib";

/** A minimal rich-text document. `richtext` is a document TREE, not an HTML string — the
 * server rejects a string outright, so every fixture below builds one of these. */
const rt = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

/** Drain the tenant's outbox now (the DO also self-drains via an alarm; this makes the
 * scheduled-publish assertions deterministic). */
async function drain(base: string, admin: string): Promise<void> {
  await fetch(`${base}/admin/tasks/drain`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ tenant: "main" }),
  });
}

export async function runCms(base: string): Promise<void> {
  // The public content API is anonymous, and anonymous callers can only reach the open
  // `main` tenant (authorizeTenant gates other tenants). Run the whole suite on `main`.
  const TENANT = "main";
  const call = http(base, TENANT);
  const admin = await token("cms-admin", ["admin"]);
  const slug = "about-us";

  // --- app.bootstrap: a fresh tenant is already seeded with code-defined types on boot ---
  // example/app.ts registers cmsBootstrap({ contentTypes: [seeded_doc], blockTypes: [seeded_note] }).
  // Before this suite creates anything, those must already exist — proving the server ran
  // app.bootstrap after migrating this tenant's store (no createContentType call was made).
  const seededCts = await call("listContentTypes", {}, admin);
  assert(
    seededCts.body.ok && (seededCts.body.result as Array<{ slug: string }>).some((c) => c.slug === "seeded_doc"),
    "cms: app.bootstrap seeded the 'seeded_doc' content type on boot (no manual create)",
  );
  const seededBts = await call("listBlockTypes", {}, admin);
  assert(
    seededBts.body.ok && (seededBts.body.result as Array<{ slug: string }>).some((b) => b.slug === "seeded_note"),
    "cms: app.bootstrap seeded the 'seeded_note' block type on boot",
  );

  // GitHub #48 — a seeded type is CODE-DEFINED, and bootstrap patches it back on every boot.
  // The flag is what the editor reads to render it read-only; the refusal below is what stops
  // a curl (or a stale tab) from making an edit that silently disappears at the next cold start.
  assert(
    (seededBts.body.result as Array<{ slug: string; managedBy?: string | null }>).find((b) => b.slug === "seeded_note")?.managedBy === "cms",
    "cms: a bootstrap-declared block type carries its reconciler's owner id",
  );
  assert(
    (seededCts.body.result as Array<{ slug: string; managedBy?: string | null }>).find((c) => c.slug === "seeded_doc")?.managedBy === "cms",
    "cms: a bootstrap-declared content type carries its reconciler's owner id",
  );
  // Declared, not inferred from the rows: the editor is a separate package that can be newer
  // than the server, where every row reports no owner and nothing would render read-only.
  const caps = await call("listCmsCapabilities", {}, admin);
  assert(caps.body.ok === true && (caps.body.result as { codeDefinedTypes?: boolean }).codeDefinedTypes === true,
    "cms: listCmsCapabilities declares codeDefinedTypes, so an older server fails closed");
  const editSeeded = await call("updateBlockType", { slug: "seeded_note", name: "Hijacked" }, admin);
  assert(
    editSeeded.status === 409 && editSeeded.body.ok === false,
    "cms: updateBlockType refuses a code-defined type (409), rather than accepting a write bootstrap reverts",
  );
  const editSeededCt = await call("updateContentType", { slug: "seeded_doc", name: "Hijacked" }, admin);
  assert(editSeededCt.status === 409 && editSeededCt.body.ok === false, "cms: updateContentType refuses a code-defined type (409)");

  // --- editor auth: an anonymous caller cannot create block types ---
  const anonCreate = await call("createBlockType", { name: "X", slug: "x" });
  assert(anonCreate.status === 403 && anonCreate.body.ok === false, "cms: anonymous cannot create a block type (403)");

  // `listPublicContentTypes` is the un-gated listing `@pramen/cms-astro`'s
  // `collections: "auto"` reads at BUILD time, where there is no editor session. The
  // editor-facing `listContentTypes` stays viewer-gated beside it.
  const anonTypes = await call("listPublicContentTypes", {});
  assert(anonTypes.body.ok === true && Array.isArray(anonTypes.body.result), "cms: listPublicContentTypes is readable anonymously");
  assert(
    (anonTypes.body.result as Array<Record<string, unknown>>).every((t) => typeof t.slug === "string" && typeof t.name === "string" && !("regions" in t) && !("fieldsSchema" in t)),
    "cms: the public content-type listing is slug + name only — never the editing surface",
  );
  assert((await call("listContentTypes", {})).status === 403, "cms: the editor-facing listContentTypes stays viewer-gated");

  // --- define block types (data-driven: a webmaster adds a type with no deploy) ---
  const heroType = await call("createBlockType", {
    name: "Hero",
    slug: "hero",
    category: "Layout",
    fieldsSchema: [
      { name: "heading", label: "Heading", type: "text", required: true },
      { name: "subtitle", label: "Subtitle", type: "text" },
    ],
  }, admin);
  assert(heroType.body.ok && typeof heroType.body.result.id === "string", "cms: createBlockType(hero) returns a uuid id");

  const richType = await call("createBlockType", {
    name: "Rich Text",
    slug: "rich_text",
    fieldsSchema: [{ name: "body", label: "Body", type: "richtext", required: true }],
  }, admin);
  assert(richType.body.ok, "cms: createBlockType(rich_text) ok");

  // --- define a content type with named regions + a region allow-list ---
  const ct = await call("createContentType", {
    name: "Article",
    slug: "article",
    regions: [
      { name: "hero", label: "Hero", allowedTypes: ["hero"] },
      { name: "content", label: "Content" },
    ],
  }, admin);
  assert(ct.body.ok, "cms: createContentType ok");

  // --- update a type in place (found by slug; the schema can evolve, e.g. text → date) ---
  const anonUpd = await call("updateBlockType", { slug: "hero", name: "Nope" });
  assert(anonUpd.status === 403, "cms: anonymous cannot update a block type (403)");

  const updBt = await call("updateBlockType", {
    slug: "hero",
    fieldsSchema: [
      { name: "heading", type: "text", required: true },
      { name: "publishedOn", type: "date" },
    ],
  }, admin);
  const updBtFields = updBt.body.result?.fieldsSchema as Array<{ name: string; type: string }> | undefined;
  assert(updBt.body.ok && updBtFields?.some((f) => f.name === "publishedOn" && f.type === "date"), "cms: updateBlockType patches fieldsSchema in place (by slug)");
  const btList = await call("listBlockTypes", {}, admin);
  const heroNow = (btList.body.result as Array<{ slug: string; fieldsSchema: Array<{ name: string }> }>).find((b) => b.slug === "hero");
  assert(heroNow?.fieldsSchema?.some((f) => f.name === "publishedOn"), "cms: the block-type update persists");

  const updCt = await call("updateContentType", { slug: "article", fieldsSchema: [{ name: "date", type: "date" }] }, admin);
  const updCtFields = updCt.body.result?.fieldsSchema as Array<{ name: string; type: string }> | undefined;
  assert(updCt.body.ok && updCtFields?.some((f) => f.name === "date" && f.type === "date"), "cms: updateContentType patches a page-level field (text → date)");

  const updMissing = await call("updateContentType", { slug: "does-not-exist", name: "X" }, admin);
  assert(updMissing.status === 404, "cms: updating an unknown content type is a 404");

  // --- create a page (draft) ---
  const page = await call("createPage", { typeId: ct.body.result.id, title: "About Us", slug }, admin);
  assert(page.body.ok && page.body.result.status === "draft", "cms: createPage starts as a draft");
  const pageId = page.body.result.id as string;

  // --- a draft is invisible to the public content API (ACL scopes reads to published) ---
  const draftPublic = await call("getPage", { slug });
  assert(draftPublic.status === 404 && draftPublic.body.ok === false, "cms: anonymous cannot read a draft page (404)");

  // --- field validation: types are always enforced (required is deferred to publish so a
  // DRAFT block can be added then filled in) ---
  const bad = await call("addBlock", { pageId, blockTypeSlug: "hero", region: "hero", fields: { heading: 123 } }, admin);
  assert(bad.status === 400 && bad.body.ok === false, "cms: a wrong-typed field is rejected (400)");
  const draftBlock = await call("addBlock", { pageId, blockTypeSlug: "hero", region: "hero", fields: { subtitle: "no heading yet" } }, admin);
  assert(draftBlock.body.ok, "cms: a draft block missing a required field is allowed (filled in later)");
  await call("removeBlock", { pageBlockId: draftBlock.body.result.placement.id }, admin);

  // --- region allow-list: the hero region only permits `hero`, so a rich_text is rejected ---
  const wrongRegion = await call("addBlock", { pageId, blockTypeSlug: "rich_text", region: "hero", fields: { body: rt("x") } }, admin);
  assert(wrongRegion.status === 400 && wrongRegion.body.ok === false, "cms: a block type not allowed in a region is rejected (400)");

  // --- an EMPTY allowedTypes region means "any type" (matches the editor), not "none" ---
  const anyCt = await call("createContentType", { name: "AnyRegion", slug: "any-region", regions: [{ name: "main", allowedTypes: [] }] }, admin);
  const anyPage = await call("createPage", { typeId: anyCt.body.result.id, title: "Any", slug: "any-page" }, admin);
  const anyAdd = await call("addBlock", { pageId: anyPage.body.result.id, blockTypeSlug: "hero", region: "main", fields: { heading: "x" } }, admin);
  assert(anyAdd.body.ok, "cms: a region with empty allowedTypes accepts any block type");

  // --- place typed blocks in regions ---
  const heroBlock = await call("addBlock", { pageId, blockTypeSlug: "hero", region: "hero", fields: { heading: "About Us", subtitle: "Who we are" } }, admin);
  assert(heroBlock.body.ok, "cms: addBlock(hero) ok");
  const rich1 = await call("addBlock", { pageId, blockTypeSlug: "rich_text", region: "content", fields: { body: rt("Our story.") } }, admin);
  const rich2 = await call("addBlock", { pageId, blockTypeSlug: "rich_text", region: "content", fields: { body: rt("Our mission.") } }, admin);
  assert(rich1.body.ok && rich2.body.ok, "cms: two rich_text blocks placed in content");

  // --- preview: an editor assembles the current draft live ---
  const preview = await call("getPage", { slug, preview: true }, admin);
  assert(preview.body.ok && preview.body.result.regions.hero[0].fields.heading === "About Us", "cms: editor preview assembles the draft");
  assert(preview.body.result.regions.content.length === 2, "cms: preview content region has both blocks in order");
  // preview is editor-only
  const anonPreview = await call("getPage", { slug, preview: true });
  assert(anonPreview.status === 403, "cms: anonymous preview is forbidden (403)");

  // --- signed preview links: a capability, not a role ---
  // The point of preview is the stakeholder WITHOUT an account. An editor mints a signed,
  // self-expiring link naming one page; redeeming it needs no session at all.
  // --- listing pages: viewer-gated, narrowed BY THE SERVER, and addressable by id ---
  // The rows are full page records (schedule stamps, revision pointer, every SEO column,
  // the whole `fields` bag) — the editing surface, not the published one.
  assert((await call("listPages", {})).status === 403, "cms: listPages is viewer-gated (anonymous 403)");
  assert((await call("getPageById", { pageId })).status === 403, "cms: getPageById is viewer-gated (anonymous 403)");

  const byId = await call("getPageById", { pageId }, admin);
  assert(byId.body.ok && byId.body.result?.id === pageId, "cms: getPageById opens a page directly, without resolving it against a capped list");
  assert((await call("getPageById", { pageId: "00000000-0000-4000-8000-000000000000" }, admin)).body.result === null, "cms: getPageById answers null for an unknown id");

  const allPages = (await call("listPages", {}, admin)).body.result as Array<{ id: string; slug: string }>;
  const byType = (await call("listPages", { contentType: "article" }, admin)).body.result as Array<{ id: string; slug: string }>;
  assert(byType.some((p) => p.slug === slug), "cms: listPages({ contentType }) returns that type's pages");
  assert(byType.length <= allPages.length, "cms: the type-scoped list is a subset of the pooled one");
  const otherType = (await call("listPages", { contentType: "seeded_doc" }, admin)).body.result as Array<{ slug: string }>;
  assert(!otherType.some((p) => p.slug === slug), "cms: another type's list does not carry this page");
  // An unknown slug — and an EMPTY one, which a falsy check read as "no filter" — must
  // return nothing rather than every type's pages under a tab naming one.
  assert(((await call("listPages", { contentType: "no-such-type" }, admin)).body.result as unknown[]).length === 0, "cms: an unknown content-type slug lists nothing, not everything");
  assert(((await call("listPages", { contentType: "" }, admin)).body.result as unknown[]).length === 0, "cms: an empty content-type slug lists nothing, not everything");
  // Paged, so the caller can tell a full first page from the whole table.
  const firstOnly = (await call("listPages", { limit: 1 }, admin)).body.result as unknown[];
  assert(firstOnly.length === 1, "cms: listPages honours an explicit limit");
  // Projection: only the named columns come back (the D1-over-RPC shape — see GitHub #22).
  const projected = (await call("listPages", { limit: 1, select: ["id", "title"] }, admin)).body.result as Array<Record<string, unknown>>;
  assert(projected[0] && "title" in projected[0] && !("fields" in projected[0]) && !("metaTitle" in projected[0]), "cms: listPages({ select }) projects to the named columns");

  const pageRow = allPages.find((p) => p.slug === slug) as { id: string };
  const minted = await call("signPagePreview", { pageId: pageRow.id }, admin);
  assert(minted.body.ok && typeof minted.body.result.token === "string", "cms: signPagePreview mints a token for an editor");
  assert(String(minted.body.result.url).startsWith("/cms/preview?token="), "cms: the minted preview url is relative, like a signed file url");
  const previewToken = minted.body.result.token as string;

  // minting is editor-gated even though redeeming is not
  const anonMint = await call("signPagePreview", { pageId: pageRow.id });
  assert(anonMint.status === 403, "cms: minting a preview link is editor-gated (403)");

  // redeem with NO auth header at all
  const redeemed = await fetch(`${base}${minted.body.result.url}`);
  const redeemedBody = await redeemed.json() as { regions?: Record<string, unknown[]>; isPreview?: boolean };
  assert(redeemed.status === 200, "cms: a signed preview link is redeemable with no session");
  assert(redeemedBody.isPreview === true, "cms: a redeemed preview is flagged isPreview");
  assert((redeemedBody.regions?.content ?? []).length === 2, "cms: the redeemed preview carries the LIVE draft blocks");
  assert(redeemed.headers.get("cache-control") === "private, no-store", "cms: a preview response is never cached");

  // The route must work under the roles an app ACTUALLY configures. The e2e app defines
  // an `admin` role, which masked a bug where the route hardcoded roles:["admin"] — under
  // the README's own wiring (anonymous + editor, no admin) every link 404'd. Redeeming as
  // a plain editor exercises the configured-viewer-roles path.
  const plainEditor = await token("cms-editor-only", ["editor"]);
  const editorMint = await call("signPagePreview", { pageId: pageRow.id }, plainEditor);
  assert(editorMint.body.ok, "cms: a plain editor (no admin role) can mint a preview link");
  const editorRedeem = await fetch(`${base}${editorMint.body.result.url}`);
  assert(editorRedeem.status === 200, "cms: a link minted by a plain editor redeems (the route presents viewer roles, not admin)");

  // The D1 store is the topology an Astro site embeds (no Durable Object to export), so
  // preview has to work there too. `callPrivileged` now dispatches locally on D1 instead
  // of only forwarding to a DO, which is what used to make a D1-minted link undeliverable.
  // The store is chosen PER REQUEST, and the two stores hold different rows — so this runs
  // the whole flow on D1: seed a page there, mint from there, redeem from there. (A real
  // D1 deployment sets PRAMEN_STORE=d1 and never sends the header; the e2e app defaults to
  // the DO, so every call below opts in explicitly.)
  const onD1 = async (name: string, input: unknown) =>
    fetch(`${base}/rpc/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pramen-tenant": TENANT, "x-pramen-store": "d1", authorization: `Bearer ${admin}` },
      body: JSON.stringify(input),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as { ok?: boolean; result?: Record<string, unknown> } }));

  const d1Types = await onD1("listContentTypes", {});
  const d1Ct = (d1Types.body.result as unknown as Array<{ id: string; slug: string }>).find((c) => c.slug === "seeded_doc");
  assert(d1Ct !== undefined, "cms: the D1 store is bootstrapped with the seeded content type");
  const d1Page = await onD1("createPage", { typeId: d1Ct!.id, title: "D1 preview", slug: "d1-preview" });
  assert(d1Page.body.ok === true, `cms: a page can be created on the D1 store (${d1Page.status})`);
  const d1Mint = await onD1("signPagePreview", { pageId: (d1Page.body.result as { id: string }).id });
  assert(d1Mint.status === 200 && d1Mint.body.ok === true, `cms: signPagePreview mints on the D1 store (got ${d1Mint.status})`);
  // …and the link REDEEMS there. This is what used to be impossible: redemption goes
  // through callPrivileged, which only knew how to reach a Durable Object, so a D1-minted
  // link was undeliverable — which is why minting used to refuse outright.
  const d1Redeemed = await fetch(`${base}${(d1Mint.body.result as { url: string }).url}`, { headers: { "x-pramen-store": "d1" } });
  assert(d1Redeemed.status === 200, `cms: a preview link minted on D1 redeems on D1 (got ${d1Redeemed.status})`);

  // Bad input is a 400, not a 500 or a link that can never be redeemed.
  assert((await call("signPagePreview", { pageId: pageRow.id, expiresIn: "3600" }, admin)).status === 400, "cms: a non-numeric expiresIn is rejected");
  assert((await call("signPagePreview", {}, admin)).status === 400, "cms: a missing pageId is rejected");

  // Errors use pramen's standard { ok, error, code } shape.
  const denied = await (await fetch(`${base}/cms/preview?token=nonsense`)).json() as { error?: string; code?: string };
  assert(typeof denied.error === "string" && denied.code === "forbidden", "cms: a preview denial uses the standard error body shape");

  // An editor's own preview is flagged the same way a token redemption is.
  const editorPreview = await call("getPage", { slug, preview: true }, admin);
  assert(editorPreview.body.result.isPreview === true, "cms: getPage(preview) sets isPreview like the token route does");

  // a tampered token is refused — the signature covers the page id
  const [tokData, tokSig] = previewToken.split(".");
  const tampered = await fetch(`${base}/cms/preview?token=${encodeURIComponent(`${tokData}x.${tokSig}`)}`);
  assert(tampered.status === 403, "cms: a tampered preview token is refused (403)");
  const noToken = await fetch(`${base}/cms/preview`);
  assert(noToken.status === 403, "cms: a preview request with no token is refused (403)");

  // the /rpc back door stays shut: getPagePreview is role-gated, so knowing a page id
  // is not enough — only the signed route can reach a draft anonymously.
  const anonDirect = await call("getPagePreview", { pageId: pageRow.id });
  assert(anonDirect.status === 403, "cms: getPagePreview over /rpc is role-gated (403)");

  // --- publish: snapshots the assembled page; the public API now serves it ---
  const published = await call("publishPage", { pageId }, admin);
  assert(published.body.ok && published.body.result.page.status === "published", "cms: publishPage flips status to published");

  const pub = await call("getPage", { slug });
  assert(pub.body.ok, "cms: anonymous can read the published page");
  assert(pub.body.result.regions.hero[0].block_type === "hero", "cms: content API returns the hero block with its type slug");
  assert(pub.body.result.regions.hero[0].fields.heading === "About Us", "cms: hero block fields are present");
  assert(pub.body.result.regions.content.length === 2, "cms: published content region carries both rich_text blocks");
  assert(pub.body.result.page.status === "published", "cms: snapshot reports published status");
  assert(pub.body.result.page.contentType === "article", "cms: content API exposes the page's content-type slug");
  const pubList = await call("listPublishedPages", {});
  assert(
    pubList.body.ok && (pubList.body.result as Array<{ slug: string; contentType: string | null }>).some((p) => p.slug === slug && p.contentType === "article"),
    "cms: listPublishedPages carries the content-type slug for type-filtered collections",
  );
  // …and narrows BY THE SERVER. The result is capped, so a build filtering the answer would
  // be filtering an already-truncated list — with `collections: "auto"` generating one
  // collection per type, every one of them loses its own tail past the cap, build still green.
  const pubArticles = await call("listPublishedPages", { contentType: "article" });
  assert(
    pubArticles.body.ok && (pubArticles.body.result as Array<{ slug: string; contentType: string | null }>).every((p) => p.contentType === "article"),
    "cms: listPublishedPages({ contentType }) narrows server-side",
  );
  assert((pubArticles.body.result as unknown[]).length > 0, "cms: …and still finds the published article");
  assert(((await call("listPublishedPages", { contentType: "no-such-type" })).body.result as unknown[]).length === 0, "cms: an unknown type lists no published pages, not all of them");

  // --- reordering a region ---
  const placements = pub.body.result.regions.content.map((b: { id: string }) => b.id);
  const reordered = await call("reorderRegion", { pageId, region: "content", order: [placements[1], placements[0]] }, admin);
  assert(reordered.body.ok && reordered.body.result.count === 2, "cms: reorderRegion updates positions");

  // --- reusable block + per-placement override ---
  const shared = await call("addBlock", { pageId, blockTypeSlug: "rich_text", region: "content", fields: { body: rt("Shared CTA") }, isReusable: true }, admin);
  assert(shared.body.ok && shared.body.result.block.isReusable === true, "cms: a reusable block is created and placed");

  // Place the SAME block again with a per-placement override, then republish and confirm
  // the override merges over the block's base fields in the served snapshot.
  const reuseId = shared.body.result.block.id as string;
  const placed = await call("placeBlock", { pageId, blockId: reuseId, region: "content", overrides: { body: rt("Overridden CTA") } }, admin);
  assert(placed.body.ok, "cms: placeBlock reuses an existing block as a shared placement");
  await call("publishPage", { pageId }, admin);
  const pub2 = await call("getPage", { slug });
  const content2 = pub2.body.result.regions.content as Array<{ is_shared: boolean; fields: { body: unknown } }>;
  const bodyText = (b: { fields: { body: unknown } }) => JSON.stringify(b.fields.body ?? null);
  assert(content2.some((b) => bodyText(b).includes("Shared CTA")), "cms: the base reusable placement shows the block's own fields");
  assert(content2.some((b) => b.is_shared && bodyText(b).includes("Overridden CTA")), "cms: a shared placement's overrides merge over the block's fields");

  // --- optimistic concurrency: a stale expectedVersion is a 409, not a silent clobber ---
  const vPage = await call("createPage", { typeId: ct.body.result.id, title: "Concurrent", slug: "concurrent" }, admin);
  const vId = vPage.body.result.id as string;
  assert(vPage.body.result.version === 1, "cms: a new page starts at version 1");

  // Two editors both read version 1. The first save wins and bumps to 2.
  const firstSave = await call("updatePage", { pageId: vId, title: "Editor A", expectedVersion: 1 }, admin);
  assert(firstSave.body.ok && firstSave.body.result.page.version === 2, "cms: a matching expectedVersion saves and bumps the version");

  // The second still holds version 1 — previously this silently overwrote Editor A.
  const staleSave = await call("updatePage", { pageId: vId, title: "Editor B", expectedVersion: 1 }, admin);
  assert(staleSave.status === 409 && staleSave.body.code === "conflict", "cms: a stale expectedVersion is refused with 409 conflict");
  assert(/version 1.*current is 2/.test(String(staleSave.body.error ?? "")), "cms: the conflict names both versions so a client can explain itself");
  assert((await call("getPage", { slug: "concurrent", preview: true }, admin)).body.result.page.title === "Editor A", "cms: the losing write did not land");

  // Omitting expectedVersion keeps last-write-wins — this is opt-in, not a breaking change.
  const unguarded = await call("updatePage", { pageId: vId, title: "Editor C" }, admin);
  assert(unguarded.body.ok && unguarded.body.result.page.version === 3, "cms: omitting expectedVersion still saves, and still bumps");

  // The version has to be readable from the same call that loads the content, or a client
  // has nothing to echo back — the feature had no consumer without this.
  const vRead = await call("getPage", { slug: "concurrent", preview: true }, admin);
  assert(vRead.body.result.page.version === 3, "cms: getPage exposes the page version for a client to echo");

  // The PUBLIC path serves a snapshot baked at publish time, so its version must come from
  // the LIVE row — otherwise a client echoes a frozen number and 409s forever, and a
  // re-read hands back the same stale value.
  await call("publishPage", { pageId: vId }, admin);
  await call("updatePage", { pageId: vId, title: "After publish" }, admin);
  const vPublic = await call("getPage", { slug: "concurrent" });
  const vLive = (await call("getPage", { slug: "concurrent", preview: true }, admin)).body.result.page.version as number;
  assert(vPublic.body.result.page.version === vLive, `cms: the published snapshot reports the LIVE version (${vPublic.body.result.page.version} vs ${vLive})`);

  const badVersion = await call("updatePage", { pageId: vId, title: "x", expectedVersion: "2" }, admin);
  assert(badVersion.status === 400, "cms: a non-integer expectedVersion is a 400");

  // Blocks version independently of their page.
  const vBlock = await call("addBlock", { pageId: vId, blockTypeSlug: "rich_text", region: "content", fields: { body: rt("v") } }, admin);
  const vBlockId = vBlock.body.result.block.id as string;
  assert(vBlock.body.result.block.version === 1, "cms: a new block starts at version 1");
  await call("publishPage", { pageId: vId }, admin);
  const vBlocks = (await call("getPage", { slug: "concurrent", preview: true }, admin)).body.result.regions.content as Array<{ version: number }>;
  assert(vBlocks.every((b) => typeof b.version === "number"), "cms: every rendered block carries its version");
  assert((await call("updateBlock", { blockId: vBlockId, title: "B1", expectedVersion: 1 }, admin)).body.result.version === 2, "cms: updateBlock bumps the block version");
  assert((await call("updateBlock", { blockId: vBlockId, title: "B2", expectedVersion: 1 }, admin)).status === 409, "cms: a stale block expectedVersion is a 409");

  // updatePageSeo shares the page's version line — SEO and body edits conflict with each other.
  // Read the current version rather than hardcoding it, so adding a write above doesn't
  // silently retune these two.
  const seoVersion = (await call("getPage", { slug: "concurrent", preview: true }, admin)).body.result.page.version as number;
  assert((await call("updatePageSeo", { pageId: vId, metaTitle: "M", expectedVersion: seoVersion }, admin)).body.ok, "cms: updatePageSeo accepts a matching expectedVersion");
  assert((await call("updatePageSeo", { pageId: vId, metaTitle: "M2", expectedVersion: seoVersion }, admin)).status === 409, "cms: updatePageSeo shares the page version line");

  // --- media library: upload → attach to a block → resolved URL in the content API ---
  const imgType = await call("createBlockType", {
    name: "Image",
    slug: "image",
    fieldsSchema: [{ name: "image", type: "media", required: true }, { name: "caption", type: "text" }],
  }, admin);
  assert(imgType.body.ok, "cms: createBlockType(image) with a media field");

  const signed = await call("signMediaUpload", { contentType: "image/png", filename: "logo.png" }, admin);
  assert(signed.body.ok && typeof signed.body.result.url === "string", "cms: signMediaUpload returns a signed url + ref");

  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]); // PNG magic + a few bytes
  const put = await fetch(`${base}${signed.body.result.url}`, { method: "PUT", headers: { "content-type": "image/png" }, body: bytes });
  assert(put.status === 200, "cms: uploading media bytes to the signed url succeeds");

  const media = await call("createMedia", { ref: signed.body.result.ref, alt: "Our logo" }, admin);
  assert(media.body.ok && typeof media.body.result.id === "string", "cms: createMedia persists a cms_media row");
  const mediaId = media.body.result.id as string;
  const mediaKey = signed.body.result.ref.key as string;

  // The library is PAGED, so sorting and filtering have to happen in SQL — which they can only
  // do against real columns, because `file` is a fileRef (JSON in a TEXT cell) and `orderBy`
  // cannot see inside it. These assert the projection actually lands on the row.
  const listed = await call("listMedia", { limit: 50 }, admin);
  const row = (listed.body.result as Array<{ id: string; filename?: string; contentType?: string; size?: number }>).find((m) => m.id === mediaId);
  assert(row?.filename === "logo.png", "cms: createMedia projects filename onto a queryable column");
  assert(row?.contentType === "image/png", "cms: …and contentType");
  assert(row?.size === bytes.length, "cms: …and size, from the STORED blob rather than the client's claim");

  const images = await call("listMedia", { limit: 50, kind: "image" }, admin);
  assert(
    (images.body.result as Array<{ id: string }>).some((m) => m.id === mediaId),
    "cms: listMedia(kind: image) matches an image/* row",
  );
  const docs = await call("listMedia", { limit: 50, kind: "document" }, admin);
  assert(
    !(docs.body.result as Array<{ id: string }>).some((m) => m.id === mediaId),
    "cms: …and kind: document does not",
  );
  // A sort this build does not know must degrade to the default order, not 400: a bookmark
  // outliving a rename should show the library.
  const bogus = await call("listMedia", { limit: 1, sort: "'; DROP TABLE cms_media --" }, admin);
  assert(bogus.body.ok === true, "cms: an unknown sort falls back instead of erroring");
  const named = await call("listMedia", { limit: 50, sort: "name" }, admin);
  assert(named.body.ok === true, "cms: listMedia sorts by name");

  const found = await call("listMedia", { limit: 50, q: "LOGO" }, admin);
  assert(
    (found.body.result as Array<{ id: string }>).some((m) => m.id === mediaId),
    "cms: listMedia(q) matches a filename case-insensitively",
  );
  const byAlt = await call("listMedia", { limit: 50, q: "Our logo" }, admin);
  assert(
    (byAlt.body.result as Array<{ id: string }>).some((m) => m.id === mediaId),
    "cms: …and matches the alt text, the only human description a media row carries",
  );
  const narrowed = await call("listMedia", { limit: 50, q: "logo", kind: "document" }, admin);
  assert(
    !(narrowed.body.result as Array<{ id: string }>).some((m) => m.id === mediaId),
    "cms: a search inside a type filter is ANDed, not ORed",
  );
  // The needle goes into a LIKE pattern, so its wildcards must be literal — otherwise "%"
  // matches the entire library and a filename is unsearchable the moment it contains one.
  const wild = await call("listMedia", { limit: 50, q: "%" }, admin);
  assert(
    !(wild.body.result as Array<{ id: string }>).some((m) => m.id === mediaId),
    "cms: a LIKE wildcard in the needle is escaped to a literal",
  );

  const imgPage = await call("createPage", { typeId: ct.body.result.id, title: "Logo Page", slug: "logo-page" }, admin);
  await call("addBlock", { pageId: imgPage.body.result.id, blockTypeSlug: "image", region: "content", fields: { image: mediaId, caption: "Hi" } }, admin);
  await call("publishPage", { pageId: imgPage.body.result.id }, admin);

  const logo = await call("getPage", { slug: "logo-page" });
  const imgBlock = (logo.body.result.regions.content as Array<{ block_type: string; fields: { image?: { url?: string; alt?: string } } }>).find((b) => b.block_type === "image");
  assert(!!imgBlock && imgBlock.fields.image?.url === `/media/${mediaKey}`, "cms: a media field resolves to a servable /media URL in the snapshot");
  assert(imgBlock?.fields.image?.alt === "Our logo", "cms: resolved media carries its alt text");

  // --- date / datetime field types ---
  const evType = await call("createBlockType", {
    name: "Event",
    slug: "event",
    fieldsSchema: [{ name: "day", type: "date", required: true }, { name: "startsAt", type: "datetime" }],
  }, admin);
  assert(evType.body.ok, "cms: createBlockType(event) with date + datetime fields");
  const evPage = await call("createPage", { typeId: ct.body.result.id, title: "Gala", slug: "gala" }, admin);
  const evOk = await call("addBlock", { pageId: evPage.body.result.id, blockTypeSlug: "event", region: "content", fields: { day: "2026-09-01", startsAt: "2026-09-01T19:30" } }, admin);
  assert(evOk.body.ok, "cms: a valid date + datetime block is accepted");
  const evBadDate = await call("addBlock", { pageId: evPage.body.result.id, blockTypeSlug: "event", region: "content", fields: { day: "01/09/2026" } }, admin);
  assert(evBadDate.status === 400, "cms: a malformed date (not YYYY-MM-DD) is rejected");
  const evBadDt = await call("addBlock", { pageId: evPage.body.result.id, blockTypeSlug: "event", region: "content", fields: { day: "2026-09-01", startsAt: "not-a-time" } }, admin);
  assert(evBadDt.status === 400, "cms: a malformed datetime is rejected");
  await call("publishPage", { pageId: evPage.body.result.id }, admin);
  const gala = await call("getPage", { slug: "gala" });
  const evBlock = (gala.body.result.regions.content as Array<{ block_type: string; fields: { day?: string; startsAt?: string } }>).find((b) => b.block_type === "event");
  assert(evBlock?.fields.day === "2026-09-01" && evBlock?.fields.startsAt === "2026-09-01T19:30", "cms: date/datetime values round-trip through the content API");

  // --- richtext is a structural allow-list on write (a caller can bypass the editor) ---
  const xssPage = await call("createPage", { typeId: ct.body.result.id, title: "XSS", slug: "xss" }, admin);

  // A legacy HTML string is no longer a rich-text value at all — rejected, not scrubbed.
  const asHtml = await call("addBlock", { pageId: xssPage.body.result.id, blockTypeSlug: "rich_text", region: "content", fields: { body: "<p>hi</p>" } }, admin);
  assert(asHtml.status === 400 && asHtml.body.ok === false, "cms: an HTML string in a richtext field is rejected (400)");

  // A hostile DOCUMENT is accepted and normalized: unknown node types and marks are
  // dropped, a javascript: link loses its mark, and the legitimate markup survives.
  const dirty = {
    type: "doc",
    content: [
      { type: "paragraph", content: [
        { type: "text", text: "hi " },
        { type: "text", text: "there", marks: [{ type: "bold" }, { type: "onclick", attrs: { handler: "alert(1)" } }] },
        { type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(2)" } }] },
      ] },
      { type: "script", content: [{ type: "text", text: "alert(3)" }] },
      { type: "image", attrs: { src: "x", onerror: "alert(4)" } },
    ],
  };
  const addDirty = await call("addBlock", { pageId: xssPage.body.result.id, blockTypeSlug: "rich_text", region: "content", fields: { body: dirty } }, admin);
  assert(addDirty.body.ok, "cms: addBlock with a hostile richtext document is accepted (then normalized)");
  await call("publishPage", { pageId: xssPage.body.result.id }, admin);
  const xssGot = await call("getPage", { slug: "xss" });
  const rtBody = (xssGot.body.result.regions.content as Array<{ block_type: string; fields: { body?: unknown } }>).find((b) => b.block_type === "rich_text")?.fields.body;
  const rtJson = JSON.stringify(rtBody ?? {});
  assert(!/"script"|"image"/.test(rtJson), "cms: richtext normalized on write — unknown node types dropped");
  assert(!/onclick|onerror|alert\(/.test(rtJson), "cms: richtext normalized on write — unknown marks + smuggled attrs dropped");
  assert(!/javascript:/i.test(rtJson), "cms: richtext normalized on write — javascript: link mark dropped");
  assert(/"bold"/.test(rtJson) && /"there"/.test(rtJson), "cms: richtext normalization preserves allow-listed marks and text");

  // --- `pramen cms types`: codegen from the LIVE tenant's block types ---
  // Block types are data (rows a webmaster adds with no deploy), so the only way to type
  // them is to read them back out of a running instance. Run the real CLI against this one.
  const genDir = mkdtempSync(join(tmpdir(), "pramen-cms-types-"));
  const genPath = join(genDir, "cms.gen.ts");
  const cli = Bun.spawnSync(
    ["bun", "packages/cms/src/cli.ts", "types", "--url", base, "--tenant", TENANT, "--token", admin, "--out", genPath],
    { cwd: join(import.meta.dir, "..", "..") },
  );
  assert(cli.exitCode === 0, `cms: \`pramen-cms types\` exits 0 (${cli.stderr.toString()})`);
  const generated = readFileSync(genPath, "utf8");
  assert(generated.includes("export interface RichTextFields"), "cms: codegen emits an interface per block-type slug");
  assert(/"body"\??: RichText;/.test(generated), "cms: codegen maps a richtext field to the RichText type");
  assert(generated.includes('"rich_text": RichTextFields;'), "cms: codegen emits the BlockFieldsBySlug registry");
  rmSync(genDir, { recursive: true, force: true });

  // --- trash: soft delete hides a page everywhere, restore brings it back ---
  const trashPage = await call("createPage", { typeId: ct.body.result.id, title: "Doomed", slug: "doomed" }, admin);
  const trashId = trashPage.body.result.id as string;
  await call("publishPage", { pageId: trashId }, admin);
  assert((await call("getPage", { slug: "doomed" })).body.ok, "cms: the page is publicly readable before deletion");

  const trashDel = await call("deletePage", { pageId: trashId }, admin);
  assert(trashDel.body.ok, "cms: deletePage trashes the page");
  // The ACL read scope hides it — for anonymous AND for the editor, without either handler
  // filtering. A published page that was trashed must stop being served.
  assert((await call("getPage", { slug: "doomed" })).status === 404, "cms: a trashed page is gone from the public content API");
  assert((await call("getPage", { slug: "doomed", preview: true }, admin)).status === 404, "cms: a trashed page is hidden from the editor too");
  const afterTrashPages = (await call("listPages", {}, admin)).body.result as Array<{ id: string }>;
  assert(!afterTrashPages.some((p) => p.id === trashId), "cms: a trashed page drops out of listPages");
  const afterTrashPublished = (await call("listPublishedPages", {})).body.result as Array<{ slug: string }>;
  assert(!afterTrashPublished.some((p) => p.slug === "doomed"), "cms: a trashed page drops out of listPublishedPages (and the sitemap)");

  const trash = (await call("listTrash", {}, admin)).body.result as { pages: Array<{ id: string }>; media: Array<{ id: string }> };
  assert(trash.pages.some((p) => p.id === trashId), "cms: listTrash shows the trashed page");

  // The slug is still held while trashed — a DB unique constraint, so say so plainly.
  const slugClash = await call("createPage", { typeId: ct.body.result.id, title: "Reuse", slug: "doomed" }, admin);
  assert(slugClash.status === 400 && /trash/i.test(String(slugClash.body.error ?? "")), "cms: reusing a trashed page's slug fails with a message naming the trash");

  const restored = await call("restorePage", { pageId: trashId }, admin);
  assert(restored.body.ok, "cms: restorePage brings it back");
  assert((await call("getPage", { slug: "doomed" })).body.ok, "cms: a restored page is publicly readable again");

  // A scheduled publish must NOT resurrect a trashed page. The publish task runs on the
  // SYSTEM context, where the ACL is bypassed — so the read scope does not protect it and
  // deletePage has to clear the schedule itself.
  const schedPage = await call("createPage", { typeId: ct.body.result.id, title: "Scheduled", slug: "sched-doomed" }, admin);
  const schedId = schedPage.body.result.id as string;
  await call("schedulePage", { pageId: schedId, publishAt: Date.now() + 800 }, admin);
  await call("deletePage", { pageId: schedId }, admin);
  await new Promise((r) => setTimeout(r, 1200));
  await drain(base, admin);
  assert((await call("getPage", { slug: "sched-doomed" })).status === 404, "cms: a scheduled publish does not resurrect a trashed page");
  const stillTrashed = (await call("listTrash", {}, admin)).body.result as { pages: Array<{ id: string; status: string }> };
  const schedRow = stillTrashed.pages.find((p) => p.id === schedId);
  assert(schedRow !== undefined, "cms: the trashed page stays trashed through its scheduled time");
  // THIS is the assertion that tests the fix. The two above pass either way: `getPage`
  // 404s on `deletedAt IS NOT NULL` regardless of status, and trash membership is keyed on
  // deletedAt, which publishing never touches. Only `status` shows whether the SYSTEM-context
  // task actually published it — the one property the ACL read scope cannot cover.
  assert(schedRow!.status !== "published", `cms: the scheduled task did not publish the trashed page (status=${schedRow!.status})`);

  // A trashed translation still blocks its locale — the guard reads raw, not through the
  // ACL, or restoring the first would leave two live pages for one locale in a group.
  const trGroup = await call("createPage", { typeId: ct.body.result.id, title: "TrSrc", slug: "tr-src" }, admin);
  await call("createTranslation", { pageId: trGroup.body.result.id, locale: "de", slug: "tr-de" }, admin);
  const trList = (await call("listTranslations", { pageId: trGroup.body.result.id }, admin)).body.result as Array<{ id: string; locale: string }>;
  const deId = trList.find((t) => t.locale === "de")!.id;
  await call("deletePage", { pageId: deId }, admin);
  const dupTr = await call("createTranslation", { pageId: trGroup.body.result.id, locale: "de", slug: "tr-de-2" }, admin);
  assert(dupTr.status === 400 && /trash/i.test(String(dupTr.body.error ?? "")), "cms: a trashed translation still holds its locale");

  // Purge is irreversible and refuses a LIVE page — trash it first.
  assert((await call("purgePage", { pageId: trashId }, admin)).status === 404, "cms: purging a live page is refused");
  await call("deletePage", { pageId: trashId }, admin);
  assert((await call("purgePage", { pageId: trashId }, admin)).body.ok, "cms: purgePage removes a trashed page for good");
  assert((await call("listTrash", {}, admin)).body.result.pages.every((p: { id: string }) => p.id !== trashId), "cms: a purged page leaves the trash");
  // Its slug is free again now that the row is gone.
  const reuse = await call("createPage", { typeId: ct.body.result.id, title: "Reuse", slug: "doomed" }, admin);
  assert(reuse.body.ok, "cms: purging frees the slug");

  const served = await fetch(`${base}/media/${mediaKey}`);
  assert(served.status === 200 && served.headers.get("content-type") === "image/png", "cms: the public /media route serves the blob (no auth)");

  const badMedia = await fetch(`${base}/media/main/nope/xyz`);
  assert(badMedia.status === 404, "cms: the /media route refuses non-media keys");

  const altUp = await call("updateMedia", { id: mediaId, alt: "Updated alt" }, admin);
  assert(altUp.body.ok && altUp.body.result.alt === "Updated alt", "cms: updateMedia edits alt text");
  const altRead = await call("getMedia", { id: mediaId }, admin);
  assert(altRead.body.result.alt === "Updated alt", "cms: the new alt text persists");

  const del = await call("deleteMedia", { id: mediaId }, admin);
  assert(del.body.ok, "cms: deleteMedia trashes the media row");
  // getMedia returns null (not 404) for an unreadable row — the read scope simply
  // yields nothing, which is what "hidden" means here.
  assert((await call("getMedia", { id: mediaId }, admin)).body.result === null, "cms: trashed media is hidden by the read scope");
  // The BLOB survives a soft delete on purpose — dropping the bytes here would make
  // restoreMedia a lie, and a block still holding the id would render a dead url.
  assert((await fetch(`${base}/media/${mediaKey}`)).status === 200, "cms: the R2 object survives deleteMedia");

  // Trashed media MUST be discoverable, or restore/purge can never be called again —
  // every other read of it is ACL-scoped, while /media/<key> keeps serving the bytes.
  const mediaTrash = (await call("listTrash", {}, admin)).body.result as { media: Array<{ id: string }> };
  assert(mediaTrash.media.some((m) => m.id === mediaId), "cms: listTrash surfaces trashed media, so purge/restore stay reachable");

  assert((await call("restoreMedia", { id: mediaId }, admin)).body.ok, "cms: restoreMedia brings the row back");
  assert((await call("getMedia", { id: mediaId }, admin)).body.result !== null, "cms: restored media is readable again");

  await call("deleteMedia", { id: mediaId }, admin);
  assert((await call("purgeMedia", { id: mediaId }, admin)).body.ok, "cms: purgeMedia removes the row for good");
  const gone = await fetch(`${base}/media/${mediaKey}`);
  assert(gone.status === 404, "cms: the blob is gone after purgeMedia");

  // --- SEO: meta fields, og:image resolution, sitemap.xml, robots.txt ---
  const seoUp = await call("signMediaUpload", { contentType: "image/png" }, admin);
  await fetch(`${base}${seoUp.body.result.url}`, { method: "PUT", headers: { "content-type": "image/png" }, body: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) });
  const seoMedia = await call("createMedia", { ref: seoUp.body.result.ref }, admin);
  const seoPage = await call("createPage", { typeId: ct.body.result.id, title: "SEO Page", slug: "seo-page" }, admin);
  const seoId = seoPage.body.result.id as string;
  await call("addBlock", { pageId: seoId, blockTypeSlug: "rich_text", region: "content", fields: { body: rt("x") } }, admin);
  const seoSet = await call("updatePageSeo", { pageId: seoId, metaTitle: "My Meta Title", canonicalUrl: "https://example.com/seo", robots: "noindex", ogImage: seoMedia.body.result.id, structuredData: { "@type": "WebPage" } }, admin);
  assert(seoSet.body.ok, "cms: updatePageSeo sets SEO fields");
  await call("publishPage", { pageId: seoId }, admin);
  const seoGet = await call("getPage", { slug: "seo-page" });
  const seo = seoGet.body.result.page.seo as { metaTitle: string; robots: string; ogImage: { url: string } | null; structuredData: { "@type"?: string } | null };
  assert(seo.metaTitle === "My Meta Title", "cms: getPage exposes seo.metaTitle");
  assert(seo.robots === "noindex", "cms: getPage exposes seo.robots");
  assert(seo.ogImage?.url === `/media/${seoUp.body.result.ref.key}`, "cms: og:image resolves to a servable URL");
  assert(seo.structuredData?.["@type"] === "WebPage", "cms: getPage exposes structuredData (JSON-LD)");

  const sitemap = await fetch(`${base}/sitemap.xml`);
  const sitemapBody = await sitemap.text();
  assert(sitemap.status === 200 && sitemapBody.includes("<urlset") && sitemapBody.includes("/seo-page"), "cms: /sitemap.xml lists published pages");
  const robots = await fetch(`${base}/robots.txt`);
  assert(robots.status === 200 && (await robots.text()).includes("Sitemap:"), "cms: /robots.txt points at the sitemap");

  // --- editorial workflow: submit → review → approve/reject, with audit + RBAC ---
  const editorTok = await token("cms-editor", ["editor"]);
  const wfPage = await call("createPage", { typeId: ct.body.result.id, title: "Policy", slug: "policy" }, admin);
  const wfId = wfPage.body.result.id as string;
  await call("addBlock", { pageId: wfId, blockTypeSlug: "rich_text", region: "content", fields: { body: rt("Draft") } }, admin);
  // an editor can submit for review
  const submit = await call("submitForReview", { pageId: wfId, note: "please review" }, editorTok);
  assert(submit.body.ok && submit.body.result.page.status === "review", "cms: submitForReview moves a draft to review");
  // an editor (non-reviewer) cannot approve
  const editorApprove = await call("approve", { pageId: wfId }, editorTok);
  assert(editorApprove.status === 403, "cms: an editor cannot approve (reviewer-gated, 403)");
  // ...nor bypass review by publishing/scheduling directly (both reviewer-gated)
  const editorPublish = await call("publishPage", { pageId: wfId }, editorTok);
  assert(editorPublish.status === 403, "cms: an editor cannot publish directly (no review bypass, 403)");
  const editorSchedule = await call("schedulePage", { pageId: wfId, publishAt: Date.now() + 1000 }, editorTok);
  assert(editorSchedule.status === 403, "cms: an editor cannot schedule a publish (reviewer-gated, 403)");
  // reject sends it back
  const reject = await call("reject", { pageId: wfId, note: "needs work" }, admin);
  assert(reject.body.ok && reject.body.result.page.status === "rejected", "cms: reject moves review → rejected");
  // approve only works from review — a rejected page must be resubmitted
  const approveRejected = await call("approve", { pageId: wfId }, admin);
  assert(approveRejected.status === 400, "cms: approve only works from the review state (400)");
  // resubmit → approve (publishes)
  await call("submitForReview", { pageId: wfId }, editorTok);
  const approve = await call("approve", { pageId: wfId, note: "lgtm" }, admin);
  assert(approve.body.ok && approve.body.result.page.status === "published", "cms: approve publishes a page in review");
  const wfPublic = await call("getPage", { slug: "policy" });
  assert(wfPublic.body.ok && (wfPublic.body.result.regions.content as unknown[]).length === 1, "cms: an approved page is publicly readable");
  // the audit trail records every transition with actors
  const audit = await call("listPageAudit", { pageId: wfId }, admin);
  const actions = (audit.body.result as Array<{ action: string; actor: string | null }>).map((a) => a.action);
  assert(actions.includes("submit") && actions.includes("reject") && actions.includes("approve"), "cms: the audit trail records submit/reject/approve");
  assert((audit.body.result as Array<{ action: string; actor: string | null }>).some((a) => a.action === "submit" && a.actor === "cms-editor"), "cms: audit captures the actor (identity.userId)");

  // reviewer RBAC: a pure reviewer (not editor/admin) can VIEW a draft (preview + content
  // type) to review it, then approve — but cannot edit.
  const reviewerTok = await token("cms-reviewer", ["reviewer"]);
  const revPage = await call("createPage", { typeId: ct.body.result.id, title: "Review Me", slug: "review-me" }, admin);
  const revPageId = revPage.body.result.id as string;
  await call("addBlock", { pageId: revPageId, blockTypeSlug: "rich_text", region: "content", fields: { body: rt("r") } }, admin);
  await call("submitForReview", { pageId: revPageId }, admin);
  const revPreview = await call("getPage", { slug: "review-me", preview: true }, reviewerTok);
  assert(revPreview.body.ok && (revPreview.body.result.regions.content as unknown[]).length === 1, "cms: a reviewer can preview a draft page before approving");
  assert((await call("getContentType", { id: ct.body.result.id }, reviewerTok)).body.ok, "cms: a reviewer can load the content type");
  const revEdit = await call("addBlock", { pageId: revPageId, blockTypeSlug: "rich_text", region: "content", fields: { body: rt("no") } }, reviewerTok);
  assert(revEdit.status === 403, "cms: a reviewer cannot edit (writes stay editor-gated, 403)");
  const revApprove = await call("approve", { pageId: revPageId }, reviewerTok);
  assert(revApprove.body.ok && revApprove.body.result.page.status === "published", "cms: a reviewer can approve");

  // --- i18n: translations, per-locale slug uniqueness, locale-aware content API ---
  const enPage = await call("createPage", { typeId: ct.body.result.id, title: "Contact", slug: "contact" }, admin);
  const enId = enPage.body.result.id as string;
  assert(enPage.body.result.locale === "en", "cms: createPage defaults to the 'en' locale");
  const cs = await call("createTranslation", { pageId: enId, locale: "cs", title: "Kontakt" }, admin);
  assert(cs.body.ok && cs.body.result.locale === "cs" && cs.body.result.slug === "contact", "cms: createTranslation shares the slug in a new locale");
  assert(cs.body.result.translationGroupId === enPage.body.result.translationGroupId, "cms: a translation shares the source's translationGroupId");
  const dupe = await call("createPage", { typeId: ct.body.result.id, title: "Dup", slug: "contact", locale: "en" }, admin);
  assert(dupe.status === 400 && dupe.body.ok === false, "cms: a duplicate (slug, locale) is rejected (400)");
  const trans = await call("listTranslations", { pageId: enId }, admin);
  assert(Array.isArray(trans.body.result) && trans.body.result.length === 2, "cms: listTranslations returns all locales of the group");
  await call("addBlock", { pageId: enId, blockTypeSlug: "rich_text", region: "content", fields: { body: rt("EN") } }, admin);
  await call("addBlock", { pageId: cs.body.result.id, blockTypeSlug: "rich_text", region: "content", fields: { body: rt("CS") } }, admin);
  await call("publishPage", { pageId: enId }, admin);
  await call("publishPage", { pageId: cs.body.result.id }, admin);
  const getEn = await call("getPage", { slug: "contact", locale: "en" });
  assert(JSON.stringify((getEn.body.result.regions.content as Array<{ fields: { body: unknown } }>)[0].fields.body).includes("EN"), "cms: getPage(locale=en) returns the English page");
  const getCs = await call("getPage", { slug: "contact", locale: "cs" });
  assert(JSON.stringify((getCs.body.result.regions.content as Array<{ fields: { body: unknown } }>)[0].fields.body).includes("CS"), "cms: getPage(locale=cs) returns the Czech page");
  assert((getEn.body.result.page.translations as Array<{ locale: string; slug: string }>).some((t) => t.locale === "cs" && t.slug === "contact"), "cms: the content API lists sibling translations (hreflang), computed live");
  const locales = await call("listLocales", {}, admin);
  assert((locales.body.result as string[]).includes("en") && (locales.body.result as string[]).includes("cs"), "cms: listLocales returns the distinct locales");

  // --- reorderRegion must cover the region exactly (partial list rejected) ---
  const contentPlacements = pub2.body.result.regions.content as Array<{ id: string }>;
  const partial = await call("reorderRegion", { pageId, region: "content", order: [contentPlacements[0].id] }, admin);
  assert(partial.status === 400 && partial.body.ok === false, "cms: reorderRegion rejects a partial order list (400)");

  // --- removeBlock removes a placement ---
  const rm = await call("removeBlock", { pageBlockId: contentPlacements[0].id }, admin);
  assert(rm.body.ok, "cms: removeBlock removes a placement");
  const afterRm = await call("getPage", { slug, preview: true }, admin);
  assert((afterRm.body.result.regions.content as unknown[]).length === contentPlacements.length - 1, "cms: the removed placement is gone from the page");

  // --- a default block that can never be scaffolded is refused AT DECLARATION ---
  // The editor authors content types now (GitHub #9), so a `defaultBlocks` entry naming a
  // region the type does not declare, or a block type that region does not allow, is a
  // mistake the person making it can still see. Silently skipping it at createPage time
  // instead left a scaffold that simply never appeared, with nothing anywhere saying why.
  const badRegion = await call("createContentType", {
    name: "Bad region",
    slug: "bad-region",
    regions: [{ name: "hero", allowedTypes: ["hero"] }],
    defaultBlocks: [{ region: "nowhere", blockTypeSlug: "hero" }],
  }, admin);
  assert(badRegion.status === 400 && badRegion.body.ok === false, "cms: a defaultBlock into an undeclared region is refused (400)");

  const badAllowed = await call("createContentType", {
    name: "Bad allowed",
    slug: "bad-allowed",
    regions: [{ name: "hero", allowedTypes: ["hero"] }],
    defaultBlocks: [{ region: "hero", blockTypeSlug: "rich_text", fields: { body: rt("x") } }],
  }, admin);
  assert(badAllowed.status === 400 && badAllowed.body.ok === false, "cms: a defaultBlock the region does not allow is refused (400)");

  // --- …and createPage STILL skips one that became invalid later ---
  // Declaration-time validation cannot cover this: the region's allow-list is narrowed by a
  // later `updateContentType` that patches `regions` alone, leaving a stored default block
  // that was legal when it was written. `createPage` must skip it rather than 500, so the
  // runtime guard stays whether or not the declaration was checked.
  const showcaseCt = await call("createContentType", {
    name: "Showcase",
    slug: "showcase",
    regions: [{ name: "hero", allowedTypes: ["hero", "rich_text"] }],
    defaultBlocks: [{ region: "hero", blockTypeSlug: "rich_text", fields: { body: rt("x") } }],
  }, admin);
  assert(showcaseCt.body.ok, "cms: a legal defaultBlock is accepted");
  const narrowed = await call("updateContentType", { slug: "showcase", regions: [{ name: "hero", allowedTypes: ["hero"] }] }, admin);
  assert(narrowed.body.ok, "cms: narrowing a region's allow-list does not require rewriting defaultBlocks");
  const showcasePage = await call("createPage", { typeId: showcaseCt.body.result.id, title: "Showcase", slug: "showcase-1" }, admin);
  assert(showcasePage.body.ok, "cms: createPage succeeds despite a default block that is now invalid");
  const showcasePreview = await call("getPage", { slug: "showcase-1", preview: true }, admin);
  assert(((showcasePreview.body.result.regions.hero as unknown[] | undefined) ?? []).length === 0, "cms: a now-disallowed default block is skipped, not scaffolded");

  // --- scheduling: input validation ---
  const badOrder = await call("schedulePage", { pageId, publishAt: Date.now() + 1000, unpublishAt: Date.now() + 500 }, admin);
  assert(badOrder.status === 400 && badOrder.body.ok === false, "cms: schedulePage rejects unpublishAt <= publishAt (400)");

  // --- scheduled publish, end-to-end via a drain (intent-validated outbox task) ---
  const launch = await call("createPage", { typeId: ct.body.result.id, title: "Launch", slug: "launch" }, admin);
  const launchId = launch.body.result.id as string;
  await call("addBlock", { pageId: launchId, blockTypeSlug: "rich_text", region: "content", fields: { body: rt("Launch!") } }, admin);
  await call("schedulePage", { pageId: launchId, publishAt: Date.now() }, admin);
  const beforeDrain = await call("getPage", { slug: "launch" });
  assert(beforeDrain.status === 404, "cms: a scheduled page is not public until the task drains");
  await drain(base, admin);
  const afterDrain = await call("getPage", { slug: "launch" });
  assert(afterDrain.body.ok && (afterDrain.body.result.regions.content as unknown[]).length === 1, "cms: after drain, the scheduled page is published with its block");

  // --- scheduling intent: a manual unpublish cancels a pending scheduled publish ---
  const canc = await call("createPage", { typeId: ct.body.result.id, title: "Cancelled", slug: "cancelled" }, admin);
  const cancId = canc.body.result.id as string;
  await call("schedulePage", { pageId: cancId, publishAt: Date.now() }, admin);
  await call("unpublishPage", { pageId: cancId }, admin); // clears the schedule token
  await drain(base, admin);
  const cancelled = await call("getPage", { slug: "cancelled" });
  assert(cancelled.status === 404, "cms: a schedule cancelled by unpublishPage does not publish after drain");

  // --- schedulePage still enqueues a future task (the original assertion) ---
  const draft2 = await call("createPage", { typeId: ct.body.result.id, title: "Roadmap", slug: "roadmap" }, admin);
  const scheduled = await call("schedulePage", { pageId: draft2.body.result.id, publishAt: Date.now() + 60_000 }, admin);
  assert(scheduled.body.ok && typeof scheduled.body.result.publishInMs === "number", "cms: schedulePage enqueues a delayed publish task");

  // --- updatePage: edit the page record itself (title / slug / page-level fields) ---
  const lecture = await call("createPage", { typeId: ct.body.result.id, title: "Intro Lecture", slug: "intro-lecture" }, admin);
  const lecId = lecture.body.result.id as string;
  const editTitle = await call("updatePage", { pageId: lecId, title: "Intro to CS", fields: { date: "2026-09-01" } }, admin);
  assert(editTitle.body.ok && editTitle.body.result.page.title === "Intro to CS", "cms: updatePage edits the title");
  const afterEdit = await call("getPage", { slug: "intro-lecture", preview: true }, admin);
  assert(afterEdit.body.result.page.title === "Intro to CS", "cms: the title edit persists");
  assert(afterEdit.body.result.page.fields?.date === "2026-09-01", "cms: updatePage sets a content-type-level field");
  // slug change: reachable at the new slug, gone from the old
  await call("updatePage", { pageId: lecId, slug: "intro-to-cs" }, admin);
  assert((await call("getPage", { slug: "intro-lecture", preview: true }, admin)).status === 404, "cms: the page leaves its old slug");
  assert((await call("getPage", { slug: "intro-to-cs", preview: true }, admin)).body.ok, "cms: the page is reachable at its new slug");
  // (slug, locale) uniqueness: taking another page's slug is rejected
  const conflict = await call("updatePage", { pageId: lecId, slug: "roadmap" }, admin);
  assert(conflict.status === 400 || conflict.status === 409, "cms: updatePage rejects a duplicate (slug, locale)");
  // unknown page -> 404; anonymous -> 403
  assert((await call("updatePage", { pageId: "00000000-0000-0000-0000-000000000000", title: "x" }, admin)).status === 404, "cms: updatePage on an unknown page is a 404");
  assert((await call("updatePage", { pageId: lecId, title: "x" })).status === 403, "cms: updatePage requires editor auth (403)");

  // --- collections: edit an arbitrary entity (`lectures`) through the generic handlers ---
  // The example registers `collection("lectures", …)`; exercise the full CRUD over a real DO.
  const cols = await call("listCollections", {}, admin);
  assert(
    cols.body.ok && (cols.body.result as Array<{ slug: string; idField: string }>).some((c) => c.slug === "lectures" && c.idField === "id"),
    "cms: listCollections returns the registered `lectures` collection with its idField",
  );
  assert((await call("listCollections", {})).status === 403, "cms: listCollections requires editor auth (403)");

  const madeLecture = await call("collectionCreate", { collection: "lectures", values: { title: "Reactive Backends", speaker: "Ada", date: "2026-05-01" } }, admin);
  assert(madeLecture.body.ok && typeof madeLecture.body.result.id === "string", "cms: collectionCreate inserts a row and echoes its id");
  const lecRowId = madeLecture.body.result.id as string;

  // Write whitelist: an undeclared column in the payload is ignored, not persisted.
  const withBogus = await call("collectionCreate", { collection: "lectures", values: { title: "Whitelisted", bogus: "x", createdAt: "hacked" } }, admin);
  assert(withBogus.body.ok && withBogus.body.result.bogus === undefined, "cms: collectionCreate whitelists to declared fields (undeclared column dropped)");

  const gotLecture = await call("collectionGet", { collection: "lectures", id: lecRowId }, admin);
  assert(gotLecture.body.ok && gotLecture.body.result.title === "Reactive Backends", "cms: collectionGet returns the row by id");

  // A `richtext` collection field maps to a t.json() column. Writing a document into a
  // TEXT column bound the object raw and DO SQLite rejected the parameter — the whole
  // path was untested because every fixture set only scalar fields.
  const richLecture = await call("collectionCreate", {
    collection: "lectures",
    values: { title: "With prose", speaker: "S", date: "2026-01-01", abstract: rt("An abstract with real prose.") },
  }, admin);
  assert(richLecture.body.ok, `cms: a collection row with a richtext field saves (${richLecture.body.error ?? ""})`);
  const richBack = await call("collectionGet", { collection: "lectures", id: richLecture.body.result.id }, admin);
  assert(JSON.stringify(richBack.body.result?.abstract ?? {}).includes("real prose"), "cms: the richtext document round-trips through the collection column");

  const listed = await call("collectionList", { collection: "lectures" }, admin);
  assert(listed.body.ok && Array.isArray(listed.body.result) && listed.body.result.length >= 2, "cms: collectionList returns the rows");

  const editedLecture = await call("collectionUpdate", { collection: "lectures", id: lecRowId, values: { title: "Reactive Backends on CF" } }, admin);
  assert(editedLecture.body.ok && editedLecture.body.result.title === "Reactive Backends on CF", "cms: collectionUpdate patches the row");

  // Field validation rejects a bad type before the write.
  const badDate = await call("collectionCreate", { collection: "lectures", values: { title: "Bad", date: "nope" } }, admin);
  assert(badDate.status === 400, "cms: collectionCreate validates field types (bad date -> 400)");

  // An unknown collection slug is a clean 400, never a raw table reference.
  const unknownCol = await call("collectionList", { collection: "sqlite_master" }, admin);
  assert(unknownCol.status === 400, "cms: an unknown collection slug is a 400");

  // Auth: anonymous cannot touch collections.
  assert((await call("collectionList", { collection: "lectures" })).status === 403, "cms: collections require editor auth (403)");

  // --- collection workflow features (`supports`) over a real DO -------------------------
  // The example's `lectures` collection opts into all four. What matters end-to-end is that
  // the publish state is NOT a value the client can send, and that the anonymous read scope
  // — not any handler's `where` — is what hides an unpublished row.
  const wfCreated = await call("collectionCreate", { collection: "lectures", values: { title: "Workflow", speaker: "W", date: "2026-06-01" } }, admin);
  const wfRowId = wfCreated.body.result.id as string;
  assert(wfCreated.body.result.status === "draft", "cms: a new collection row is seeded as a draft");

  // Anonymous sees nothing while it is a draft.
  const wfAnonBefore = await call("publicLectures", {});
  assert(
    wfAnonBefore.body.ok && !(wfAnonBefore.body.result as Array<{ id: string }>).some((r) => r.id === wfRowId),
    "cms: an unpublished collection row is invisible to anonymous",
  );

  // `status` is a MANAGED column: sending it through the ordinary edit path must not move
  // the row live. This is the whole point of `supports` over the old `publish` field.
  await call("collectionUpdate", { collection: "lectures", id: wfRowId, values: { title: "Workflow", status: "published" } }, admin);
  const wfStillDraft = await call("collectionGet", { collection: "lectures", id: wfRowId }, admin);
  assert(wfStillDraft.body.result.status === "draft", "cms: collectionUpdate cannot set the managed `status` column");
  const wfAnonStill = await call("publicLectures", {});
  assert(
    wfAnonStill.body.ok && !(wfAnonStill.body.result as Array<{ id: string }>).some((r) => r.id === wfRowId),
    "cms: a client-sent `status` does not make a row publicly readable",
  );

  const wfPublished = await call("collectionPublish", { collection: "lectures", id: wfRowId }, admin);
  assert(wfPublished.body.ok && wfPublished.body.result.status === "published", "cms: collectionPublish moves the row live");
  assert(/^\d{4}-\d{2}-\d{2}T.*Z$/.test(String(wfPublished.body.result.publishedAt)), "cms: publishedAt is stamped in the ISO-Z shape $now() compares against");

  const wfAnonAfter = await call("publicLectures", {});
  assert(
    wfAnonAfter.body.ok && (wfAnonAfter.body.result as Array<{ id: string }>).some((r) => r.id === wfRowId),
    "cms: a published collection row IS readable by anonymous",
  );

  // …and by a LOGGED-IN member. `anonymous` is assigned only to callers with no verified
  // token, so public grants spread there alone would deny signed-in users content that
  // logged-out visitors can read. example/app.ts grants role("user") the same scope.
  const wfMember = await token("cms-member", ["user"]);
  const wfMemberRead = await call("publicLectures", {}, wfMember);
  assert(
    wfMemberRead.body.ok && (wfMemberRead.body.result as Array<{ id: string }>).some((r) => r.id === wfRowId),
    "cms: a published collection row is readable by an authenticated non-editor too",
  );
  // The public projection is the declared fields + id — never an undeclared entity column.
  // `?? {}` here would make this assertion VACUOUS: a regression that both leaked the
  // managed columns AND dropped the row from the public scope would still pass, because an
  // empty object has none of them. Assert the row was actually found first.
  const wfPublicRow = (wfAnonAfter.body.result as Array<Record<string, unknown>>).find((r) => r.id === wfRowId);
  assert(wfPublicRow !== undefined, "cms: the published row is present in the public projection under test");
  assert(!("unpublishAt" in wfPublicRow!) && !("scheduledAt" in wfPublicRow!), "cms: the public projection excludes the FORWARD-looking workflow columns");
  assert("title" in wfPublicRow! && wfPublicRow!.publishedAt !== undefined, "cms: the public projection carries the declared fields + publishedAt");
  assert(!("createdAt" in wfPublicRow!), "cms: the public projection excludes undeclared entity columns");

  // Revisions: the edit above snapshotted the pre-edit state.
  const wfRevs = await call("collectionListRevisions", { collection: "lectures", id: wfRowId }, admin);
  assert(wfRevs.body.ok && Array.isArray(wfRevs.body.result) && wfRevs.body.result.length >= 1, "cms: collectionListRevisions returns the row's history");

  // Scheduling: a future publish stores the instant; the row is not live yet.
  const wfUnpub = await call("collectionUnpublish", { collection: "lectures", id: wfRowId }, admin);
  assert(wfUnpub.body.ok && wfUnpub.body.result.status === "draft", "cms: collectionUnpublish takes the row back to draft");
  const wfSched = await call("collectionSchedule", { collection: "lectures", id: wfRowId, publishAt: Date.now() + 3_600_000 }, admin);
  assert(wfSched.body.ok && typeof wfSched.body.result.scheduledAt === "string", "cms: collectionSchedule stores the scheduled instant");
  const wfAnonScheduled = await call("publicLectures", {});
  assert(
    wfAnonScheduled.body.ok && !(wfAnonScheduled.body.result as Array<{ id: string }>).some((r) => r.id === wfRowId),
    "cms: a row scheduled for the future stays invisible to anonymous",
  );
  assert((await call("collectionSchedule", { collection: "lectures", id: wfRowId, publishAt: Date.now(), unpublishAt: Date.now() - 1000 }, admin)).status === 400,
    "cms: collectionSchedule rejects an unpublishAt before its publishAt (400)");
  assert((await call("collectionSchedule", { collection: "lectures", id: wfRowId, publishAt: 1e16 }, admin)).status === 400,
    "cms: collectionSchedule rejects an out-of-range epoch (400, not a 500 from toISOString)");

  // …and DRAIN it. Without this the scheduled-publish TASK has no end-to-end coverage at
  // all — `createCollectionTasks` could be deleted from example/app.ts and the whole suite
  // would still pass, despite the README's "WITHOUT THIS WIRING A SCHEDULE NEVER FIRES".
  // Schedule for NOW so the outbox row is due, then drain the tenant's outbox.
  const dueAt = Date.now();
  await call("collectionSchedule", { collection: "lectures", id: wfRowId, publishAt: dueAt }, admin);
  const wfDrain = (await fetch(`${base}/admin/tasks/drain`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ tenant: "main" }),
  }).then((r) => r.json())) as { ok?: boolean };
  assert(wfDrain.ok === true, "cms: the outbox drain runs the collection's scheduled-publish task");
  const wfAfterDrain = await call("collectionGet", { collection: "lectures", id: wfRowId }, admin);
  assert(wfAfterDrain.body.result.status === "published", "cms: the scheduled publish task moved the row live");
  assert(wfAfterDrain.body.result.scheduledAt === null, "cms: the publish task spent its intent token");
  const wfAnonDrained = await call("publicLectures", {});
  assert(
    (wfAnonDrained.body.result as Array<{ id: string }>).some((r) => r.id === wfRowId),
    "cms: the row scheduled and drained is publicly readable",
  );

  // A scheduled TAKEDOWN, drained the same way, takes it back down — and spends BOTH
  // tokens, so a redelivered publish task cannot put it back up.
  await call("collectionSchedule", { collection: "lectures", id: wfRowId, publishAt: dueAt + 1, unpublishAt: dueAt + 2 }, admin);
  await fetch(`${base}/admin/tasks/drain`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ tenant: "main" }),
  });
  const wfTakenDown = await call("collectionGet", { collection: "lectures", id: wfRowId }, admin);
  assert(wfTakenDown.body.result.status === "draft", "cms: the scheduled takedown task took the row back down");
  assert(
    wfTakenDown.body.result.unpublishAt === null && wfTakenDown.body.result.scheduledAt === null,
    "cms: the takedown spends both schedule tokens, so nothing can republish the row",
  );
  const wfAnonDown = await call("publicLectures", {});
  assert(
    !(wfAnonDown.body.result as Array<{ id: string }>).some((r) => r.id === wfRowId),
    "cms: the taken-down row is invisible to anonymous again",
  );
  // Deliberately left as a DRAFT here: the preview assertions below are about seeing a
  // row's unpublished state through a signed link.

  // Preview: a signed, single-row link, wfRedeemed unauthenticated at the public route.
  const wfPreview = await call("signCollectionPreview", { collection: "lectures", id: wfRowId }, admin);
  assert(wfPreview.body.ok && String(wfPreview.body.result.url).startsWith("/cms/preview/collection?token="), "cms: signCollectionPreview mints a relative link");
  const wfRedeemed = await fetch(`${base}${wfPreview.body.result.url}`);
  const wfRedeemedBody = (await wfRedeemed.json()) as { collection?: string; values?: { title?: string } };
  assert(wfRedeemed.status === 200 && wfRedeemedBody.collection === "lectures", "cms: the collection preview link redeems unauthenticated");
  assert(wfRedeemedBody.values?.title === "Workflow", "cms: the preview returns the row's unpublished content");
  assert((await fetch(`${base}/cms/preview/collection?token=nope`)).status === 403, "cms: a forged collection preview token is refused");

  // Workflow handlers only exist for collections that opted in.
  assert((await call("collectionPublish", { collection: "lectures", id: wfRowId })).status === 403, "cms: collectionPublish requires editor auth (403)");

  const delLecture = await call("collectionDelete", { collection: "lectures", id: lecRowId }, admin);
  assert(delLecture.body.ok, "cms: collectionDelete removes the row");
  assert((await call("collectionGet", { collection: "lectures", id: lecRowId }, admin)).body.result === null, "cms: the deleted row is gone");

  // --- site furniture: menus, redirects, taxonomies, widget areas (GitHub #32) ---
  //
  // End to end rather than in the unit tests, because the interesting half is the ACL: the
  // reads a site renders are ANONYMOUS, and what limits them is the public policy set, not
  // the handler.

  // A page of its own for the furniture assertions below: the earlier ones trash, unpublish
  // and archive pages as they go, so reusing one would make these depend on the order the
  // assertions above happen to run in.
  const navPage = await call("createPage", { typeId: ct.body.result.id, title: "Nav target", slug: "nav-target" }, admin);
  const menuPageId = navPage.body.result.id as string;
  await call("publishPage", { pageId: menuPageId }, admin);

  const menu = await call("createMenu", { name: "primary", label: "Primary" }, admin);
  assert(menu.body.ok, "cms: createMenu ok");
  assert((await call("createMenu", { name: "primary", label: "Dup" }, admin)).status !== 200, "cms: a duplicate menu name is refused");
  assert((await call("createMenu", { name: "other", label: "Other" })).status === 403, "cms: creating a menu needs an editor role (403)");

  // A page ITEM, so the resolution path is exercised: the stored ref is a page id, and the
  // url is worked out at read time from that page's slug.
  const menuItems = [
    { id: "home", label: "Home", kind: "custom", url: "/" },
    { id: "art", label: "Article", kind: "page", ref: menuPageId, children: [{ id: "sub", label: "Docs", kind: "custom", url: "/docs" }] },
  ];
  assert((await call("updateMenu", { name: "primary", items: menuItems }, admin)).body.ok, "cms: updateMenu stores a tree");
  const badMenu = await call("updateMenu", { name: "primary", items: [{ label: "x", url: "javascript:alert(1)" }] }, admin);
  assert(badMenu.status === 400, "cms: a javascript: menu href is refused (400)");

  const anonMenu = await call("getMenu", { name: "primary" });
  assert(anonMenu.body.ok, "cms: getMenu is public — a menu is site chrome");
  const anonMenuItems = anonMenu.body.result.items as Array<{ id: string; url: string; children?: unknown[] }>;
  assert(anonMenuItems.length === 2, "cms: both items resolve while the page is published");
  assert(anonMenuItems[1].url.endsWith("/nav-target"), "cms: a page item follows its page's slug rather than a frozen href");
  assert((anonMenuItems[1].children ?? []).length === 1, "cms: children come through resolved");

  // Unpublish the page it points at: the item is DROPPED, because the resolution read goes
  // through ctx.db and the anonymous scope is "published, not trashed".
  assert((await call("unpublishPage", { pageId: menuPageId }, admin)).body.ok, "cms: unpublishPage ok");
  const afterUnpub = await call("getMenu", { name: "primary" });
  assert((afterUnpub.body.result.items as unknown[]).length === 1, "cms: a menu item pointing at an unpublished page is left out, not rendered dead");
  assert((await call("publishPage", { pageId: menuPageId }, admin)).body.ok, "cms: republished for the assertions that follow");

  const redirect = await call("createRedirect", { fromPath: "/old-url/", toPath: "/new-url" }, admin);
  assert(redirect.body.ok && redirect.body.result.fromPath === "/old-url", "cms: a redirect path is canonicalized on the way in");
  const resolved = await call("resolveRedirect", { path: "/old-url" });
  assert(resolved.body.ok && resolved.body.result.to === "/new-url" && resolved.body.result.status === 301, "cms: resolveRedirect is public and answers with the destination");
  assert((await call("updateRedirect", { id: redirect.body.result.id, enabled: false }, admin)).body.ok, "cms: a redirect can be disabled");
  assert((await call("resolveRedirect", { path: "/old-url" })).body.result === null, "cms: a disabled redirect is invisible to an anonymous read");

  const tax = await call("createTaxonomy", { slug: "category", label: "Category", hierarchical: true }, admin);
  assert(tax.body.ok, "cms: createTaxonomy ok");
  const termNews = await call("createTerm", { taxonomy: "category", slug: "news", label: "News" }, admin);
  const termLocal = await call("createTerm", { taxonomy: "category", slug: "local", label: "Local", parentId: termNews.body.result.id }, admin);
  assert(termNews.body.ok && termLocal.body.ok, "cms: terms are created, nested included");
  const tree = await call("getTermTree", { taxonomy: "category" });
  assert(tree.body.ok && (tree.body.result as Array<{ children: unknown[] }>)[0].children.length === 1, "cms: getTermTree is public and folds the hierarchy");

  assert((await call("setPageTerms", { pageId: menuPageId, termIds: [termNews.body.result.id] }, admin)).body.ok, "cms: setPageTerms assigns");
  const pageTerms = await call("listPageTerms", { pageId: menuPageId });
  assert((pageTerms.body.result as Array<{ slug: string }>).map((t) => t.slug).join() === "news", "cms: a published page's terms are public");
  const byTerm = await call("listPagesByTerm", { taxonomy: "category", term: "news" });
  assert((byTerm.body.result as Array<{ id: string }>).some((p) => p.id === menuPageId), "cms: listPagesByTerm traverses the junction under the public page scope");

  // Deleting a term takes its assignments with it — a real ON DELETE CASCADE, so the
  // cleanup cannot be half-done by a handler that threw between two writes.
  assert((await call("deleteTerm", { id: termNews.body.result.id }, admin)).body.ok, "cms: deleteTerm ok");
  assert(((await call("listPageTerms", { pageId: menuPageId })).body.result as unknown[]).length === 0, "cms: the term's page assignments went with it");

  const area = await call("createWidgetArea", { name: "sidebar", label: "Sidebar" }, admin);
  assert(area.body.ok, "cms: createWidgetArea ok");
  assert((await call("updateWidgetArea", {
    name: "sidebar",
    widgets: [{ id: "w1", type: "menu", menuName: "primary" }, { id: "w2", type: "content", title: "Hello", content: rt("Side note") }],
  }, admin)).body.ok, "cms: updateWidgetArea stores widgets");
  const anonArea = await call("getWidgetArea", { name: "sidebar" });
  const anonWidgets = anonArea.body.result.widgets as Array<{ type: string; menu?: { name: string } | null }>;
  assert(anonArea.body.ok && anonWidgets[0].menu?.name === "primary", "cms: getWidgetArea is public and resolves a menu widget inline");
  assert((await call("getWidgetArea", { name: "nope" })).body.result === null, "cms: an unknown widget area is null, not a 404");

  // --- Block Kit: a custom admin page (GitHub #33 / #44 tier 3) ---
  const anonPages = await call("listAdminPages", {});
  assert(anonPages.body.ok && (anonPages.body.result as unknown[]).length === 0, "cms: listAdminPages is FILTERED — anonymous sees no page it cannot open");
  const adminPages = await call("listAdminPages", {}, admin);
  assert((adminPages.body.result as Array<{ slug: string }>).some((p) => p.slug === "lecture-desk"), "cms: an editor sees the registered admin page");
  assert(!Object.keys((adminPages.body.result as Array<Record<string, unknown>>)[0]).includes("roles"), "cms: the listing never carries the role list");

  const load = await call("adminPageInteract", { page: "lecture-desk", type: "page_load" }, admin);
  assert(load.body.ok && Array.isArray(load.body.result.blocks), "cms: a page_load answers with blocks");
  assert((load.body.result.blocks as Array<{ type: string }>)[0].type === "header", "cms: the blocks are the page's own description of itself");
  assert((await call("adminPageInteract", { page: "lecture-desk", type: "page_load" })).status === 400, "cms: an unopenable page is indistinguishable from an unknown one");
  assert((await call("adminPageInteract", { page: "nope", type: "page_load" }, admin)).status === 400, "cms: an unknown slug is a 400, never a raw dispatch");
  assert((await call("adminPageInteract", { page: "lecture-desk", type: "eval" }, admin)).status === 400, "cms: an unknown interaction type is refused");
}
