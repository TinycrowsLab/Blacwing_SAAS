# Renovate dependency policy

Renovate keeps dependencies current under the pinning rules that support the per-run version
pinning invariant (CONTEXT_PACK §8.9, F37). The policy lives in [`renovate.json`](../../renovate.json).
Renovate itself runs as the Renovate GitHub App, not from this repository.

## Policy

| Rule | Setting |
|---|---|
| Versions | `rangeStrategy: pin`: exact versions only, no ranges. |
| Digests | `pinDigests: true`, with explicit rules for the `docker` datasource and `github-actions`. |
| Groups | `typescript`, `eslint`, `nestjs`, `next`, `testing`, `go` (gomod), `docker` (Dockerfile, compose), `github-actions`. |
| Schedule | Weekly, `before 6am on monday` UTC. Caps: 5 open PRs, 2 new PRs per hour, 8 branches. |
| Release age | New releases wait 3 days (`minimumReleaseAge`). Vulnerability fixes skip the wait. |
| Automerge | Off globally. On only for `patch` updates and `lockFileMaintenance`, and only after the required checks pass. Majors and GitHub Actions digests never automerge (the last matching rule wins). |
| Vulnerabilities | `vulnerabilityAlerts` plus `osvVulnerabilityAlerts`: raised at any time, labelled `security`. |
| Commits | Conventional Commits: `chore(deps): ...`. |
| Dashboard | The "Dependency dashboard (Renovate)" issue lists pending and rate-limited updates. |

## Checking changes

- `pnpm check:renovate` asserts the policy above (pins, digests, groups, automerge limits, caps).
- `npx --package renovate@44.171.5 renovate-config-validator --strict renovate.json` validates
  the schema. The `renovate-config` workflow runs both on every change to `renovate.json`.

## Operating notes

- Automerge needs branch protection with required status checks on `main`. Without them,
  Renovate falls back to opening a PR. Do not weaken the automerge rules to compensate.
- The `dependencies`, `security` and `major` labels must exist (`security` is in the label catalogue;
  Renovate creates the other two on first use).
- The `scope` in `chore(deps)` is fixed. If commitlint (FOUND-006) restricts scopes to workspace
  members, add `deps` to its allowed list rather than changing this config.
