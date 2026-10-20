# Secret scanning (gitleaks)

CI-012 (#146). Enforces CONTEXT_PACK §8.7: secrets never reach the repository.

## What runs where

| Where | Command | Scope |
|---|---|---|
| Pre-commit hook (`.husky/pre-commit`) | `gitleaks protect --staged --redact --no-banner --config .gitleaks.toml` | Staged changes. Skipped with a notice when gitleaks is not installed. |
| CI, pull request (`.github/workflows/secret-scan.yml`) | `gitleaks detect --redact … --log-opts <base>..<head>` | Only the PR's commits, which keeps scans fast on a long history. |
| CI, push to `main` | the same, `<before>..<after>` | Only the pushed commits. Falls back to full history when `before` is unknown. |
| CI, weekly schedule (Mon 04:23 UTC) and manual dispatch | `gitleaks detect --redact …` | The full history. |

All of them use one ruleset, [`.gitleaks.toml`](../../.gitleaks.toml): the upstream default rules plus the
Blackwing rules for `bw_pat_` / `bw_ci_` / `bwk_` tokens, PEM and JWK private keys (service-account signing
keys), `BW_*SIGNING_KEY` assignments, OpenBao tokens and MinIO / Keycloak credentials. Every run passes
`--redact`, so neither the log nor the SARIF report contains a secret value. The job summary shows only
counts per rule (`scripts/gitleaks-summary.mjs`). The SARIF report goes to **Security → Code scanning**
(category `gitleaks`). PRs from forks get a read-only token, so they can't upload SARIF. The scan still
gates those PRs. A non-allowlisted finding fails the job.

The `ruleset-selftest` job runs `scripts/secret-scan.test.mjs` against the real binary. A planted fake
`bw_pat_` token must fail, allowlisted fixtures must pass, output must stay redacted, PR scans must be
scoped to the diff, and the repository's own history must stay clean. Run it locally with
`node --test scripts/secret-scan.test.mjs`. It needs `gitleaks` on `PATH` or `GITLEAKS_BIN`.

## A finding fails my PR

1. **If the value is real, rotate it first.** Revoke the token or key at its source: the Blackwing API
   token, OpenBao, MinIO, Keycloak, or the cloud provider. Removing the commit does not un-leak a secret
   that was pushed.
2. Remove it from the branch: amend or rebase your own unpublished commits. Never force-push `main`.
   Load the value from `@blackwing/config` or the secrets service instead.
3. If it was already on `main`, open a security incident (see [`SECURITY.md`](../../SECURITY.md)). Do
   the rotation, then decide with the security owners whether the history needs rewriting.

## Historical findings (weekly full-history scan)

The scheduled scan reports secrets that are already in the history. Treat each one as leaked. Rotate it,
record the rotation in the incident, and then handle the finding. Either the history is rewritten
(security owners decide), or a fingerprint goes into a `.gitleaksignore` file that is reviewed like the
allowlist. Do this only after rotation.

## False positives and test fixtures

- Generate fake secrets at runtime in tests where you can. `scripts/secret-scan.test.mjs` shows how.
- Otherwise put an intentional fixture under `scripts/fixtures/gitleaks/allowed/`, or add a narrow path
  or regex to the `[allowlist]` in `.gitleaks.toml`. Give every entry a comment that justifies it.
- `.gitleaks.toml` is security-owned in [`CODEOWNERS`](../../.github/CODEOWNERS), so allowlist changes
  get a security review. Keep the allowlist minimal and never allowlist a whole directory of product
  code.

## Upgrading gitleaks

CI pins `GITLEAKS_VERSION` and the tarball's `GITLEAKS_SHA256` (from the release's `checksums.txt`) in
the workflow. Bump both together. The config uses the v8 schema (`[extend]`, `[[rules]]`, global
`[allowlist]`), so older v8 builds that developers have installed still load it.
