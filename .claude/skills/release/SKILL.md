---
name: release
description: Cut and publish a pramen release — bump all @pramen/* packages in lockstep, tag, and push to trigger npm publishing. Use when the user says "release", "cut a release", "publish to npm", "bump the version", or "ship vX.Y.Z".
---

# Releasing pramen

Every `@pramen/*` package publishes to npm **in lockstep** (one shared version). The list
lives in `scripts/packages.ts` (`PUBLISH_PKGS`) — read it, don't hardcode it here or
anywhere else:

```bash
grep -A 20 'PUBLISH_PKGS = \[' scripts/packages.ts
```

(This file used to name the packages inline and said "all eight". The set grew to nine when
`@pramen/analytics` landed and the list here silently went stale — including the
verification loop in step 5, which then checked eight of nine and would have reported a
partial publish as a complete one. That is the same drift `assertNoPackageDrift` exists to
catch in code; this document is not exempt from its own rule.)

Publishing is **CI-driven via a version tag**. You do not run `npm publish` by hand —
pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which typechecks,
tests, builds, and publishes via npm **OIDC trusted publishing** (no token, automatic
provenance). The publish step (`scripts/publish.ts`) is idempotent: it skips any
package whose version is already on the registry, so a re-run after a partial failure
is safe.

## The flow

```bash
bun run bump patch        # 0.0.2 -> 0.0.3   (or: minor | major | explicit X.Y.Z)
git push --follow-tags    # pushes the release commit + tag -> triggers publish
```

`bun run bump` (`scripts/bump.ts`) does it all: rewrites the `version` in every
`PUBLISH_PKGS` `package.json`, commits `release: vX.Y.Z`, and creates the `vX.Y.Z` tag.
It **refuses a dirty working tree** — the bump must be its own commit.

## Steps to drive a release

1. **Confirm the bump type.** If the user didn't say `patch`/`minor`/`major` or an
   explicit version, ask. While < 1.0.0, default to `patch` for fixes, `minor` for
   features. Pre-release: pass an explicit version like `0.3.0-beta.1`.

2. **Preflight** — all must hold before bumping:
   - On `main`, clean tree, synced with `origin/main`:
     ```bash
     git rev-parse --abbrev-ref HEAD && git status --porcelain && git fetch origin && git log --oneline origin/main..HEAD
     ```
   - Local gates pass (the same ones run again in `release.yml`, but catch failures
     here first):
     ```bash
     bun run typecheck && bun test
     ```
   - CI is green on the exact commit you're releasing:
     ```bash
     gh run list --limit 5 --json conclusion,name,headSha -q '.[] | "\(.conclusion)\t\(.name)\t\(.headSha[0:7])"'
     ```
     If a local gate is red but CI is green on that commit, **stop and diagnose before
     bumping** — don't assume it's environmental. Report the specific test and root
     cause to the user and let them decide. (Precedent: the `pramen init` scaffold test
     used to resolve `@pramen/server` via Bun auto-install, so it asserted against the
     last *published* package over the network and went red on a cold cache. Fixed by
     linking the repo's `node_modules` into the temp dir.)
   - Optionally preview the plan: `bun run bump <type> --dry-run` (changes nothing).

3. **Bump** (creates the commit + tag locally):
   ```bash
   bun run bump <type>
   ```

4. **Push to publish:**
   ```bash
   git push --follow-tags
   ```
   Then **confirm the tag actually reached the remote** — the workflow triggers on the
   tag, not the commit, so a tag that didn't push means nothing publishes:
   ```bash
   git ls-remote --tags origin v<X.Y.Z>
   ```
   (`bump.ts` creates an *annotated* tag so `--follow-tags` pushes it. If it ever comes
   up empty, push it explicitly: `git push origin v<X.Y.Z>`.)

5. **Watch the publish.** The tag push runs the `release` workflow. Monitor it and
   report the outcome:
   ```bash
   gh run watch $(gh run list --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId') --exit-status
   ```
   On success, confirm **every** package is live at the new version — a partial publish
   leaves the registry out of lockstep, and checking just one hides it:
   ```bash
   bun -e 'import { PUBLISH_PKGS } from "./scripts/packages";
   for (const dir of PUBLISH_PKGS) {
     const { name } = await Bun.file(`${dir}/package.json`).json();
     const r = await Bun.$`npm view ${name} version`.quiet().nothrow();
     console.log(`${name.padEnd(22)} ${r.stdout.toString().trim() || "(not published)"}`);
   }'
   ```
   Driven off `PUBLISH_PKGS` so it cannot check a stale subset.

   **A package reading one version behind is not necessarily a failed publish.**
   `@pramen/cms-astro` in particular takes npm's ASYNC publish path — the log says
   `npm notice Your package is being processed and may take a few minutes to become
   available` and `+ @pramen/cms-astro@X`, and the registry 404s for up to a few minutes
   after. Poll before concluding anything:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/@pramen%2Fcms-astro/<X.Y.Z>
   ```
   Tell the two apart by the RUN LOG, never by the registry alone: a real gap shows an
   `npm error` for that package, a lag shows `+ @pramen/<name>@<version>`. In 0.0.62 the
   two looked identical from outside and only the log distinguished them.

## Notes & gotchas

- **Lockstep is intentional** — every package ships the same version, even ones with
  no changes. For independent per-package versions + changelogs you'd graduate to
  changesets; don't hand-edit individual versions out of lockstep.
- **Adding a new `@pramen/*` package to the release set:** add it to `PUBLISH_PKGS` in
  **`scripts/packages.ts`** — the single source of truth both `bump.ts` and
  `publish.ts` import. Keep it in **dependency order** (a package after anything it
  depends on); `publish.ts` publishes in that order, `bump.ts` is order-insensitive.
  It then joins on the next tag without forcing a version change of the rest (publish
  skips already-live versions).
  - `assertNoPackageDrift()` runs at the top of both scripts and **fails the bump or
    publish** if any non-private `packages/*` workspace is missing from the list — so
    a new package can't be silently left out of a release (which is exactly how
    `cms`/`cms-astro`/`cms-editor` got skipped once). A package opts out of publishing
    with `"private": true` in its `package.json`.
  - **Put a brand-new package LAST in the list, not merely after its dependencies.**
    Order exists so a package is published after anything it depends on, and
    `publish.ts` resolves `workspace:` ranges from the versions ON DISK, so ordering
    never affects correctness of the rewrite — only which packages a mid-run failure
    blocks. A new package's npm-side credentials are the least proven thing in the set,
    so anything ahead of the established packages converts its own failure into theirs.
    `@pramen/analytics` was placed after `packages/cms` in 0.0.69 and took
    `cms-astro`/`cms-editor`/`admin` down with it.
  - **Critical npm-side prerequisite (do this BEFORE the first release that includes
    the new package):** on npmjs.com, configure the package's **Trusted Publisher**
    (Settings → Trusted Publisher → GitHub Actions: repo `netvarec/pramen`, workflow
    `release.yml`, no environment) — matching the existing packages. **A trusted
    publisher has a per-publisher PERMISSION as well as an identity:** `npm stage
    publish` is always allowed, and direct `npm publish` is a separate opt-in checkbox
    ("Choose whether this trusted publisher can also publish directly"). This pipeline
    publishes directly, so that box must be ticked. npm's docs recommend stage-only as
    the more secure default, so a publisher configured fresh today will NOT have it.
    Read the failure carefully — the two are different faults:
      - **`E403` "OIDC permission denied for this action"** — the publisher EXISTS and is
        trusted; the *action* is not allowed. Tick "can also publish directly". Adding a
        second trusted publisher will not help, and looking for a missing one wastes the
        outage. (0.0.69 hit exactly this and was misdiagnosed as a missing publisher.)
      - **`E404` "could not be found or you do not have permission"** — no publisher
        matches (npm answers 404, not 403, for an unrecognized trusted-publish).
    Either way the run dies at that package and the ones before it in dependency order
    stay published, leaving the registry out of lockstep. For a brand-new scoped package
    the name must also exist first, or have a *pending* trusted publisher configured —
    which is the better route, since publishing once by hand to create the name produces
    a version with no provenance that sits on the registry forever. This is manual and
    owner-only; it cannot be done from CI. After fixing it, re-run the failed job
    (`gh run rerun <run-id> --failed`) — `publish.ts` skips what is already live, so no
    new version is needed.
  - **Staged publishing exists and this pipeline does not use it.** `npm stage publish`
    submits a version for a maintainer to approve with 2FA (`npm stage approve <id>`)
    before it goes live. Adopting it is a workflow change, not a config tweak: it needs
    **npm ≥ 11.15.0** (the workflow pins 11.5.1 on purpose — `npm@latest` once shipped
    without bundled `sigstore` and broke the v0.0.15 publish) and **Node ≥ 22.14.0**, a
    switch from `npm publish` in `scripts/publish.ts`, and a human approval step per
    release. Don't improvise it mid-release.
- **Manual trigger:** `release.yml` also has `workflow_dispatch` — re-run from the
  Actions tab (or `gh workflow run release.yml`) without a new tag, e.g. to retry a
  failed publish on the same version.
- **Local publish** (`bun run release` = build + `scripts/publish.ts`) works only if
  you're authenticated to npm locally; the normal path is CI/OIDC. Don't reach for it
  unless CI publishing is unavailable.
- **Tag = source of truth.** If a bump commits but the push fails, the tag already
  exists locally — fix the issue and `git push --follow-tags` again rather than
  re-bumping (which would skip to the next version).

