# Trivy scanning (CI-009)

Two places scan with Trivy:

- `.github/workflows/trivy.yml` scans the repository (`fs`: dependency vulnerabilities plus Dockerfile/IaC
  misconfiguration; helm and tofu are covered as INFRA lands). Runs on pull requests, pushes to `main`, daily
  (new advisories) and manually.
- The `trivy` job in `.github/workflows/build-images.yml` scans every image by its immutable digest from
  `images.json` (never a tag). It is online-only (`vars.BW_ONLINE == 'true'`, main and `v*` tags) because it pulls
  from GHCR; see porting issue #874.

Both run two passes: SARIF to code scanning (Security tab, `security-events: write` only, category
`trivy-fs` / `trivy-image-<service>`) with exit code 0, then a gate with `--severity HIGH,CRITICAL
--ignore-unfixed --exit-code 1`. The vulnerability DB is cached by the action and downloaded with a registry
fallback; a failed download fails the job (never "no findings"). Per-scan severity counts go to the job summary.

## Allowlist (`.trivyignore`)

Owned by security owners via CODEOWNERS. Each entry is a block with a reason, an expiry comment and the id with
the matching `exp:` date (see the file header). Expiry must be in the future and at most 180 days ahead.
`node scripts/check-trivy.mjs ignore` fails the build on an expired, undated or unjustified entry. Prefer
fixing the dependency; revisit unfixed findings periodically.

## Checks

- `pnpm check:trivy` validates the allowlist and the workflow wiring (unit tests run in `pnpm test:scripts`).
- `pnpm test:trivy` is the integration check (needs the `trivy` binary and network for the DB): a seeded fixable
  HIGH vulnerability fails the gate, an allowlisted one with a future expiry passes, an expired one fails.
