# Release runbook (CI-016)

Workflow: `.github/workflows/release.yml`. Config: `release.config.mjs`. Helper: `scripts/release.mjs`.

## Decision: one repository version (v1)

Runs record exact versions (§8.9), so a release is one version, one tag and one set of digest-pinned images.
The whole repository has a single version `vX.Y.Z`; per-package versioning (Changesets) is deferred until a
package is published on its own, because nothing is published to npm in v1. semantic-release with the
`conventionalcommits` preset computes it from the commit messages that commitlint already enforces. The
changelog is written only by the release bot on `main` (with `[skip ci]`), so it cannot conflict with
feature branches.

## How a version is chosen

| Commit on `main` | Bump |
| --- | --- |
| `feat: ...` | minor |
| `fix: ...`, `perf: ...`, `revert: ...` | patch |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major |
| `chore`, `docs`, `ci`, `test`, `build`, `refactor`, `style` | none |

The highest bump since the last `v*` tag wins. With no releasable commit, the run exits cleanly and no tag is
created. The first release is `1.0.0`.

## What a release does

1. `release` job (push to `main`, or manual dispatch): semantic-release computes the version, commits
   `CHANGELOG.md` as `chore(release): X.Y.Z [skip ci]`, tags `vX.Y.Z` and creates the GitHub Release with notes.
2. The same job dispatches `build-images` on the tag, so every image carries the release version and a digest.
3. `release-record.json` (version, commit, digest-pinned image references) is attached to the Release and
   written to the run summary. It is the record §8.9 uses to pin versions.

Releases are serialised by the `release` concurrency group (no cancel), so concurrent merges release in order.

## Pull-request dry run

The `dry-run` job in the same workflow runs `node scripts/release.mjs plan` and prints the next version in the
job summary. It needs no secrets, creates no tag and runs on fork PRs. Run it locally with
`node scripts/release.mjs plan`.

## Enabling it online

Publishing is off until the repository variable `BW_ONLINE` is `true` (online-porting #874). It also needs the
secret `BW_RELEASE_TOKEN`: a fine-grained token with Contents write and Actions write on this repository only,
allowed to push to `main` through branch protection. Revert changes with a `revert:` commit, never by deleting a
tag.
