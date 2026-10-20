# CodeQL static analysis (CI-013)

`.github/workflows/codeql.yml` analyses `javascript-typescript` (no build) and `go` (manual build via
`make build` in `apps/egress-gateway`, same toolchain pin as `go.yml`). It runs on pull requests, pushes to
`main`, a weekly schedule (Mon 03:17 UTC) and manually. Queries: `security-and-quality`
(`.github/codeql-config.yml`), scoped to `apps/` and `packages/`; tests and fixtures are excluded.
SARIF is uploaded to code scanning; the job holds `security-events: write` and nothing broader.

## Blocking on HIGH/CRITICAL

Enable in the repo ruleset: "Require code scanning results" with CodeQL, alerts threshold
"High or higher" (security severity) and "Errors". This is a repo setting, not workflow code.

## Triage

Review alerts in the Security tab. Dismiss only with a reason (false positive / used in tests / won't fix);
dismissals are recorded in the audit log. Tune noise in the config file, not by disabling languages.

## Checks

`pnpm check:codeql` validates the workflow and config policy (languages, triggers, pins, permissions).

## Smoke (online)

Push a scratch branch containing a known-bad pattern (for example `child_process.exec` with request input)
and verify an alert for each language. Tracked in the online-porting issue #875.
