# Dependency review (CI-014)

`.github/workflows/dependency-review.yml` runs `actions/dependency-review-action` on every pull request.
Policy lives in `.github/dependency-review-config.yml`. Make the `dependency-review` job a required status
check on `main` so supply-chain regressions cannot merge.

- **Vulnerabilities:** `fail-on-severity: high` blocks HIGH and CRITICAL advisories on any added dependency.
- **Licenses:** an explicit `deny-licenses` list implements the CONTEXT_PACK §5 license-review gate (nmap NPSL,
  AGPL, SSPL, BUSL, Commons Clause). No `allow-licenses` list is used, so permissive licenses are never blocked
  by omission. Licenses the action cannot detect are listed in the PR summary under "unknown"; reviewers must
  resolve them manually. Adding a denied license needs legal sign-off first, then an edit to the config.
- **Comment:** `comment-summary-in-pr: always` posts added/removed dependencies and findings. The job has only
  `contents: read` plus `pull-requests: write` (comment). Pull requests from forks get a read-only token, so
  the comment is skipped there but the check still fails or passes.
- **Monorepo:** the action diffs every manifest and lockfile (all `package.json`, `pnpm-lock.yaml`, `go.mod`).
- **Transitive and images:** the lockfile diff covers transitive npm deps; container images are scanned by Trivy (CI-009).

`pnpm check:dependency-review` validates the policy files (severity, deny-list, permissions, SHA pin).
