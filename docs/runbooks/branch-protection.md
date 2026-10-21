# Branch protection and required status checks

Policy for `main` (CI-015, #153). It supports [CONTEXT_PACK §8](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch)
items 4 (separation of duties), 8 (auditable, protected history) and 9 (pinned versions): nothing reaches `main`
without review, green supply-chain checks and immutable history.

## Where the policy lives

| File | Holds |
|---|---|
| [`.github/required-checks.json`](../../.github/required-checks.json) | The one list of required check names, each tied to the workflow that produces it. |
| [`.github/rulesets/main.json`](../../.github/rulesets/main.json) | The full repository ruleset for `main`, committed for reproducibility and audit. |
| [`scripts/apply-branch-protection.mjs`](../../scripts/apply-branch-protection.mjs) | Verifies, checks and applies the ruleset. |

## The ruleset

| Rule | Setting |
|---|---|
| Target | `refs/heads/main` only. |
| Deletion | Blocked. |
| Force-push (`non_fast_forward`) | Blocked. |
| Linear history | Required (squash or rebase merges only). |
| Pull request | 1 approval minimum, stale approvals dismissed on new pushes, the latest push must be approved by someone else, every conversation resolved before merge. |
| Code owner review | Required once the CODEOWNERS teams are active (see below). |
| Status checks | The list below, and the branch must be up to date with `main` (`strict`). |
| Signed commits | Optional: pass `--require-signatures` to add `required_signatures`. |
| Bypass | None. Administrators are subject to the ruleset, including for the security-owned paths. |

## Required checks

| Check | Workflow | Notes |
|---|---|---|
| `required-checks` | `pr.yml` | Always-running aggregator over `changes`, `lint`, `typecheck`, `commitlint` and `boundaries`. Fails if any of them failed or was cancelled; skipped is fine. |
| `lint`, `typecheck`, `commitlint` | `pr.yml` | Skipped on docs-only change sets (the classifier fails closed). A skipped required check counts as passing. |
| `unit`, `integration`, `isolation` | `test.yml` | Vitest with coverage; Testcontainers integration tests; the cross-tenant isolation gate (`pnpm test:isolation`). |
| `go` | `go.yml` | Always-running aggregator. A `gate` job decides whether Go code changed; `egress-gateway` runs only then. `go` passes when that job passed or was skipped and fails when it failed. |
| `gitleaks` | `secret-scan.yml` | Secret scanning. |
| `drift` | `drift.yml` | Generated-artifact drift. |
| `dependency-review` | `dependency-review.yml` | Dependency and licence gate. |

CodeQL (`analyze (javascript-typescript)`, `analyze (go)`) is listed under `notRequired` in the JSON: it is skipped on
docs-only changes and gated by the code-scanning ruleset, tracked in #875.

### Check-name drift and deadlocks

- A required check name must equal the job name exactly. `pnpm check:branch-protection` fails when a name in
  `required-checks.json` has no matching job in its workflow, when a mandatory check is missing, or when
  `main.json` no longer matches `required-checks.json`. Renaming a job therefore means editing the JSON in the same change.
- A path-filtered workflow that does not start leaves its required check pending forever, which blocks the merge.
  Never put `paths:` on a workflow that produces a required check. Use the pattern in `go.yml`: run always, decide in a
  `gate` job, and require the aggregator job.
- To add a conditional job, add it to an aggregator's `needs`. Do not require it directly.

## Code owner review

Paths that must get CODEOWNERS review: `apps/egress-gateway/**`, `packages/policy/**`, `packages/crypto/**`,
`.trivyignore`, `.gitleaks.toml` (plus the other security-owned paths in `.github/CODEOWNERS`).

The script sets `require_code_owner_review` to `true` only when every owner in the registry in
[`code-owners.md`](code-owners.md) has status `active`. While the teams are placeholders (online porting #842), a
required review nobody can give would block every merge, so the flag stays off and a repository admin reviews
security-owned paths by hand. When #842 lands: mark the owners `active`, run
`node scripts/apply-branch-protection.mjs --print > .github/rulesets/main.json`, commit, then `--apply`.

## Applying

The script needs an admin PAT or GitHub App token with repository administration, supplied at run time as
`BW_GITHUB_ADMIN_TOKEN`. It is never committed, never read from a file and never printed.

```bash
pnpm check:branch-protection                       # offline: files vs workflows (also runs in CI)
export BW_GITHUB_ADMIN_TOKEN=...                   # from your password manager
node scripts/apply-branch-protection.mjs --check   # live drift check, exit 1 on drift or missing
node scripts/apply-branch-protection.mjs --apply   # create or update; prints the resulting ruleset as JSON
```

`--apply` is idempotent: it finds the ruleset named `main-protection`, compares the managed fields and only writes
when they differ (`created`, `updated` or `unchanged` is printed with the live ruleset). It refuses to touch the live
repository while the committed files disagree with each other. Use `--repo owner/name` for a scratch repository.

## Drift detection

Run `--check` on a schedule or before releases with a read-capable admin token. A manual change in the GitHub UI shows
up as `drift`; `--apply` restores the committed state.

## Verification status

Offline, the tests run the full apply, idempotence, drift and repair flow against an in-memory fake of the rulesets
API. Proving that GitHub itself rejects a pull request with a missing check and a force-push to `main` needs a scratch
repository and an admin token: online porting issue #897.
