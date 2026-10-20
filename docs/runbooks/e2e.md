# End-to-end tests (CI-006, #140)

The Playwright suite lives in `apps/web/e2e` and runs headless Chromium against the dev compose stack and
the local Juice Shop lab target. The workflow is `.github/workflows/e2e.yml`; its policy is checked by
`pnpm check:e2e` (`scripts/check-e2e.mjs`).

## When it runs

| Event | Runs |
|---|---|
| Pull request | Only when the PR carries the `run-e2e` label (adding the label starts a run). |
| Push to `main` | Always. |
| Nightly (02:23 UTC) | Always. |
| `workflow_dispatch` | On demand. |

The job has a 45-minute hard timeout and `contents: read` only. It uses no repository secrets: `pnpm dev:deps`
generates random dev credentials into the runner's untracked `.env`.

## Steps (same commands as local development)

```bash
pnpm dev:deps                 # core stack; never the `obs` profile
pnpm targets:up               # Juice Shop (profile `targets`, digest-pinned, 127.0.0.1 only)
node scripts/wait-for-health.mjs --timeout 300 postgres valkey keycloak juice-shop
pnpm db:migrate
pnpm db:seed && pnpm db:seed  # the second run proves the seed is idempotent
pnpm dev &                    # apps, logs in dev-apps.log
pnpm test:e2e
```

When a service does not become healthy, `wait-for-health` names it and prints its last log lines, with
credentials redacted.

## Suite layout and retries

- `specs/navigation/*.e2e.ts`: page loads of the lab target. The only project that retries (once), with a
  trace recorded on that first retry.
- `specs/flows/*.e2e.ts`: user flows (today: password sign-in and sign-out of a seeded Keycloak user in
  realm `blackwing-dev`, and a refused wrong password). No retries; a trace, video and screenshot are kept
  for every failure.
- Every URL the suite drives must be a loopback address (`apps/web/e2e/support/env.ts`); anything else
  fails before a browser starts. Tests run with `TZ=UTC` and the browser clock in UTC.

Console and run-launch flows join `specs/flows/` with the WEB and RUN epics, once the console exists.

## HTTPS and OIDC

The CI variant is plain HTTP on loopback: Keycloak at `http://localhost:18080` (its configured issuer host)
and Juice Shop at `http://127.0.0.1:13000`. Browsers treat `localhost` as a secure context, so OIDC cookies
work without TLS. To exercise the `*.bw.localhost` TLS hostnames instead, run `pnpm dev:tls` and
`pnpm targets:up --tls` and point `BW_TARGET_JUICE_SHOP_URL` at the HTTPS edge.

## Artifacts and debugging

On failure the job uploads `e2e-playwright`: `apps/web/playwright-report/` (HTML report),
`apps/web/test-results/` (traces, videos, screenshots, `results.json`) and `dev-apps.log`. The job summary
lists pass/fail counts and the failed or flaky tests. Open a trace with
`pnpm --filter @blackwing/web exec playwright show-trace <trace.zip>`.

Locally: `pnpm --filter @blackwing/web exec playwright install chromium` once, then the steps above.
