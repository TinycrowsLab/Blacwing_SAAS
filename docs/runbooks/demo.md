# Demo runbook (`pnpm demo`)

Localhost demo of the Blackwing console for a stakeholder walkthrough. Code: `scripts/demo.mjs`.
This is a development setup: demo-only secrets, a demo database and a lab target. Never run it against
production data.

## Start

```sh
pnpm dev:deps      # once: Postgres, Keycloak, Valkey, Temporal, ... (the demo calls it if they are down)
pnpm demo          # idempotent: deps, demo database, migrations, seed, lab, API, worker, web
pnpm demo status   # what is running
pnpm demo stop     # stop the API, worker and web started by the demo
```

Pre-pull the lab image once so `up` does not wait on the download: `docker pull bkimminich/juice-shop`.

After pulling changes that add a migration, run `node scripts/demo.mjs stop && node scripts/demo.mjs up`; `up` applies
the migration and re-seeds the persona names.

`pnpm demo` prints the URLs and the demo users when it is up. Logs are in `.demo/logs/` (api.log, worker.log,
web.log). Pids are in `.demo/pids.json`. Both directories are gitignored.

## What the script does

1. Brings up the dependency stack with `pnpm dev:deps` only when Postgres or Keycloak is not healthy.
2. Starts the Juice Shop lab (`DEMO_LAB_IMAGE`, default `bkimminich/juice-shop`) on `127.0.0.1:3001`
   (`DEMO_LAB_PORT`) when Docker is available. Without Docker it warns and continues; register any authorised URL in
   the console instead. `node scripts/demo.mjs lab` starts the lab alone. Once the API is healthy, `up` waits for the
   lab and registers it as the verified asset **Juice Shop lab** (idempotent: an existing asset for that origin is
   reused). A failure there is a warning, never fatal.
3. Creates the database `blackwing_demo` on the dev Postgres. It does not share `blackwing` with other
   worktrees, whose migration journals differ from this checkout.
4. Runs the migrations and `pnpm db:seed` against `blackwing_demo`. The seed skips tables that are not merged
   yet and logs `seed.skipped`, so the console still starts.
5. Starts the API (`127.0.0.1:13400`), the worker (health `:13800`), the **AI hunt runner** (`demo-runner`,
   `apps/worker/src/demo`) and the web app (`DEMO_HOST`, default `127.0.0.1`, port `3000`).

The script writes `.env.demo` on first run. It holds a demo-only `BW_WEB_SESSION_SECRET`. Overrides:
`DEMO_HOST` (bind address), `DEMO_PUBLIC_ORIGIN` (public URL), `DEMO_WEB_PORT`, `DEMO_LAB_PORT`.

Optional webhook: add `BW_DEMO_WEBHOOK_URL=<Slack incoming webhook or any receiver>` to `.env.demo` (every service
inherits it) and restart. Each released finding is then posted as Slack-compatible JSON (`{"text": ...}`) and the
result is shown on the finding page. Unset, nothing is sent. Never paste the URL into chat or tickets.

## Expected results

| Check | Expected |
|---|---|
| `curl -s http://127.0.0.1:13400/health/live` | HTTP 200 |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/login` | 200 |
| `curl -s -o /dev/null -w "%{redirect_url}" http://127.0.0.1:3000/api/auth/login` | Keycloak `.../realms/blackwing-dev/protocol/openid-connect/auth?...client_id=bw-console-bff` |

Open `http://localhost:3000/demo` (the bare origin redirects there), which redirects to the Keycloak login. The sign-in form is the realm
`blackwing-dev`.

## Credentials

| Role in the story | Keycloak user | Realm roles / group |
|---|---|---|
| Requester (operator) | `appsec@acme.test` | appsec-engineer, `/acme/appsec-engineers` |
| Approver | `owner@acme.test` | asset-owner, `/acme/asset-owners` |
| Viewer | `auditor@acme.test` | auditor, `/acme/auditors` |
| Platform operator | `operator@blackwing.test` | platform-operator (separate realm path) |

The password is `BW_DEV_KEYCLOAK_TEST_USER_PASSWORD` in the repository `.env`. Print it locally with
`grep BW_DEV_KEYCLOAK_TEST_USER_PASSWORD .env`. Do not paste it into chat or tickets.

## Sign in with Google (optional)

Google is brokered by Keycloak only. The app never talks to Google. The `google` identity provider lives in the
realm `blackwing-dev`, and the console's `/login` page has a **Continue with Google** link that starts it directly
(`/api/auth/login?idp=google`, which the BFF turns into Keycloak's `kc_idp_hint=google`). The normal
**Continue with single sign-on** link is unchanged.

To enable it:

1. In Google Cloud Console, create an OAuth client (type **Web application**). Add the **Authorised JavaScript origin**
   `http://localhost:18080` and the **Authorised redirect URI**
   `http://localhost:18080/realms/blackwing-dev/broker/google/endpoint`.
2. Put the client in the repository `.env` (gitignored, never commit it): `BW_DEV_GOOGLE_CLIENT_ID` and
   `BW_DEV_GOOGLE_CLIENT_SECRET`.
3. Run `pnpm demo google`. It upserts the provider (idempotent: run it again after changing the secret) and the demo
   mappers. Without the two values it prints these instructions and changes nothing. `pnpm demo` runs the same step
   once Keycloak is up, and continues without Google if it is not configured.

What a first Google sign-in does (demo mode only, `BW_DEMO_MODE=1`, which `pnpm demo` sets):

- The Google IdP mappers give the new Keycloak user the tenant attribute `acme`, the realm roles `appsec-engineer` and
  `auditor` (requester and read access), and the marker role `bw-demo-google`.
- The first demo request for that user creates its user row and a membership in the demo tenant `acme` in
  `blackwing_demo`. The marker is the only way in: a local user without it is still refused (`demo_user_unknown`).
- Keycloak may show its "Update account information" page once, because the provider asks to review the profile.
- The banner says the Google sign-in is the requester and read account. **Gate 1 needs a second person:** sign out and
  sign in as `owner@acme.test` to approve. A Google user cannot approve its own request (separation of duties).

**Security note.** With `pnpm demo google` set up, every Google account that can reach the dev Keycloak gets the demo
tenant. Keep the dev Keycloak on `localhost`, and do not expose it on the LAN while Google is enabled. The mappers
are demo-only; a real tenant never uses this realm.

Check it: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/login` is 200. The page shows both links.
`curl -s -o /dev/null -w "%{redirect_url}" "http://127.0.0.1:3000/api/auth/login?idp=google"` redirects to
`.../realms/blackwing-dev/protocol/openid-connect/auth?...kc_idp_hint=google...`. Keycloak then redirects to
`accounts.google.com`. A second `idp` value (for example `idp=github`) is ignored, not forwarded.

## Claude credentials for the hunt runner

The runner drives a Claude agent team through the Claude Agent SDK.

- **Local demo (`BW_ENV=dev`, the default of `pnpm demo`):** with no `ANTHROPIC_API_KEY`, it uses the host's
  Claude login (run `claude` once and sign in).
- **Hosted (EC2, external users):** set `BW_ENV=prod` (or anything but `dev`) and put `ANTHROPIC_API_KEY` in `.env`.
  A personal Claude.ai subscription login must never power customer runs (CLAUDE.md), so without a key the runner
  fails the run with `model_credentials_missing`.
- Model: `BW_HUNT_MODEL` (default `claude-sonnet-5-5`). Concurrency: `BW_HUNT_CONCURRENCY` (default 2).
  Gate 2 countdown: `BW_GATE2_TIMEOUT_S` (default 300).

## Host it (EC2 or LAN)

1. Open the web port (3000) and the Keycloak port (18080) in the security group. Keycloak must be reachable by the
   browser, because the sign-in page is Keycloak's.
2. Run with the public origin: `DEMO_HOST=0.0.0.0 DEMO_PUBLIC_ORIGIN=http://<public-ip>:3000 pnpm demo`. The launcher
   sets `BW_CONSOLE_ORIGIN`/`WEB_ORIGIN` from it and prints the redirect URI to allow.
3. Keycloak, client `bw-console-bff`: add `http://<public-ip>:3000/api/auth/callback` to the valid redirect URIs
   and `http://<public-ip>:3000` to the web origins (admin console, or `infra/compose/keycloak/realm-export.json`
   and re-import). Set `BW_DEV_KEYCLOAK_PUBLIC_URL`/`KEYCLOAK_ISSUER_URL` to `http://<public-ip>:18080/...` so the
   browser is sent to a reachable Keycloak.
4. Use HTTPS in front (for example a load balancer or Caddy) before real customers use it.
5. WSL2 only: use mirrored networking (`networkingMode=mirrored` in `.wslconfig`) or a `netsh portproxy`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| API not answering after 60 s | `tail -50 .demo/logs/api.log`. |
| Web `Module not found: stream` | `src/instrumentation.ts` must import telemetry only inside the `NEXT_RUNTIME === 'nodejs'` block. |
| "Only an appsec engineer can request" for a user that has the role | The `bw-console-bff` client lacks the `realm-roles` ID-token mapper (in `realm-export.json`). Add it in the admin console or re-import. |
| Run fails `model_credentials_missing` | Set `ANTHROPIC_API_KEY`, or use `BW_ENV=dev` with a host Claude login (local only). |
| Run stuck in `running` after a restart | The runner marks such runs `failed` (`worker_restarted`) when it starts. |
| Hunt runner logs | `.demo/logs/demo-runner.log`. |

## The story, click by click

1. Sign in as `appsec@acme.test` (requester). **Assets → Register target**: a name and the base URL of a system you
   are authorised to test (optionally extra origins and excluded paths).
2. Sign in as `owner@acme.test` (asset owner): verify ownership, either **Verify via HTTP token** (serve the shown
   token at `/.well-known/blackwing-verification.txt`) or **Attest ownership** (lab or owned system). Requests are
   refused until the asset is verified.
3. As the requester: **New assessment**. Objective, max intrusiveness (active-safe), request budget, minutes, cost cap.
   Optionally add up to three test accounts (role, header name, header value) for a grey-box run. The values are
   stored in plaintext in the demo database, so use throwaway accounts only. The model never sees them, and they are
   redacted in stored exchanges and never returned by the API. The run header shows **Grey box** or **Black box**.
   Passive runs send only GET/HEAD/OPTIONS.
4. **Gate 1**: the requester cannot approve (separation of duties). The asset owner approves.
5. The requester starts the run. **Flight deck**: one lane per agent (orchestrator, recon, web-api-specialist,
   authz-specialist, validator) on a two-minute time axis, the authorisation strip, cost/requests/duration gauges,
   the activity feed with filters and the candidate findings. **Transcript** shows the agents' messages (not verified).
6. **Gate 2**: when an agent needs a state-changing request (POST/PUT/PATCH), its lane pauses and a banner with a
   countdown appears. **Review** opens the Gate 2 page (works on mobile). Approving needs a reason of at least 8
   characters, which is shown after the decision; denying does not. No decision means denied.
7. **Kill run**: choose the scope (run), type the run short id, and the dialog reports the measured halt time.
8. **Findings**: only the deterministic validator confirms (3 replays match the oracle, the negative control does
   not). Each finding shows the probe vs control, the replays and a curl repro.
9. **Gate 3**: validator-proven findings are released automatically. Candidates the validator did not confirm are kept as
   **suspected** (analyst-only). The appsec engineer opens a finding and releases or dismisses it with a reason.
   Only released findings reach the reports and the webhook. **Findings** (`/demo/findings`) lists them with severity
   and status filters.
10. **Reports**: the run page downloads the run report as HTML, Markdown, JSON or SARIF (released findings only).
11. **Audit ledger** (`/demo/audit`): a hash-chained, read-only log of Gate 1 and Gate 2 decisions, kills, and
    release/dismiss decisions, with chain verification. Each action shows `Recorded in the audit ledger · evt_… ·
    sha256:…`.

Without a browser: `DEMO_SMOKE_TARGET=<authorised URL> node scripts/demo.mjs smoke` runs registration, attestation,
Gate 1 (with the SoD refusal), a short live hunt, and checks that at least two agents worked.

### Safety rules (deterministic, never model-dependent)

| Rule | Where |
|---|---|
| Ownership verified before any request | API |
| Requester ≠ approver (Gate 1) | API + DB check |
| Every target request inside the asset origins and outside excluded paths, else refused and shown as a policy block | `apps/worker/src/demo/hunt/scope.ts`, `http-tool.ts` |
| GET/HEAD/OPTIONS allowed; POST/PUT/PATCH need Gate 2; DELETE/TRACE/CONNECT always refused | same |
| Request, time and cost budgets | same + SDK `maxBudgetUsd` |
| No redirects followed, 10 s timeout | `http-tool.ts` |
| Agents have no shell, file or web tools: only the Blackwing MCP tools and sub-agent delegation | `orchestrator.ts` |
| Findings confirmed only by replay + negative control | `validator.ts` |

### Real versus stub

| Piece | State |
|---|---|
| Keycloak login, roles, Gate 1 SoD, Gate 2, kill, pause | Real (demo tables, schema `demo`) |
| Claude agent team (orchestrator + 3 specialists) | Real, Claude Agent SDK. Calls go directly to Claude, not through the model gateway (OFFLINE-STUB) |
| HTTP to the target, scope enforcement, validator | Real, from the runner process |
| Gate 3 release (auto-release of proven findings, release/dismiss with a reason) | Real, simplified |
| Audit ledger (hash chain, verification on `/demo/audit`) | Real, simplified: one table, no external anchoring |
| Webhook delivery (`BW_DEMO_WEBHOOK_URL`) | Real, optional |
| Run reports (HTML, MD, JSON, SARIF) | Real, released findings only |
| Grey-box test accounts | Real, stored in plaintext in the demo database |
| Sandbox (gVisor), egress gateway, Temporal | Not in the POC: the runner is the egress point |
| Ownership verification | Real HTTP token, or owner attestation |
| Severity | Proposed by the agent, not computed |
