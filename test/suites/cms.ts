// @pramen/cms e2e — the block/page builder wired into the example app. Exercises the
// full flow against a real wrangler-dev DO: define block/content types, build a page from
// typed blocks in named regions, field validation + region allow-lists, publish (snapshot),
// the public content API (anonymous sees only the published snapshot), preview gating,
// reusable-block overrides, and scheduled publish (an outbox task).

import { assert, http, token } from "../lib";

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

  // --- editor auth: an anonymous caller cannot create block types ---
  const anonCreate = await call("createBlockType", { name: "X", slug: "x" });
  assert(anonCreate.status === 403 && anonCreate.body.ok === false, "cms: anonymous cannot create a block type (403)");

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

  // --- create a page (draft) ---
  const page = await call("createPage", { typeId: ct.body.result.id, title: "About Us", slug }, admin);
  assert(page.body.ok && page.body.result.status === "draft", "cms: createPage starts as a draft");
  const pageId = page.body.result.id as string;

  // --- a draft is invisible to the public content API (ACL scopes reads to published) ---
  const draftPublic = await call("getPage", { slug });
  assert(draftPublic.status === 404 && draftPublic.body.ok === false, "cms: anonymous cannot read a draft page (404)");

  // --- field validation: a required field is enforced ---
  const bad = await call("addBlock", { pageId, blockTypeSlug: "hero", region: "hero", fields: { subtitle: "no heading" } }, admin);
  assert(bad.status === 400 && bad.body.ok === false, "cms: a missing required field is rejected (400)");

  // --- region allow-list: the hero region only permits `hero`, so a rich_text is rejected ---
  const wrongRegion = await call("addBlock", { pageId, blockTypeSlug: "rich_text", region: "hero", fields: { body: "x" } }, admin);
  assert(wrongRegion.status === 400 && wrongRegion.body.ok === false, "cms: a block type not allowed in a region is rejected (400)");

  // --- place typed blocks in regions ---
  const heroBlock = await call("addBlock", { pageId, blockTypeSlug: "hero", region: "hero", fields: { heading: "About Us", subtitle: "Who we are" } }, admin);
  assert(heroBlock.body.ok, "cms: addBlock(hero) ok");
  const rich1 = await call("addBlock", { pageId, blockTypeSlug: "rich_text", region: "content", fields: { body: "<p>Our story.</p>" } }, admin);
  const rich2 = await call("addBlock", { pageId, blockTypeSlug: "rich_text", region: "content", fields: { body: "<p>Our mission.</p>" } }, admin);
  assert(rich1.body.ok && rich2.body.ok, "cms: two rich_text blocks placed in content");

  // --- preview: an editor assembles the current draft live ---
  const preview = await call("getPage", { slug, preview: true }, admin);
  assert(preview.body.ok && preview.body.result.regions.hero[0].fields.heading === "About Us", "cms: editor preview assembles the draft");
  assert(preview.body.result.regions.content.length === 2, "cms: preview content region has both blocks in order");
  // preview is editor-only
  const anonPreview = await call("getPage", { slug, preview: true });
  assert(anonPreview.status === 403, "cms: anonymous preview is forbidden (403)");

  // --- publish: snapshots the assembled page; the public API now serves it ---
  const published = await call("publishPage", { pageId }, admin);
  assert(published.body.ok && published.body.result.page.status === "published", "cms: publishPage flips status to published");

  const pub = await call("getPage", { slug });
  assert(pub.body.ok, "cms: anonymous can read the published page");
  assert(pub.body.result.regions.hero[0].block_type === "hero", "cms: content API returns the hero block with its type slug");
  assert(pub.body.result.regions.hero[0].fields.heading === "About Us", "cms: hero block fields are present");
  assert(pub.body.result.regions.content.length === 2, "cms: published content region carries both rich_text blocks");
  assert(pub.body.result.page.status === "published", "cms: snapshot reports published status");

  // --- reordering a region ---
  const placements = pub.body.result.regions.content.map((b: { id: string }) => b.id);
  const reordered = await call("reorderRegion", { pageId, region: "content", order: [placements[1], placements[0]] }, admin);
  assert(reordered.body.ok && reordered.body.result.count === 2, "cms: reorderRegion updates positions");

  // --- reusable block + per-placement override ---
  const shared = await call("addBlock", { pageId, blockTypeSlug: "rich_text", region: "content", fields: { body: "<p>Shared CTA</p>" }, isReusable: true }, admin);
  assert(shared.body.ok && shared.body.result.block.isReusable === true, "cms: a reusable block is created and placed");

  // Place the SAME block again with a per-placement override, then republish and confirm
  // the override merges over the block's base fields in the served snapshot.
  const reuseId = shared.body.result.block.id as string;
  const placed = await call("placeBlock", { pageId, blockId: reuseId, region: "content", overrides: { body: "<p>Overridden CTA</p>" } }, admin);
  assert(placed.body.ok, "cms: placeBlock reuses an existing block as a shared placement");
  await call("publishPage", { pageId }, admin);
  const pub2 = await call("getPage", { slug });
  const content2 = pub2.body.result.regions.content as Array<{ is_shared: boolean; fields: { body: string } }>;
  assert(content2.some((b) => b.fields.body === "<p>Shared CTA</p>"), "cms: the base reusable placement shows the block's own fields");
  assert(content2.some((b) => b.is_shared && b.fields.body === "<p>Overridden CTA</p>"), "cms: a shared placement's overrides merge over the block's fields");

  // --- reorderRegion must cover the region exactly (partial list rejected) ---
  const contentPlacements = pub2.body.result.regions.content as Array<{ id: string }>;
  const partial = await call("reorderRegion", { pageId, region: "content", order: [contentPlacements[0].id] }, admin);
  assert(partial.status === 400 && partial.body.ok === false, "cms: reorderRegion rejects a partial order list (400)");

  // --- removeBlock removes a placement ---
  const rm = await call("removeBlock", { pageBlockId: contentPlacements[0].id }, admin);
  assert(rm.body.ok, "cms: removeBlock removes a placement");
  const afterRm = await call("getPage", { slug, preview: true }, admin);
  assert((afterRm.body.result.regions.content as unknown[]).length === contentPlacements.length - 1, "cms: the removed placement is gone from the page");

  // --- createPage skips (not scaffolds) an invalid default block ---
  const showcaseCt = await call("createContentType", {
    name: "Showcase",
    slug: "showcase",
    regions: [{ name: "content" }],
    // hero requires `heading`; this default omits it, so it must be skipped, not scaffolded.
    defaultBlocks: [{ region: "content", blockTypeSlug: "hero", fields: {} }],
  }, admin);
  const showcasePage = await call("createPage", { typeId: showcaseCt.body.result.id, title: "Showcase", slug: "showcase-1" }, admin);
  assert(showcasePage.body.ok, "cms: createPage succeeds despite an invalid default block");
  const showcasePreview = await call("getPage", { slug: "showcase-1", preview: true }, admin);
  assert(((showcasePreview.body.result.regions.content as unknown[] | undefined) ?? []).length === 0, "cms: an invalid default block is skipped, not scaffolded");

  // --- scheduling: input validation ---
  const badOrder = await call("schedulePage", { pageId, publishAt: Date.now() + 1000, unpublishAt: Date.now() + 500 }, admin);
  assert(badOrder.status === 400 && badOrder.body.ok === false, "cms: schedulePage rejects unpublishAt <= publishAt (400)");

  // --- scheduled publish, end-to-end via a drain (intent-validated outbox task) ---
  const launch = await call("createPage", { typeId: ct.body.result.id, title: "Launch", slug: "launch" }, admin);
  const launchId = launch.body.result.id as string;
  await call("addBlock", { pageId: launchId, blockTypeSlug: "rich_text", region: "content", fields: { body: "<p>Launch!</p>" } }, admin);
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
}
