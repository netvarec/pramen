---
name: release
description: Cut and publish a pramen release — bump all @pramen/* packages in lockstep, tag, and push to trigger npm publishing. Use when the user says "release", "cut a release", "publish to npm", "bump the version", or "ship vX.Y.Z".
---

# Releasing pramen

All five `@pramen/*` packages publish to npm **in lockstep** (one shared version):
`@pramen/server`, `@pramen/client`, `@pramen/react`, `@pramen/auth`, `@pramen/admin`.

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

`bun run bump` (`scripts/bump.ts`) does it all: rewrites the `version` in all five
`package.json`s, commits `release: vX.Y.Z`, and creates the `vX.Y.Z` tag. It **refuses
a dirty working tree** — the bump must be its own commit.

## Steps to drive a release

1. **Confirm the bump type.** If the user didn't say `patch`/`minor`/`major` or an
   explicit version, ask. While < 1.0.0, default to `patch` for fixes, `minor` for
   features. Pre-release: pass an explicit version like `0.3.0-beta.1`.

2. **Preflight** — all must hold before bumping:
   - On `main`, clean tree, synced with `origin/main`:
     ```bash
     git rev-parse --abbrev-ref HEAD && git status --porcelain && git fetch origin && git log --oneline origin/main..HEAD
     ```
   - CI is green on the commit you're releasing (the same gates run again in
     `release.yml`, but catch failures locally first):
     ```bash
     bun run typecheck && bun test
     ```
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
   On success, confirm the new version is live, e.g. `npm view @pramen/server version`.

## Notes & gotchas

- **Lockstep is intentional** — every package ships the same version, even ones with
  no changes. For independent per-package versions + changelogs you'd graduate to
  changesets; don't hand-edit individual versions out of lockstep.
- **Adding a new `@pramen/*` package to the release set:** add it to the `PKGS` array
  in **both** `scripts/bump.ts` and `scripts/publish.ts` (`publish.ts` lists them in
  dependency order: `client → server → react → auth → admin`). It then joins on the
  next tag without forcing a version change of the rest (publish skips already-live
  versions).
  - **Critical npm-side prerequisite (do this BEFORE the first release that includes
    the new package):** on npmjs.com, configure the package's **Trusted Publisher**
    (Settings → Trusted Publisher → GitHub Actions: repo `netvarec/pramen`, workflow
    `release.yml`, no environment) — matching the existing packages. Without it, the
    OIDC publish is rejected with **`E404` "could not be found or you do not have
    permission"** (npm returns 404, not 403, for an unauthorized trusted-publish), and
    the run dies at that package — the ones before it in dependency order still
    publish, leaving the registry out of lockstep. For a brand-new scoped package the
    name must also exist first (or have a *pending* trusted publisher configured); this
    is a manual, owner-only step that cannot be done from CI. After fixing it, just
    re-run the failed job (`gh run rerun <run-id> --failed`) — no new version needed.
- **Manual trigger:** `release.yml` also has `workflow_dispatch` — re-run from the
  Actions tab (or `gh workflow run release.yml`) without a new tag, e.g. to retry a
  failed publish on the same version.
- **Local publish** (`bun run release` = build + `scripts/publish.ts`) works only if
  you're authenticated to npm locally; the normal path is CI/OIDC. Don't reach for it
  unless CI publishing is unavailable.
- **Tag = source of truth.** If a bump commits but the push fails, the tag already
  exists locally — fix the issue and `git push --follow-tags` again rather than
  re-bumping (which would skip to the next version).

