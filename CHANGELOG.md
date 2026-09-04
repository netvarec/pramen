# Changelog

All notable changes to the `@pramen/*` packages are recorded here. The eight packages —
`@pramen/server`, `@pramen/client`, `@pramen/react`, `@pramen/auth`, `@pramen/cms`,
`@pramen/cms-astro`, `@pramen/cms-editor`, `@pramen/admin` — publish in lockstep under one
shared version.

> **Gap in this file:** entries between 0.0.15 and 0.0.51 were not recorded. The `git log`
> is the record for that range; this file resumes at 0.0.52 rather than reconstructing it.

The format is based on [Keep a Changelog](https://keepachangelog.com/). This project is
**pre-1.0 and under active development**: 0.0.x releases may include breaking changes —
there are no backward-compatibility guarantees yet.

## [Unreleased]

### Added

- **`app.migrations` — imperative, recorded data migrations (`@pramen/server`).** Schema
  reconciliation is a diff between two table SHAPES, so it can only ever enact structure: there
  was no way to express a TRANSFORMATION — split a column, backfill the nullable column
  `ADD COLUMN` just created, rewrite units, normalize a `t.json()` blob whose shape changed.
  That work ended up as a hand-written admin handler someone curls once per tenant and hopes
  they got them all, with no record that it ran and no ordering guarantee against the schema
  change that made the column exist. Structure stays declarative; data is now imperative,
  ordered, and recorded: each `{ id, partition?, up(ctx) }` runs at most once per
  `(id, partition)`, its ledger row written in `_pramen_migrations` in the same transaction as
  its work, between `migrate()` and `app.bootstrap` on both the DO and D1 boot paths.

  `app.bootstrap` could not be stretched to cover this and the differences are the ones that
  matter: bootstrap runs on every boot, MUST be idempotent, and swallows its errors. A
  migration runs once, need not be idempotent (a backfill that doubles on the second run is the
  whole point), and **fails closed** — a throw writes no ledger row, aborts the boot, and
  retries on the next fetch rather than marking a half-finished backfill as done. There are no
  down migrations, deliberately.

  The claim carries a **lease**, because D1 has no single writer: one atomic upsert inserts the
  row, steals one whose lease has expired, or does nothing, and only the runner it hands the row
  to runs the migration. A runner meeting a live lease waits for the holder rather than skipping
  past it — skipping would serve traffic against half-migrated data and strand the migration if
  that holder then failed — and a holder that dies mid-backfill without releasing, which no
  compensating delete can cover, is recovered by its lease expiring. Ledger over HTTP at
  `GET /admin/migrations?tenant=&partition=`
  (admin-gated, both stores) and in the CLI as `pramen migrations list` / `pramen migrations
  status [--tenant t] [--all-tenants]` — the latter is the only honest answer to "is it safe to
  delete this migration?", since migration is lazy and per-DO and a tenant nobody has touched is
  still unmigrated (the same trap `renamedFrom` carries).

### Changed

- **The editor's primary nav is a sidebar with icons and groups (`@pramen/cms-editor`).** It was
  a row of tabs in the podoba topbar, which is a brand-left / few-tabs-right bar and fits a few
  tabs. A real deployment is not a few: Pages (or one tab per content type), N collections,
  Media, Menus, Taxonomies, Widgets, Redirects, any Block Kit page, Types, Users, Settings and
  whatever `extraNav` adds is a dozen-plus destinations. Past six or seven they became a dense
  unlabelled ribbon and then a horizontal scroller — a nav you have to scroll to discover, which
  is the one thing a primary nav must not be. The rail shows every destination at once, with an
  icon per row and headings that group them; below `md` it collapses to a disclosure under the
  wordmark. Everything else stays podoba (ghost pills, `text-compact`, the surface and border
  tokens); only the chrome's layout changed, and no page's own content moved.

  The groups — Content, Site, Apps, System — are BANDS OF `order`, not a hand-written list of
  sections, so the module's one contract still decides everything: an entry placed at
  `NAV_ORDER.pages + 50` is in Content and one at `NAV_ORDER.menus + 10` is in Site, exactly as
  the number reads. Enumerating keys instead would have let a host-placed entry land visually
  inside a group it is not a member of. Empty groups are dropped, and a deployment with only one
  group (collections-only, no site furniture) gets no headings at all — a single heading over a
  whole rail captions a list with no sibling to distinguish it from.

  A collection's or a Block Kit page's declared `icon` now goes in the ICON COLUMN. It used to be
  prepended to the label, where it read as part of the words, wrapped with them, and could not be
  aligned with anything; anything declaring none gets its section's glyph, so the column has no
  ragged edge. The glyphs podoba does not ship yet live in `cms-editor/src/icons.tsx`, drawn on
  its exact 24×24 / 2px-round grid so the nav reads as one family.

  The rail is shaped like NOTION's, which is the shape this kind of nav has converged on and the
  one an editor already knows how to read: a ground of its own (`surface-card` against the
  content's `surface`), so the two regions separate without a rule between them; dense rows
  (13px label, 15px icon, ~26px tall — a list to scan, not a strip of buttons to aim at, which
  is what podoba's `rounded-full` / `py-2` action pill made them); and **collapsible groups**,
  the fold remembered per browser in `localStorage`. In DARK, podoba maps `surface-card` onto
  `surface`, so there the hairline does the separating — which is why the border is
  unconditional and the tone is not. The active row also takes `font-medium`: podoba has one
  muted-surface token, so hover and active are otherwise the same pixel and "where am I"
  disappears under the cursor.

- **The media library can be searched, sorted and filtered (`@pramen/cms`, `@pramen/cms-editor`).**
  `listMedia` gains `q`, `sort` (newest/oldest, name A–Z/Z–A, largest/smallest) and `kind`
  (image/video/audio/document/other), and the library gets a search field, a sort menu and a
  row of type chips. All three are SERVER-side, because the library is paged: sorting or
  filtering the 60 rows that arrived sorts and filters 60 rows, which is neither.

  That required real columns. `cms_media.file` is a `t.fileRef()` — JSON in a TEXT cell — so
  its `filename`, `contentType` and `size` are invisible to `orderBy` and `where`. They are now
  projected onto indexed columns beside it, written where a media row is CREATED and nowhere
  else, so there is one writer and `file` stays the source of truth for serving. SQLite
  generated columns would remove the duplication outright, but the schema DSL cannot declare
  one. Nullable, so an existing store takes a plain `ADD COLUMN`.

  **`cmsMigrations` is new and must be spread into `app.migrations`** — it backfills those
  columns from the JSON that has always held the same values. Forgetting it fails quietly, in
  the way this package's other fragments do: pre-existing rows keep NULL and sort together
  under a name sort. The backfill is one bulk `UPDATE … json_extract(…)`, with an ORM walk as a
  fallback, because nothing in this repo had depended on JSON1 before and DO SQLite is
  Cloudflare's own engine — a missing function must not brick a tenant's boot, which is
  precisely what a data migration's fail-closed contract would otherwise do.

  The `other` bucket needs its own NULL clause, and shipped without one. SQL is three-valued:
  against a NULL `contentType` every `LIKE` is NULL, so `NOT (… OR …)` is NULL rather than
  TRUE and the row is excluded. `other` therefore matched everything except the rows it is
  defined to hold, and a legacy row — the deployment that upgraded and did not spread
  `cmsMigrations` — was invisible under all five chips, findable only by clearing the filter
  and with nothing on screen saying why.

  `sort` and `kind` are a CLOSED vocabulary on the server, never a column name and a direction
  from the client: both compile straight into `ORDER BY` and `WHERE`, so accepting a column
  would hand a caller the ability to order by — and therefore probe — `alt` or `deletedAt`. An
  unrecognised value falls back to the default rather than erroring, so a bookmark outliving a
  rename shows the library. Search matches the filename OR the alt text, since that is the only
  human description a media row carries and "logo" should find the file somebody described as
  one even when the upload was called `IMG_2831.png`; the needle's `%` and `_` are escaped to
  literals by the read engine, which `test/suites/cms.ts` asserts.

- **Media carries taxonomy terms (`@pramen/cms`, `@pramen/cms-editor`).** Files are tagged with
  the SAME vocabularies pages are — `cms_taxonomies` / `cms_terms`, through a new
  `cms_media_terms` junction — so a deployment that declares "Topics" tags a photo with one
  without declaring it twice, and the Taxonomies screen stays the one place a vocabulary is
  edited. `listMediaTerms` / `setMediaTerms` mirror the page pair (set semantics: the panel
  holds the whole selection, and two calls each patching one end of it race into a state
  neither asked for), and `listMedia` gains `term`, which ANDs with `kind` and `q`.

  A second junction rather than one polymorphic `cms_object_terms(objectType, objectId, …)`: a
  polymorphic key cannot carry a real foreign key, and the FKs are what does the work — purging
  a file or deleting a term takes its assignments with it, with no handler remembering to. The
  `where` traversal needs a typed column to join on too; `objectId` would have to be filtered by
  a discriminator the read engine cannot require, so one forgotten `objectType` clause would
  silently mix a page's tags into a media query.

  Filtering by term is a relation traversal compiled to a subquery, so it costs the same page of
  rows as filtering by kind — which is the whole reason the assignments are a junction and not a
  JSON array on the media row. A tag you cannot filter a paged library by is decoration.
  `listCmsCapabilities().mediaTerms` declares it: on an older server the detail panel's Tags
  section would 404 on open and the library's tag filter would send an argument that is silently
  ignored, i.e. a control that visibly does nothing.

  A vocabulary now declares **`appliesTo`** (`["page"]`, `["media"]`, both, or `null` for
  everything), because reusing the page vocabularies wholesale meant offering all of them in
  both places: a photo filed under "Local news", and `getTermTree("category")` filling up with
  terms like "hero" that no page listing will ever use. `listTaxonomies({ target })` narrows to
  it — server-side, so the page panel, the media panel and the write-side guard read one answer
  and cannot disagree.

  It is enforced on the WRITE, not just in the UI. Hiding a vocabulary from a panel without
  refusing the assignment is the `hideI18n` mistake this package already retired once: the
  control disappears, the request does not. And narrowing a vocabulary away from something it is
  still assigned to is refused, on the same grounds the `hierarchical` flag already refuses being
  turned off under nested terms — the assignments would stay stored and returned while
  disappearing from the only panel that could remove them.

  `null` is the un-narrowed state and the reading for every row written before the column
  existed, so an existing vocabulary keeps applying to everything and both stores behave alike.
  Nothing to migrate — a new table is additive, `migrate()` creates it, and `appliesTo` is a
  nullable `ADD COLUMN`.

- **The page editor is rebuilt around a toolbar (`@pramen/cms-editor`).** It opened onto
  three columns of panels with no header, and everything you came to do was somewhere you
  would not look for it.

  **Publishing was behind a tab called "workflow"** — a lowercase ghost button among five that
  read as filter chips, so the point of the screen required knowing that word. The transitions
  now live in a sticky toolbar beside the status they act on: the obvious next move is the
  primary button (Publish on a draft, Approve on one in review, Unpublish on a live page) and
  the rest are in a `⋯` menu. `pageWorkflowActions(status)` is a pure table, so that ORDER is
  asserted rather than read out of a component.

  **There were three save models on one screen**: an unlabelled "Save" on the canvas, an
  identically unlabelled one in the inspector saving the other half, and blocks in between
  autosaving silently. The page's own fields are content, exactly like a block, so they
  autosave on the same 800 ms debounce and the toolbar carries one line of truth about it.
  Title and slug keep an explicit **Save settings** — a slug is the page's URL, and autosaving
  one keystroke at a time would publish `/ab`, `/abo`, `/abou` and race the uniqueness check on
  each — now disabled until something actually differs.

  **The title appeared three times** (app-bar crumb, a rail card, the inspector) and the status
  twice. The rail card and the inspector's status row are gone, and the editor no longer
  publishes a detail crumb: the toolbar names the page.

  A narrowed rail no longer strands a phone. The narrow look is expressed entirely in
  `md:`-scoped classes, so it exists only at desktop widths — while the choice behind it is
  persisted per browser and travels to every viewport that browser opens. A rail narrowed on a
  laptop came back "narrowed" on a phone, where those classes are inert: the rows kept their
  labels and full width, while the JS gated on the stored choice removed all four group
  headings, and the hairline that stands in for one at 56px is `md:`-only too. One
  undifferentiated column of a dozen rows, with the toggle that would undo it
  `hidden md:inline-flex` — no way back from that viewport. `railIsNarrow(choice, wide)` is
  now the one rule, and JS agrees with the breakpoint instead of ignoring it.

  The media library also stops claiming to be empty when a filter simply matched nothing:
  "No media yet. Upload images…" is a claim about the library, and search/type/tag are all
  narrowings of it. It says "No matches" with a **Clear filters** button instead.

  **The 260px left rail held three lines you could not click**, and is gone. It became an
  outline first, which was the wrong answer to the same question: it is a table of contents for
  a document that is almost never longer than the screen, printing the same region names in the
  same order as the canvas one column away, and its only extra — a block count — is what "is
  this region empty" looks like when you look at it. Its one real service, jumping to a far
  region, is scrolling on a page you are already scrolling. The region headings are sticky
  instead, so on a long page the slot you are editing is always named — which is the
  orientation an outline was standing in for.

  Smaller, in passing: the page-fields heading says "Page fields", because a region is very
  often named `content` and the two headings sat one above the other both reading CONTENT;
  inspector tabs are a real tab strip with written-out labels (a CSS `capitalize` rendered
  "seo" as "Seo"); the back button names its destination, which on a per-type deployment is
  that type's list and not a pooled "Pages" the deployment does not have; and a breadcrumb
  separator no longer leads the trail when a screen publishes a detail crumb from a route no
  nav entry matches.

- **Preview links reach a page you can actually look at (`@pramen/cms-editor`,
  `@pramen/cms-astro`, `example/site`).** Two halves were missing and the feature fell through
  the gap between them.

  The page editor never minted one. `signPagePreview` has existed on the server, tested end to
  end, since preview stopped being a role check — and no editor screen called it, so the only
  way to get a link was to write the RPC by hand. The collection editor has had its button
  since `supports: ["preview"]`; the page half now has the same one, in the Workflow panel.
  It is not keyed to the status, because a published page is exactly what you preview before
  changing it and a draft is exactly what you send for comment.

  And the link opened JSON. The CMS redeems the token itself and answers with the assembled
  draft, because a headless CMS has the content and no idea what it should look like —
  correct for a machine, useless for the stakeholder without an account who a preview link is
  FOR. A host can now declare **`admin.previewUrl`**: a route of its own that the editor sends
  the token to instead. Same seam as `menuHref` and the sitemap's `pageUrl` — the CMS cannot
  know how a deployment routes, so the deployment says. Unset, nothing changes.

  The link it copies is ABSOLUTE. `previewUrl` is normally written as a path, so the
  configured — recommended — path put `/preview?token=…` in the clipboard: dead the moment it
  is pasted into Slack, which is half of what the button is for. The new tab hid it, because a
  blank window opened by the editor inherits its base URL and resolves a relative href
  perfectly well.

  The button OPENS it, in a new tab, and still shows and copies the link — "look at my draft"
  and "send this to someone" are both what it is for, and only one of them ends in the new tab.
  The tab is opened synchronously before the round trip and pointed at the link afterwards,
  because `window.open` called after an `await` has lost the user gesture that authorised it
  and every popup blocker takes it; a blocked one falls back to the revealed link, which is
  still a working answer. A mint that fails now closes the placeholder tab and says why,
  rather than leaving a stray `about:blank` and a button that looked like it did nothing.

  `example/site` ships the other end: `src/pages/preview.astro` redeems the token with
  `client.getPreview(token)` and renders the draft through the SAME `Article.astro` the
  published route uses — the layout was extracted for exactly this reason, since a preview
  drawn by a second copy of the markup is a preview of the copy. It carries a draft banner,
  `noindex`, `no-store`, and answers a forged or expired token with a 404 indistinguishable
  from a missing page, so spraying tokens at it confirms nothing.

  Pages only. A collection row has no canonical URL — the site decides what one looks like, if
  anything — so `signCollectionPreview` keeps pointing at the backend.

- **The screen header stays as the page scrolls, condensed (`@pramen/cms-editor`).** Scrolling a
  media library past the first row used to take the header away, leaving a wall of thumbnails
  with no title and no primary action. Sticky alone would be worse — a 190px banner pinned to
  the top eats a third of the viewport on every scroll — so it condenses to a bar: same panel,
  same artwork, same button, a third of the height. The two near-identical headers that used to
  live one in `components.tsx` and one in `furniture.tsx` are now one `page-header.tsx` with a
  size; a LEAF module, because `components.tsx` already imports from `furniture.tsx` and either
  importing the other would have been a cycle.

  Getting it to stop flickering took three things, and only the third is the real cause.
  Hysteresis (condense above 120px, expand below 16px) because a single threshold toggles on
  trackpad jitter. No transition on the type, because `transition-all` was tweening `font-size`
  56px → 22px, relaying out the panel on every frame — of a STICKY element whose height feeds
  back into the scroll position — while `display` (two stacked lines → one baseline row) cannot
  be tweened and snapped mid-animation anyway. And **`overflow-anchor: none` on the scroller**,
  which is what actually fixed it: condensing removes ~134px of layout ABOVE the viewport, and
  scroll anchoring exists precisely to compensate for that, so the browser silently subtracted
  the same 134px from `scrollY` — a new scroll position feeding the very condition that
  condensed the header, which flips back, restores the height, and gets the offset returned.
  Measured: asking for `scrollY` 121 settled at 17. Hysteresis cannot fix that, since the
  compensation is the same size as the change; the dead band would have to be wider than the
  collapse. Turning anchoring off also removed a second, separate bug — the page yanking by
  134px on the scroll that crossed the threshold.

- **Screen headers are cover panels with generated artwork (`@pramen/cms-editor`).** Six list
  screens whose only difference is a word at the top read as one screen you keep landing on.
  The header is now a panel carrying the title and the primary action over art DERIVED from
  the screen's name: an FNV-1a hash seeds a PRNG, and the PRNG lays out a Truchet field — a
  grid of quarter-circle arcs whose per-tile orientation is the only random thing about it —
  under a colour wash. Same name, same picture, forever; a new collection gets its own without
  anyone drawing one. Nothing to author, nothing to upload, no screen that looks like another.

  Seeded on the header's `lead`, NOT its `em`. `lead` is the screen's NAME ("Media", a
  collection's plural label) and `em` is its STATE ("None yet", "3 files") — seeding on what is
  displayed would redraw the artwork every time someone uploaded a file, which is the one thing
  a picture meant to make a screen recognisable must never do.

  Two constraints shaped the rest, both from what the art sits under. Line work is
  `currentColor` at low alpha, so it is dark on the light theme and light on the dark one BY
  CONSTRUCTION — which matters specifically because podoba does not redefine its accent tokens
  per theme, and a fixed accent stroke would be near-white mint on white, or near-black blue on
  near-black. Colour therefore arrives as a wash, from a CLOSED list of mid-toned podoba tokens
  rather than a free hue (a free hue puts colours in the chrome that exist nowhere else in the
  product), with its origin pinned to the right half and a `from-surface-card` gradient over
  the left, so 56px type never lands on pattern whatever the seed produced. One inline SVG
  built during render: no dependency, no canvas, no image to load.

- **The header's action is the button, not a pill around it (`@pramen/cms-editor`).** `Cta` —
  a 360px mint pill carrying a sentence ("Let's upload something") wrapped around the actual
  button — is gone from all four list headers. Once the header grew a cover, a saturated pill
  on top of it was a panel inside a panel, two filled surfaces competing for the same corner;
  and the sentence was by then the third telling of one fact, between a title reading "Media /
  None yet" and an empty state reading "No media yet. Upload images to…".

  It was also hiding a bug that only showed on the dark theme: the wrapper filled with
  `brand-green` (#75e7b8) and podoba maps `brand-primary` — what a default `Button` fills with
  — onto that same #75e7b8 in dark. Mint on mint, so the button had no edge and read as a run
  of text. On `surface-card` it has the contrast podoba designed for it, in both themes.

  Media's Upload control became a real `Button` driving a hidden input, replacing a `<label>`
  painted to look like one: the lookalike restated podoba's primary fill by hand, and with the
  wrapper gone the app's two primary actions were visibly different colours in dark —
  `surface-inverted` (cream) there against `brand-primary` (mint) everywhere else.

- **`BootstrapContext` carries `env` (`@pramen/server`).** A boot-time reconciler has no
  request to carry a flag on, so the only gates it had were "always" and "never" — which is
  the wrong pair for reference data that belongs in local dev and nowhere else. `env` is the
  same widened bag a handler sees as `ctx.env`, on both boot paths (DO and D1). While
  threading it through, `ensureD1Migrated` now takes `env` instead of the one boolean it used
  to be handed: three call sites each re-deriving `PRAMEN_ALLOW_DESTRUCTIVE === "true"` was
  one place too many for a flag whose whole job is to gate data loss.

- **The example seeds a demo account, so `bun run dev` leads somewhere.** On a fresh store
  there was no way IN: `signup` assigns the `user` role, which no CMS policy accepts, so the
  editor's Setup screen — which asks for a bearer token and nothing else — could only be
  satisfied by hand-signing a JWT with the dev `AUTH_SECRET`. `devUserBootstrap` in
  `example/app.ts` now seeds **`pramen@local` / `pramen-dev`**, gated on `PRAMEN_DEV_SEED`
  (set by `oblaka.ts` for the `local` env only — a known username with a known password is
  exactly the reference data that must never reach a deployment, and `bun run deploy` ships
  the same `app.ts`). It inserts only when the row is ABSENT: `bootstrap` runs every boot, so
  writing the hash unconditionally would reset a changed password on every cold start, and
  the existence check is a SELECT *before* `hashPassword` because PBKDF2 at 100k iterations
  inside `blockConcurrencyWhile` is a multi-second stall in front of the first request.

  Ten characters, not the obvious `pramen`: `login` parses its input with the same
  `parseCreds` `signup` uses, which rejects anything under eight before it ever looks at a
  hash. `example/site` gains `/admin/sign-in` and `admin: { signInUrl }` — the SITE owns the
  sign-in screen, which is what keeps the editor BYO-IdP (it verifies a bearer token and knows
  nothing about how one is obtained), and mirrors how a real deployment does it.
  `tools/dev-token.ts` still mints a token for `/__admin?setup=1`, which is the way in when
  there is no account to sign in as.

- **The editor's icons are Phosphor, regular weight (`@pramen/cms-editor`).** One family,
  chosen for plainness: at 15px in a nav rail an icon has to survive as a silhouette, and
  Phosphor's regular weight is the simplest set that still reads at that size. It replaces two
  half-families that had ended up side by side in a 240px column — podoba's own line set, which
  does not cover a CMS's nouns (no taxonomy, no widget area, no redirect), and the glyphs the
  editor had drawn by hand to fill those gaps. Two sets of hand-fitted curves next to each
  other is the one outcome worse than either.

  Everything the editor draws now comes from `cms-editor/src/icons.tsx`, aliased to names that
  say what a glyph MEANS here rather than what it depicts (`MenuToggleIcon`, `GroupOpenIcon`,
  `NAV_GLYPHS.taxonomies`). That is what keeps the family one decision in one file: changing it
  — or moving it into `@podoba/react`, where it belongs once the design system adopts a set —
  is this module's imports and nothing else, because no call site names a vendor. Costs ~45 KB
  raw in the bundle (each Phosphor module carries all six weights).

  A HOST's own icon stays a separate thing: `collection(..., { icon: "🎓" })` and
  `adminPage(..., { icon: "🚚" })` go into the icon column verbatim. Resolving such a string
  against Phosphor BY NAME is deliberately not offered — a by-name lookup needs the whole
  3000-icon registry in the bundle, which is megabytes to let a deployment name one glyph it
  can already supply directly.

- **The editor mounts at `/__admin`, not `/_pramen/admin` (`@pramen/cms-astro`).** BREAKING for a
  deployed site: the old path stops resolving, so update any bookmark, `signInUrl` target, or
  access rule written against it. The old prefix named the framework in a URL an editor
  bookmarks, types and reads out over the phone — the same mistake `brand` exists to undo, and
  the name of the library the agency happened to build with belongs there no more than it does
  in the wordmark. `__` is the settled "the framework serves this, not you" marker (`/_next`,
  `/_nuxt`, `/_astro`, Cloudflare's `/__scheduled`, and pramen's own `/__migrations`), doubled to
  keep clear of Astro's single-underscore conventions. A leading DOT (`/.admin`) was the shape to
  avoid: dotfile protection is on by default in a great many static hosts, CDNs and reverse
  proxies, so it is a path a share of deployments would simply 404 — `.well-known` needed an RFC
  and per-server carve-outs to be reachable, which is the proof rather than the counterexample.
  Still one constant feeding both the injected route pattern and the prefix stamped on the mount
  node, so the router cannot end up mounted where the server does not serve.

### Fixed

- **The D1 store's Worker boot could wedge an isolate for its lifetime (`@pramen/server`,
  #51).** After some deploys a share of fetch invocations hung at 0–1 ms CPU until the caller
  gave up, before reaching any handler, while crons on the same Worker stayed healthy and a
  redeploy of the identical commit cleared it. The cause was the once-per-isolate D1 boot
  (migrate → data migrations → outbox → bootstrap) memoized as a bare promise shared by every
  request. Async work belongs to the invocation that starts it: when the first request after a
  deploy carrying a table rebuild legitimately ran past the caller's ceiling and the caller
  disconnected, the runtime canceled that invocation's pending I/O — and a promise chained on
  canceled I/O never settles. Not rejects; never settles. So the `.catch` meant to clear the
  memo never ran, and every later request in that isolate awaited it for as long as its own
  caller allowed. Crons ran in another isolate; the ~54 % was the share of traffic routed to
  the wedged one; a redeploy discarded every isolate.

  Two defenses now, both needed. The invocation that starts the boot puts it under
  `ctx.waitUntil`, so a disconnecting caller no longer cancels a boot everyone else is waiting
  on (the `scheduled` entry now receives and passes `ctx` too). And awaiters no longer trust a
  shared boot unconditionally: the boot reports progress on every statement, and one that has
  made none for 30 s (the platform's `waitUntil` cap, measured from the last statement so a
  slow-but-live rebuild is never mistaken for a dead one) is treated as orphaned — the next
  awaiter, arriving or already waiting, starts a fresh boot in its own invocation and logs a
  warning. An isolate can now be wedged for at most 30 s, never for its lifetime; every boot
  step already tolerated a second runner (lease-claimed ledger, diff-based migrate, upsert
  bootstrap), so a false positive costs a redundant boot, not correctness. `SharedBoot` +
  `observeDriver` in `runtime/boot.ts`, platform-agnostic and unit-tested.

## [0.0.59] — 2026-09-02

### Added

- **Mailgun as a `ctx.mail` transport (`@pramen/server`).** Cloudflare Email Sending
  needs no API key, but it can only send FROM a domain that is a zone in the same
  account. `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` + `MAIL_FROM` now selects Mailgun
  instead, with `MAILGUN_API_BASE` for the EU region (the two regions are separate
  deployments and a key from one 401s against the other).

  It slots into the existing adapter seam, so no handler changes. Mailgun outranks the
  `EMAIL` binding when both are present: the binding tends to exist because the
  infrastructure declares it, whereas an API key is only ever there because somebody put
  it there. A half-configured Mailgun (key but no domain) falls through to the next
  transport rather than sending nowhere, and a non-2xx throws — carrying Mailgun's own
  reason, never the key — so the outbox retries and then dead-letters visibly instead of
  turning a bounced sign-in link into silence.

## [0.0.58] — 2026-09-02

### Fixed

- **Live subscriptions died when the Durable Object hibernated (`@pramen/server`).** The DO
  holds subscriptions in memory, keyed by socket, because the WS attachment is capped at
  ~2 KB and a full set does not fit. Hibernation dropped that map — but left the socket
  OPEN. So the client saw no close, never replayed, and the DO went on broadcasting to a
  socket it no longer believed was subscribed to anything: every push silently dropped,
  for the life of the tab, with the connection reading healthy the whole time. Only a
  reload brought updates back. `protocol.ts` even described a `Subscription` as "persisted
  on the socket so it survives DO hibernation", which was the intent and never the code.

  The map still lives in memory, but a one-bit `subscribed` marker now rides the
  attachment — the one thing that survives — so a woken DO can tell "subscribed to
  nothing" apart from "subscriptions lost", which until now read identically. On noticing
  the loss the DO closes the socket (4410), and the client's existing reconnect-and-replay
  does the rest. Verified against a live app on workerd: after a 20 s idle the socket
  closed 4410 and an unmodified `@pramen/client` reconnected and received the push it
  would otherwise never have seen.

## [Shipped in 0.0.57, recorded late]

### Fixed

- **An EMPTY `contentType` slug listed every type's pages (`@pramen/cms`).** The narrowing
  branch was picked with a falsy check while the validator three lines below deliberately let
  `""` through — the exact inverse of the rule the handler documents, and reachable, because
  a content type's slug is caller-supplied and nothing rejected an empty one. An empty slug is
  now an ordinary unmatchable slug (nothing), and `createContentType`/`updateContentType`
  refuse an empty `slug`/`name` outright: a type with an empty slug also got a tab that could
  not be reached (`/types/` drops the empty segment and matches no route) and, sorting first,
  could leave `/` permanently blank.

- **`listPages` was open to anonymous callers (`@pramen/cms`).** It is now viewer-gated, like
  every comparable read in the same factory. The rows are full page records — schedule stamps,
  the revision pointer, the whole `fields` bag, every SEO column — which is the editing
  surface; `listPublishedPages` remains this file's deliberate public projection and is still
  anonymous. (Pre-existing: the handler had no options object at all before it grew one.)

- **The page editor could not open a page its own list had just shown (`@pramen/cms`,
  `@pramen/cms-editor`).** `/pages/:id` resolved the id against a pooled, capped `listPages`,
  so once another type had enough newer pages to fill that page of results, clicking a row in
  a type's tab landed on "Page not found." There is now a `getPageById` handler (viewer-gated,
  row-ACL'd) and the editor uses it.

- **The create modal kept filing pages under the previous tab's type (`@pramen/cms-editor`).**
  Its `typeId` was seeded from the screen once at mount and never re-synced, and the picker is
  hidden on a type-scoped list — so opening "+ New page" on one type's tab and navigating to
  another's (history navigation is not blocked by the modal overlay, and the component instance
  survives it) filed the page under the type you left, with nothing on screen saying so. It
  re-syncs now, and the modal names the type it is filing under.

- **A content type whose slug needs URL encoding never lit its tab (`@pramen/cms-editor`).**
  The active slug was read from the percent-ENCODED pathname and compared against the raw slug,
  so `články` routed correctly to a tab bar with nothing lit. The segment is decoded before
  comparison. Routing itself was never affected.

- **`/` painted the pooled list before redirecting away from it (`@pramen/cms-editor`).** The
  split was derived from a content-type list that starts empty and arrives async, so every cold
  load of the landing route (and of the wordmark) fetched and rendered the exact screen the
  split exists to retire, then flipped. "Not answered yet" is now distinct from "this
  deployment has one type", and the redirect and the render bail are gated on one condition
  rather than two that could disagree and leave `/` blank.

- **A failed `listContentTypes` showed "Loading…" forever (`@pramen/cms-editor`).** A 5xx — or
  a session whose role cannot call it at all — was swallowed into the same empty array as "not
  loaded yet", so `/types/:slug` sat on a loading state over data it already had, with the way
  back suppressed for the same reason. The failure is recorded and the screen offers a retry.

- **Rows from the previous type sat under the new type's heading (`@pramen/cms-editor`).** The
  per-type fetch neither cleared the list nor cancelled in flight, and the router renders the
  same component instance across a params-only change — so switching tabs showed the old type's
  pages under the new type's name until the fetch landed, and permanently if it failed.

- **The page list reported the server's cap as a total (`@pramen/cms`, `@pramen/cms-editor`).**
  `listPages` capped at 100 with no way to ask for more, and the header printed that count as
  "N total" — a deployment with 400 articles read as having 100, with the other 300 unreachable
  from the editor. The handler takes `limit`/`offset` (default 100, ceiling 500) and the list
  pages with a "Load more" button and an `N+` count, exactly as collection lists already did.

- **An older CMS made every type tab show every type's pages (`@pramen/cms`,
  `@pramen/cms-editor`).** An unknown input key is passed through, not rejected, so a
  pre-`contentType` server accepted the argument and answered with the pooled list — N tabs each
  claiming one type and showing all of them, with "New page" from any of them stamping that
  tab's type. `listCmsCapabilities` now declares `pagesByType`, and the editor renders the split
  only when the server says so — the same declared-not-inferred rule as `locales`.

- **`cmsLoader` filtered an already-truncated list in JS (`@pramen/cms-astro`, `@pramen/cms`).**
  It fetched every published page (capped at 5000) and narrowed by content type and locale
  client-side — the very pattern the per-type page list exists to avoid. With
  `collections: "auto"` generating one collection per type, each re-fetched the same capped
  rows and silently lost the tail of its own type past the cap, build still green.
  `listPublishedPages` now takes `contentType`/`locale` and narrows server-side.

- **A slug collision never named the type holding the slug (`@pramen/cms`).** Slugs are unique
  per locale ACROSS content types, so with the editor listing one type per tab the colliding
  page is usually one the caller cannot see: "slug 'about' already exists for locale 'en'",
  raised against a list visibly containing no such row. Both the live and the trashed variant
  now name the owning content type and say the constraint is global.

- **Adding an input parser to `listPages` narrowed what the ACL saw (`@pramen/cms`).** Dispatch
  hands the PARSED input to `Db` as the value `$input("path")` policy markers resolve against,
  and the parser rebuilt a fresh object holding only the keys it knew — so a host scoping
  `cms_pages` with a capability key had that scope silently collapse to nothing. Both page
  listings now spread the raw input rather than rebuilding it.

- **`/types/:slug` ignored `hidePages` (`@pramen/cms-editor`).** A deployment that hides the
  block/page builder entirely still served it to anyone who typed the URL or followed a stale
  link. The flag is read in one place now, shared by the nav, the landing redirect and this
  route.

- **"A deployment with a single type is untouched" was not true (`@pramen/cms-editor`).** 0.0.55
  said so, but the pooled list's own wording changed for everyone: "N pages total" became
  "N entries total" and "No pages yet." became "No entries yet.", unscoped by the split. It also
  put the collections vocabulary on a page screen, so a type-scoped list read "Article" /
  "No entries yet" / "+ New page" / "Create a new page" — three vocabularies at once. The
  wording is back to "pages" throughout; the type's `name` heads the screen and is never bent
  into a noun phrase, since it is a label a host writes and is often already plural.

- **"← all pages" from the editor landed in another type's list (`@pramen/cms-editor`).** Every
  way back targeted `/`, which on a split deployment redirects to whichever type sorts first by
  name — and `replace`s the history entry, so Back could not undo it. The page editor returns to
  its own page's type.

### Added

- **`listPages` takes `limit`/`offset` and `select` (`@pramen/cms`).** The handler caps its
  result, so without paging a caller cannot tell a full first page from the whole table — and
  the editor's header printed the cap as if it were the total. `limit`/`offset` page the list
  (default 100, ceiling 500); `select` projects it to the columns a list screen actually
  renders, instead of pulling the widest row in the CMS over RPC (the D1 shape from #22). The
  `contentType` slug added in 0.0.55 is now resolved by traversing the `type` relation the
  schema already declares — one query rather than two, no throw for a caller who may read
  pages but not content types — and `cms_pages.typeId` is indexed to serve it.

- **`listPublishedPages` takes `contentType` and `locale` (`@pramen/cms`).** Same argument, the
  public half: `@pramen/cms-astro`'s `cmsLoader` passes them so each generated collection asks
  the server for its own type instead of narrowing one capped fetch after the fact.

- **`getPageById` (`@pramen/cms`).** One page, wide, by id — what the editor opens `/pages/:id`
  with. Viewer-gated and row-ACL'd like every other read.

## [0.0.56] — 2026-09-01

### Fixed

- **A token the server won't accept now ends the session (`@pramen/cms-editor`).** The editor
  decided it was signed in from the token's own `exp` claim, parsed client-side — which covers
  exactly one way to stop being signed in. Every other way (the signing secret rotated, the
  account deleted or deactivated, the token revoked onto the denylist, a stored token from an
  older deployment) leaves an unexpired `exp` on a token the server resolves to nobody. And
  anonymous is not an error in pramen — the ACL answers it — so the editor mounted and rendered
  a shell that looked signed in and was empty: `listContentTypes` and `listBlockTypes` 403 into
  swallowed catches, so the tabs collapsed to the pre-types default and the Users tab vanished,
  and the page list showed only what the public can read. No error banner, nothing to click, no
  way back to sign-in. `me` — the one call that asks the server who it thinks you are — now
  hands off to the sign-in page (or the Setup screen) when it resolves to no identity. A call
  that THROWS does not: a network blip must not sign anyone out. A signed-in user with no roles
  yet is a session, and stays in the editor with the access-denied banner rather than looping
  through sign-in.

## [0.0.55] — 2026-09-01

### Added

- **Each content type gets its own tab and its own list (`@pramen/cms-editor`,
  `@pramen/cms`).** A deployment declaring two content types — pages AND articles, say —
  pooled both into a single "Pages" list: one column, one row shape, and nothing but the slug
  to tell a landing page from a news item. With more than one type the topbar now shows a tab
  per type (labelled with the type's own `name`) pointing at `/types/:slug`, `/` hands off to
  the first of them, and the create modal opens on the type whose list you are standing in
  instead of asking again. A deployment with a single type is untouched — it keeps the plain
  "Pages" tab, because there is nothing there to separate.

  > The last sentence overstated it: the pooled list's own wording changed for every
  > deployment, single-type ones included. Corrected in the next release.

- **`listPages` takes an optional `contentType` slug (`@pramen/cms`).** The filtering has to
  happen on the server: the handler caps at 100 rows, so an editor narrowing a pooled fetch
  would be narrowing an already-truncated list and would quietly lose the tail of every type
  past that cap. An unknown slug returns nothing rather than falling back to everything — a
  renamed type must not make every article surface under a tab that no longer matches it.
  Omitting the input is unchanged behaviour.

## [0.0.54] — 2026-08-31

### Fixed

- **`extraNav`'s `target: "_self"` decided on the wrong URL (`@pramen/cms-editor`).** The
  check resolved the href against `window.location.origin`, but a browser resolves
  `<a href>` against the current DOCUMENT — so a relative href like `curate` from
  `/_pramen/admin/pages/abc` was judged off-prefix (same tab) while the browser navigated to
  `/_pramen/admin/pages/curate`, which is IN-prefix, straight onto the in-app 404 the check
  exists to prevent. `?tab=x` and `#top` failed the same way. The document URL is now a
  parameter, so the decision is made about the navigation that will actually happen.

- **`_self` no longer discards unsaved edits silently.** A same-tab link is a real
  cross-document navigation, but the links were deliberately exempt from the topbar's
  unsaved-changes guard on the reasoning that they "leave nothing behind" — true only while
  they always opened a new tab. `CollectionEditor` registers no `beforeunload` either, so a
  half-filled collection form was lost with no prompt of any kind. Same-tab links now run the
  guard.

- **`rel="noreferrer"` is kept on same-tab links.** Only `target` and `noopener` are
  branch-specific; dropping `rel` entirely handed the destination the full admin deep-link
  URL (`/_pramen/admin/pages/<id>`) as `Referer`.

- **The scheme and the origin are checked, not just the path.** `new URL` parses
  `javascript:` and `data:` happily, and their `pathname` fails any containment test, so they
  took the same-tab branch and shed the `rel` that had confined them. A cross-origin href was
  likewise judged only on its path.

- **`_self` now works for a cross-origin tool on a root-mounted editor.** The old `!basePath`
  test refused it, though the catch-all can only claim same-origin paths — so the one
  configuration that is provably safe unmounted was the one denied.

- **A mount path is restricted to characters that survive URL parsing.** Every comparison
  against it — here and in buzola's own `stripBasePath` — is a raw `startsWith` against a
  percent-ENCODED `pathname`, so a mount of `/správa` could never match `/spr%C3%A1va/…` and
  every in-prefix URL read as off-prefix. The admitted set is now derived from the parser.

### Changed

- **`scopeToBasePath` spreads the adapter instead of listing its methods**, so a member added
  by a future `@buzola/router` is forwarded rather than silently dropped — which matters for
  the planned bump past `^0.0.12`. Adding the same handler twice is now a no-op instead of
  orphaning a wrapper that could never be removed.
- **`opensInSameTab` moved into `mount.ts`** and the test imports it. The test previously
  re-implemented the predicate under a "mirrors" comment, and the copy carried the same
  resolution bug — six green tests that said nothing about the shipped code.
- **`target` is documented** in both READMEs and the CMS guide; it had appeared in none.

## [0.0.53] — 2026-08-30

### Added

- **The CMS editor is served by your Astro site (`@pramen/cms-astro`, `@pramen/cms-editor`).**
  `pramenCms({ backend, admin: true })` injects one catch-all route at `/_pramen/admin`, and
  that route renders the editor's shell. The editor stops being something you deploy beside
  the site and becomes part of it: no `dist/` to copy, no SPA-fallback rewrite to configure,
  no second hostname for it, and no Setup screen asking for a URL the server already knows —
  the shell declares the backend, so the first screen asks for a JWT and nothing else.
  (It moves where the editor is served, not where the API is: RPC still goes to
  `backend.url`, so a CMS on its own Worker still needs `CORS_ORIGINS`.)

  This is the `basePath` idea from the previous commit, done at the level where it works.
  The problem with a browser-side prefix alone was the shell: a baked `index.html` can only
  reference `/editor.js` root-absolute, so the one deployment shape the option existed for
  was the one shape it could not boot in. Handing the shell to the host solves the asset
  paths (its bundler emits and fingerprints them), the deep links (every view is a real
  server route) and the configuration (typed options rendered into the page) at once.

  `admin` also carries the editor's own configuration — `brand`, `signInUrl`, `hidePages`,
  `extraNav` — replacing the hand-edited `/config.js`. `@pramen/cms-editor` is an optional
  peer dependency; omit `admin` and nothing is injected.

- **An example Astro site (`example/site`), which is also the test.** It reads the example
  CMS backend and serves its editor from the same origin — the whole wiring is one
  `pramenCms()` call. `test/astro-site.test.ts` builds it against a stub CMS, boots the
  output with `@astrojs/node` and asserts what only a real build can show: that the site's
  bundler emitted `editor.js`/`editor.css` at URLs the shell reaches, that a deep link like
  `/_pramen/admin/pages/abc` is served by the server rather than a rewrite, that the shell
  carries the mount prefix and the declared backend, and that it is sent `private, no-store`.

  It also runs **`astro check`** — the only thing in this repo that type-checks `.astro`
  files. It lives in the test rather than in `bun run typecheck` because it syncs before it
  checks, which runs the content loaders and so needs a reachable CMS.

- **Navigation is scoped to the mount (`@pramen/cms-editor`).** `_404.tsx` registers the
  catch-all `/:__notFound+`, so buzola's `Router.start()` matched — and intercepted — every
  same-origin path. At the origin root that was right; co-hosted it was not, and a click on
  the host site's own `/blog` would have been cancelled and rendered the editor's "Nothing
  lives here" with the address bar still reading `/blog`. `scopeToBasePath` filters the
  navigation adapter, so off-prefix navigations never reach the router and the browser
  handles them. Containment is anchored at a segment boundary, so a prefix of `/cms` does
  not claim the host's `/cmsmedia`.

### Fixed

- **`RichText.astro` could not be compiled by Astro (`@pramen/cms-astro`).** The heading case
  computed its level inline in the template, and Astro's compiler scans a template expression
  for markup — so `attrs.level <= 6` was read as the start of a tag and failed the build
  outright (`Unable to assign attributes when using <> Fragment shorthand syntax`). The
  comparison moved to the frontmatter, where it is plain TypeScript. Found by the new example
  site, which is the first thing in this repo to put these components through `astro build`.

### Changed

- **`@pramen/cms-editor` builds two files, not a site.** `dist/editor.js` +
  `dist/editor.css`, both stably named and exported from the package; `index.html`,
  `config.js` and the separate `fonts.css` + `fonts/` are gone. The web font is inlined into
  the stylesheet, so it is one self-contained asset wherever a host's bundler re-hosts it.
  `bun run --cwd packages/cms-editor dev` still previews at <http://localhost:5175>, now from
  a shell it synthesizes rather than a file it ships.
- **The editor renders in NC Fontina.** Merging the two stylesheets settled an ordering bug:
  `index.html` linked `fonts.css` *before* `app.css`, and both declare `--font-sans` on
  `:root`, so the bundled font was downloaded and then never used. The font block now comes
  last, which is what `@podoba/tokens/fonts.css` documents.
- **A declared backend is not remembered by the browser.** With a shell that declares one,
  `baseUrl`/`tenant` come from the server on every load and only the session token is read
  from `localStorage` — a stale url from an earlier deployment can no longer outlive it.

### Removed

- **`window.PRAMEN_CMS_EDITOR.basePath`, reverted before release.** It landed after the
  0.0.52 tag and is gone again here, so no released version ever carried it.

  The idea survives; the level was wrong. A browser-side prefix cannot work while the editor
  ships its own `index.html`, because that shell can only reference `/editor.js`
  root-absolute — the one deployment shape the option existed for was the one shape it could
  not boot in. The mount prefix is now the constant the route was injected at, stamped onto
  the mount node by the same code that injected it, so a router mounted where the server
  does not serve is not a state that can be reached.

## [0.0.52] — 2026-08-30

### Added

- **OIDC login (`@pramen/auth`).** `createOidcAuth({ issuer, clientId, clientSecret, redirectUri,
  successRedirect })` adds the authorization-code + PKCE flow as pre-auth routes: discovery via
  `/.well-known/openid-configuration`, `state` + `nonce` held in KV and consumed
  read-and-delete, and the ID token verified through the same `JwksStrategy` the Worker uses,
  plus a nonce match binding it to the request that started it.

  It mints a **pramen session**, not a passthrough of the provider's token — that is what
  keeps `refreshSession`, the KV revocation denylist and role-in-token ACL working, instead
  of putting role resolution on every request's hot path. The session arrives in the
  redirect's URL **fragment**, which is never sent to a server.

  Roles differ per provider and getting them wrong fails silently as "everyone has no
  roles": Entra puts them in a top-level `roles` claim, Auth0/Okta in a namespaced one,
  Google Workspace ships none. So `mapRoles(claims)` makes the IdP authoritative where there
  is something to read (removals included); otherwise roles live on the user's row.

  Accounts key on the **verified** email by default, so an OIDC login lands on the same row
  as a magic-link or password login. An unverified address is refused rather than trusted or
  silently keyed on `sub` — a provider allowing arbitrary addresses would otherwise be a
  takeover path into an existing account. `accountKey: "sub"` namespaces by issuer instead.

  The verify-only path is unchanged: a frontend that already holds an IdP token still needs
  only `JWKS_URL`.

- **`ctx.callPrivileged` works on the D1 store.** A pre-auth route has no `ctx.db` and
  reached handlers by forwarding to a Durable Object, so everything built on such a route —
  signed preview links, the sitemap — was DO-only, and `@pramen/cms` had to refuse to mint
  preview links on D1 rather than hand out one that could never be redeemed. On D1 the
  engine runs in the Worker, so it now dispatches locally, through one shared `dispatchD1`
  that the request path uses too (migration, bootstrap, the multi-tenant guard and the
  outbox drain cannot drift between them).

  This is what makes D1 a first-class CMS store — and D1 is the only store that can live
  inside an Astro site's Worker, because it is a binding while a DO must be exported from
  the worker entry.

- **`pramenCms()` — an Astro integration for `@pramen/cms-astro`** (closes #35). One entry in
  `integrations` configures the backend; a `pramen:cms` virtual module exports the client,
  a bound `resolve()` and the generated collections, with types injected. `collections:
  "auto"` reads the store's content types at config time via a new public
  `listPublicContentTypes` (slug + name only) and **fails the build** if the CMS is
  unreachable, because zero collections would deploy an empty site green.

  Astro has no API for an integration to define content collections, so a site re-exports
  once: `export { collections } from "pramen:cms"`.

- **CMS locales are declared, not inferred.** `createCmsHandlers({ locales: ["cs", "en"] })`
  and `listCmsCapabilities` — the pages-side counterpart to a collection's `supports: [...]`.
  One locale means monolingual: no i18n chrome, and `locale` comes off the wire entirely so
  nothing can overwrite a field the editor no longer shows. `locales[0]` is the default
  stamp, derived rather than a second option that can disagree. Deliberately not inferred
  from the data: `createTranslation` is reachable only from the panel that would be hidden,
  so "show i18n once a second locale exists" could never become true.

- **A host-configurable wordmark in `@pramen/cms-editor`.** The editor ships as a package an
  agency installs for a client, so `brand: { name, suffix }` in `/config.js` replaces
  "pramen · cms" in the topbar, on the Setup screen and in the browser tab. Configuring
  nothing renders exactly as before.

### Fixed

- **A failed mutation on D1 now says it was partially applied.** D1 has no interactive
  transactions, so `transaction(fn)` runs `fn` as-is and a mutation that throws midway keeps
  what it wrote. That is unavoidable — pramen mutations interleave reads, writes, `RETURNING`
  and trigger-into-outbox, and `batch()` cannot read mid-batch — but it used to be invisible:
  a half-applied mutation looked exactly like an ordinary 500. The Worker now logs the
  handler and how many statements had committed.

- **A missing Cron trigger on the D1 store is no longer silent.** The DO self-drains via an
  alarm; D1 has none, so a delayed task — a scheduled publish, a retry backoff — runs only
  under a Cron trigger, and forgetting it meant the row simply never went live. The Worker
  warns once per isolate when a request-tail drain leaves a future-due task and no Cron drain
  has been seen, and stops once one fires.

- **`@pramen/cms` collection workflow (`supports`), from a review of #42.** Scheduling now
  converges in any drain order: a publish task draining after its own takedown instant lands
  the row **down** instead of publishing and discarding the takedown, and the takedown task
  spends the pending publish token so a late retry cannot resurrect the row. A reschedule can
  no longer move the publish past a pending takedown. Schedule epochs are range-checked, so
  an epoch-microseconds slip is a 400 rather than a `RangeError` 500, and a year-10000 value
  can no longer mint a timestamp that sorts before every real one.

  Revision history stopped leaking: `collectionListRevisions` projects each snapshot to the
  caller's readable fields (it returned the raw JSON from a flatly-granted table), restore
  writes back only that set, and `cmsPolicies` no longer grants update/delete on the
  append-only revisions table. The generic CRUD handlers gained input validation — an
  operator object where an id belongs returned an arbitrary row — and `collectionList` clamps
  its limit.

  `createCollectionHandlers` now requires your schema and validates the whole registry at
  boot: managed columns are checked for type, nullability and `hidden()` rather than by name
  alone; declared fields must be real columns that can hold their type; `orderBy` must name a
  real column (SQLite resolves an unknown quoted name to a *constant*, so a typo sorted every
  row equal, silently); the entity must be in the default partition; and two collections may
  not share an entity, since the ACL OR-merges their policies and would widen the public
  scope.

  The public read scope treats `publishedAt IS NULL` as published, so rows seeded or imported
  without a stamp no longer vanish the moment `scheduling` is enabled, and it grants
  `publishedAt` so "newest published first" stops 403ing for anonymous.

- **The collection editor can publish.** With `drafts` enabled there was no UI path at all —
  `collectionCreate` seeds `status: "draft"` and `collectionUpdate` strips `status` — so a row
  authored in the editor could never be made public. Adds publish/unpublish, a schedule
  picker, a preview link and a restorable revision list, all driven by `supports`.

### Removed

- **`embed` for `@pramen/cms-astro` and the Worker's `basePath`,** both reverted before
  release. `embed` generated a Worker entrypoint against a `dist/_worker.js` layout only
  `@astrojs/cloudflare` v12 emits; v13/v14 hand the build to `@cloudflare/vite-plugin` and
  emit no such file, so the generated entry could not resolve its first import. `basePath`
  had no other consumer and four defects that only surface once something is mounted —
  `/files` and `/media` were dead under a prefix, minted URLs did not know about it, and
  `basePath: "/"` 404'd everything. Both will return built against the current adapter.

## [Shipped, version unrecorded — between 0.0.15 and 0.0.51]

These entries sat under "Unreleased" while the file went untended. The work SHIPPED; which
release carried it was never recorded, so they are kept verbatim rather than assigned a
version they might not belong to.

### Added

- **Session revocation, without a session store.** Tokens are stateless (roles baked in at
  login), so a token used to outlive any change to the account behind it. Two mechanisms
  close that gap. **`refreshSession()`** (`@pramen/auth`, authenticated — in both
  `authHandlers` and `createMagicLinkAuth`) re-reads `roles`/`active` and reissues a token:
  refreshing at ~half-TTL keeps `AUTH_SESSION_TTL_SECONDS` short (bounding how long a stale
  role lingers) and picks up a role **grant** immediately — e.g. after a subscription
  checkout — with no re-login. It 401s for a deleted or deactivated account, so a refresh
  can't launder a revoked session into a longer-lived one. For hard revocation, a **KV
  denylist**: `setUserActive(false)` / `deleteUser` write `authDenied:<username>`, which the
  Worker checks right after resolving identity — before both the DO and D1 paths — and fails
  **closed** with 401 (never a silent downgrade to anonymous), covering HTTP and the
  WebSocket upgrade. The entry self-expires at the session TTL, so the list never grows;
  reactivation lifts it (the key is username-scoped and would otherwise block a fresh login).
  `denySession` / `allowSession` / `isSessionDenied` are exported from `@pramen/server` for
  app-driven revocation.

### Fixed

- **The admin dashboard rendered blank against any real deployment.** `GET /tenants`
  returns `DoRef[]` (`{tenant, partition}` — one entry per registered Durable Object),
  but `@pramen/admin` typed the call `string[]` and passed each entry straight to
  `<SelectItem>`. React throws on an object child, so the whole dashboard failed to
  render for anyone whose deployment had even one tenant, which is all of them. Present
  since the tenant picker was added and shipped through 0.0.44.

  The client now normalizes: tenant names are extracted, deduped (a tenant spanning
  several partitions is one choice in a picker that selects tenants) and sorted, so KV
  listing order cannot reshuffle the list. A plain `string[]` is still accepted — the
  admin is a client you point at arbitrary deployments, which need not run the version
  that built the bundle.

  The server side is unchanged: its shape carries the partition, and flattening it there
  would have been a lossy breaking change to fix a consumer's parse. The new test pins
  the contract by annotating the fixture with the server's own exported `DoRef` type, so
  a change to that shape now fails `bun run typecheck` instead of silently blanking the
  admin again.

- **`@pramen/auth` was unusable on Cloudflare.** Password hashing used 600k PBKDF2
  iterations (OWASP guidance), but workerd caps PBKDF2 at **100k** and throws rather than
  clamping — `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
  supported`. Every `signup` and `login` returned a 500 on any real deployment. New hashes
  are now written at the platform maximum, which is also the strongest KDF Workers offers
  (WebCrypto there has no scrypt or argon2). Lowering the count is safe because the
  iteration count is encoded in the stored string and read back on verify.

  This escaped the entire test suite because Bun — which runs the tests, and which
  `lopata` runs workers on — has no such cap, so the bug was reachable only by deploying.
  The new regression test therefore asserts the **number recorded in the stored hash**
  rather than any behaviour, since behaviour under Bun cannot tell 100k from 600k.

  Verification also gained a diagnosis: the count comes FROM the stored hash, so a row
  written at 600k by an earlier release (or by a Bun/Node deployment sharing a database
  with a Worker) can never be verified on Workers. That now raises an error naming the
  count, the cap and the remedies, instead of a bare `NotSupportedError` — or, if a caller
  swallowed it, a silent "wrong password" that locks the account out with nothing logged.
- **A live WebSocket could outlive its token.** The token was verified once at upgrade and
  the identity fixed for the life of the socket, so a long-lived or hibernating connection
  kept calling and receiving pushes indefinitely past `exp` — role changes and revocation
  only ever bit on reconnect. The DO now re-checks `exp` on every message: an expired socket
  gets an `unauthorized` error frame and is closed with **4401**, and expired sockets are
  dropped from the broadcast path instead of pushed to. `Identity` carries `exp` (a standard
  claim, so it needed explicit plumbing past the custom-claim passthrough); synthetic
  `callPrivileged` identities carry none and are never treated as expired.

- **`@pramen/client` `call()` no longer silently resolves `undefined`.** A 2xx response
  that isn't the `{ ok: true, result }` envelope (e.g. a trailing-slash base url routed to
  the Worker help page) now throws a `PramenError` with the status instead of resolving
  `undefined`. The base url is also normalized (trailing slash stripped) so `${url}/rpc`
  can't become `//rpc`.
- **`@pramen/client` D1 read-your-writes bookmark keeps the maximum**, not
  last-response-wins — a slower earlier response can no longer clobber a newer bookmark and
  regress read-your-writes under concurrency.
- **`@pramen/client` surfaces live-connection failures.** A missing WebSocket
  implementation, or a socket that keeps closing past `maxReconnectAttempts` (default 8),
  now fires a new optional `onConnectionError` subscribe callback instead of hanging
  forever behind a permanent loading state. Reconnect backoff gained jitter and only resets
  after the connection has stayed open a few seconds (no accept-then-close hot-loop).

### Changed

- **`pramen schema diff` now reports modifier and partition changes**, not just column
  types — `notNull`/`unique`/`primaryKey`/`generated`/`default`/`hidden` changes and
  entity partition moves are surfaced, each labeled `[NOT applied on boot]` because the
  boot migrator only rebuilds on a type change (partition moves need a manual cross-DO data
  migration).
- **Migration docs corrected:** destructive migrations are gated behind
  `PRAMEN_ALLOW_DESTRUCTIVE` (off by default), not auto-applied. Fixed the misleading
  "auto-applied" wording in the CLI, `schema diff`, and the README/docs.

## [0.0.14] — 2026-06-25

### Added

- **`ctx.queue` — native Cloudflare Queues.** A producer + consumer seam (the same shape
  as `ctx.mail`): `ctx.queue.send(binding, body, opts?)` / `sendBatch(...)` over a
  `QueueAdapter` (Cloudflare / in-memory), plus a consumer dispatch — register handlers in
  `app.queues` (keyed by queue name) and wire `createPramen(app).queue` as the Cloudflare
  `queue(batch, env)` entry. Distinct from `ctx.tasks` (the transactional outbox): a queue
  send is **not** transactional with the write, but gets platform-native batching, retry,
  and dead-letter, and a consumer that can run in another Worker. Sending to an undeclared
  queue fails closed.
- **D1 read replicas via the Sessions API.** The D1 store opens one `db.withSession()` per
  request: mutations anchor `first-primary` (reads see current data, writes go to the
  primary), queries `first-unconstrained` (nearest replica). Responses carry an
  `x-pramen-d1-bookmark` header that `@pramen/client` captures and replays for transparent
  **read-your-writes**. `PRAMEN_STORE=d1` makes the D1 path the app-wide default (the
  `x-pramen-store` header still overrides per request).

### Fixed

- **Reserved-word identifiers.** The DDL generator and migrator emitted bare identifiers,
  so a column or table named after a SQL keyword (`order`, `group`, …) broke the migration
  outright — and would have broken every read/write once created. All identifiers are now
  double-quoted through a single `quoteIdent` authority (DDL, the table-rebuild, reads, and
  writes). Backward-compatible — existing stores don't re-migrate.
- **Live queries under `PRAMEN_STORE=d1`.** The D1 default routed `/live` onto the D1 path
  and returned a `400` instead of falling through to the Durable Object — silently
  disabling live subscriptions. Live queries now always use the DO.
- **Unbound Durable Object.** A request routed to the DO with no DO bound crashed the whole
  RPC surface (`Cannot read 'get' of undefined`). It now returns a clear `400`, and
  `partitionStubFor` throws an actionable message pointing at the `x-pramen-store: d1`
  header.

### Documentation

- The `x-pramen-store: d1` **header is the reliable way to pin the D1 store** — a
  `PRAMEN_STORE` env default can be dropped by some adapters' `cloudflare:workers` env
  proxies (e.g. Astro's).
- A trailing-slash-enforcing framework (Astro `trailingSlash: 'always'`) 308-redirects
  `/rpc/*` and browsers drop the POST body on the redirect — use `'ignore'` / `'never'`
  for the API routes.

## [0.0.13] — 2026-06-23

### Added

- **Per-handler authorization.** `query` / `mutation` accept an `auth` option
  (`"authenticated"` | role list | `(identity) => boolean`), enforced before the handler
  runs — to gate handlers that reach `ctx.kv` / `ctx.env` / `ctx.mail` / `ctx.queue`
  directly (those bypass the row-level ACL).

## [0.0.12] — 2026-06-23

### Added

- **`ctx.mail` facade.** Send email through an adapter seam — Cloudflare Email Sending (the
  `EMAIL` / `send_email` binding, no API keys), with a dev capture mode and an in-memory
  adapter for tests. Available in handlers and task-drain contexts.

### Fixed

- `ctx.mail` **fails closed** when unconfigured, so a misconfigured production never
  silently stashes a security email; the example's dev inbox handlers are admin-gated.

## [0.0.11] — 2026-06-23

### Added

- **Declarative `$triggers`.** An entity may declare
  `triggers: [trigger({ task, on: { create?, update?, delete? } })]`; a matching ORM write
  auto-enqueues the task in the write's transaction — no `ctx.tasks.enqueue` in the handler.

### Fixed

- Closed the trigger security + production gaps from the audit: `hidden()` columns stripped
  from payloads, a loop guard for task-handler writes, value-change semantics on
  field-filtered updates, and fail-fast validation of trigger → task wiring.

## [0.0.10] — 2026-06-23

### Added

- **Deferred tasks — transactional outbox.** `ctx.tasks.enqueue({ kind, payload, delayMs? })`
  writes to an outbox table **atomically with the mutation**; a drainer runs the matching
  `app.tasks` handler after commit, off the write path. At-least-once with retry/backoff,
  dead-letter, and a `meta.id` idempotency key. The DO self-drains via an alarm; the D1
  store drains via a Cron Trigger (`createPramen().scheduled`).

### Fixed

- Production-hardened the outbox: claim-based concurrent drains (disjoint batches),
  retention pruning, and stale-claim reclaim.

## [0.0.9] — 2026-06-23

### Added

- `createUserHandlers({ table })` + `authPolicies(...)` — user management (admin + self)
  over any `authSchema`-shaped table.

### Fixed

- **Security:** magic-link login keys on the immutable `username`, not the mutable `email`
  — prevents account takeover and a PK-collision migration regression.

## [0.0.8] — 2026-06-23

### Added

- `@pramen/auth` user management (admin + self) plus hardening.

### Fixed

- `update` / `delete` / relation loads resolve the real primary key (not a hardcoded `id`),
  fixing entities whose PK isn't `id` (e.g. `auth_users`, PK = `username`); `hidden()`
  columns are stripped from every read projection.

## [0.0.7] — 2026-06-23

### Added

- Passwordless **magic-link login** (`createMagicLinkAuth`) via Cloudflare Email Sending.

### Fixed

- Publish: rewrite `workspace:*` dependency ranges to concrete versions before
  `npm publish` — the previously published `@pramen/react` / `@pramen/auth` shipped an
  unrewritten `workspace:*` dep and were uninstallable.

## [0.0.6] — 2026-06-23

### Changed

- Release-workflow / CI maintenance (GitHub Action version bumps); no library changes.

## [0.0.5] — 2026-06-22

### Added

- **SQL-expression column defaults** — `defaultTo(t.text(), expr.now())` / `expr.raw(sql)`,
  emitted unquoted and parenthesized in the DDL.

## [0.0.4] — 2026-06-22

### Added

- **Durable Object partitions.** An entity may declare a `partition` (the DO class it lives
  in); partition-aware routing, per-partition migrate + admin endpoints, a self-maintained
  `(tenant, partition)` registry, and static rejection of cross-partition relations.
- **`uuid` field type** — `t.uuid()` with `generated()` + `primaryKey()`, validated on write.

## [0.0.3] — 2026-06-22

### Fixed

- Relation-aware `WhereClause` for relationless entities; annotated release tags in the
  bump script.

## [0.0.2] — 2026-06-22

First published release — the foundational runtime:

- Schema + handlers + ORM over a `Driver` / `Dialect` substrate seam (DO SQLite + D1).
- Deny-by-default **ACL**: roles, policies, row-level scopes, cell-level field permissions,
  and dynamic resolvers.
- **Live queries** over Hibernatable WebSockets with row-level (digest-diff) invalidation.
- Additive **schema migrations** on boot; query operators, OR/AND, cursor pagination,
  count + aggregates.
- **File storage** on R2 (`fileRef` column + `ctx.files` signed URLs).
- `ctx.kv`, `ctx.env`, CORS, public pre-auth routes + an anonymous role.
- Tenant registry + authorization + point-in-time recovery; the admin data API and the
  `@pramen/admin` dashboard; `@pramen/auth` (credential → JWT) and the `@pramen/client` /
  `@pramen/react` clients.

_(The project was briefly named `mrak` during pre-release development.)_

[0.0.14]: https://github.com/netvarec/pramen/compare/v0.0.13...v0.0.14
[0.0.13]: https://github.com/netvarec/pramen/compare/v0.0.12...v0.0.13
[0.0.12]: https://github.com/netvarec/pramen/compare/v0.0.11...v0.0.12
[0.0.11]: https://github.com/netvarec/pramen/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/netvarec/pramen/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/netvarec/pramen/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/netvarec/pramen/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/netvarec/pramen/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/netvarec/pramen/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/netvarec/pramen/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/netvarec/pramen/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/netvarec/pramen/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/netvarec/pramen/releases/tag/v0.0.2
