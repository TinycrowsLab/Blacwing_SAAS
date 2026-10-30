# Demo runbook (`pnpm demo`)

Localhost demo of the Blackwing console for a stakeholder walkthrough. Code: `scripts/demo.mjs`.
This is a development setup: demo-only secrets, a demo database and a lab target. Never run it against
production data.

## Start

```sh
pnpm dev:deps      # once: Postgres, Keycloak, Valkey, Temporal, ... (the demo calls it if they are down)
pnpm demo          # idempotent: deps, Juice Shop, demo database, migrations, seed, API, worker, web
pnpm demo status   # what is running
pnpm demo stop     # stop the API, worker and web started by the demo
```

`pnpm demo` prints the URLs and the demo users when it is up. Logs are in `.demo/logs/` (api.log, worker.log,
web.log). Pids are in `.demo/pids.json`. Both directories are gitignored.

## What the script does

1. Brings up the dependency stack with `pnpm dev:deps` only when Postgres or Keycloak is not healthy.
2. Starts the Juice Shop lab target as container `bw-demo-juice` on `127.0.0.1:3001`
   (`docker run -d -p 127.0.0.1:3001:3000 bkimminich/juice-shop`). The first run pulls the image.
3. Creates the database `blackwing_demo` on the dev Postgres. It does not share `blackwing` with other
   worktrees, whose migration journals differ from this checkout.
4. Runs the migrations and `pnpm db:seed` against `blackwing_demo`. The seed skips tables that are not merged
   yet and logs `seed.skipped`, so the console still starts.
5. Starts the API (`127.0.0.1:13400`), the worker (health `:13800`) and the web app (`DEMO_HOST`, default
   `127.0.0.1`, port `3000`).

The script writes `.env.demo` on first run. It holds a demo-only `BW_WEB_SESSION_SECRET`. Overrides:
`DEMO_HOST` (bind address and LAN IP), `DEMO_WEB_PORT`, `DEMO_JUICE_PORT`.

## Expected results

| Check | Expected |
|---|---|
| `curl -s http://127.0.0.1:13400/health/live` | HTTP 200 |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/login` | 200 |
| `curl -s -o /dev/null -w "%{redirect_url}" http://127.0.0.1:3000/api/auth/login` | Keycloak `.../realms/blackwing-dev/protocol/openid-connect/auth?...client_id=bw-console-bff` |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/` | 200 (Juice Shop) |

Open `http://localhost:3000`, which redirects to the Keycloak login. The sign-in form is the realm
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

## Expose it on the LAN

1. Set `DEMO_HOST` to the machine's LAN IP or `0.0.0.0`, then run `pnpm demo`.
2. Keycloak: the realm client `bw-console-bff` only allows `http://localhost:3000/auth/callback` (and the
   `app.bw.localhost` URIs). For a LAN host, add `http://<LAN-IP>:3000/auth/callback` to the redirect URIs
   and `http://<LAN-IP>:3000` to the web origins in `infra/compose/keycloak/realm-export.json`, then re-import
   the realm (`pnpm dev:keycloak:reset` only resets the dev stack, so back up first).
   `BW_CONSOLE_ORIGIN` in `.env.demo` must match the URL the browser uses.
3. WSL2 (mirrored networking): add `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig`,
   run `wsl --shutdown`, then reach the console at the Windows host IP on port 3000.
   Without mirrored networking, forward the port with `netsh interface portproxy add v4tov4 listenport=3000
   listenaddress=0.0.0.0 connectport=3000 connectaddress=<WSL-IP>` from an elevated Windows shell.

## Troubleshooting

| Symptom | Fix |
|---|---|
| API not answering after 60 s | `tail -50 .demo/logs/api.log`. Usually config. Check `.env` has `NODE_ENV` and `WEB_ORIGIN`. |
| `relation "memberships" already exists` on migrate | You are on the shared `blackwing` database. The demo uses `blackwing_demo`; check `PGDATABASE` in the log. |
| `must be superuser to create this extension` | Run `CREATE EXTENSION` for `vector`, `pgcrypto` and `citext` as the superuser in `blackwing_demo`. |
| Login returns 500 `ConfigValidationError` | `.env.demo` is missing `BW_WEB_SESSION_SECRET`. Delete `.env.demo` and rerun `pnpm demo`. |
| Port 3000 in use | Another dev server is on it. Set `DEMO_WEB_PORT=3010 pnpm demo` and update the Keycloak URIs. |
| Keycloak timeout during seed | Keycloak is up on `localhost:18080`. The seed only warns. Users keep a `pending:` subject, so sign-in may still work. |
| Google button shows Keycloak "identity provider not found" | `pnpm demo google` has not run, or the `google` provider is disabled in realm `blackwing-dev`. |
| `pnpm demo google` says nothing is configured | `BW_DEV_GOOGLE_CLIENT_ID` or `BW_DEV_GOOGLE_CLIENT_SECRET` is empty in `.env`. |
| Juice Shop not reachable | `docker logs bw-demo-juice`, or `docker rm -f bw-demo-juice` and rerun `pnpm demo`. |

## The story, click by click

`pnpm demo` sets `BW_DEMO_MODE=1`. That mounts the demo routes in the API (`/v1/demo`, `apps/api/src/demo`), starts the
demo runner (`apps/worker/src/demo`) and serves the pages under `/demo` (`apps/web/src/app/demo`). Demo data lives in
the `demo` schema of `blackwing_demo` (migration `20261029200000_demo_story_schema`). Every demo page is marked
DEMO MODE.

1. Open `http://localhost:3000/demo`. Sign in as `appsec@acme.test` (password in `.env`).
2. **Dashboard** (`/demo`): counts, pending Gate 1 requests, runs and confirmed findings. The fallback finding is
   already there, so the story always has a complete finding to show.
3. **Assets** (`/demo/assets`): the lab asset `OWASP Juice Shop (lab)` on `http://127.0.0.1:3001`, ownership
   `verified` (basis: demo stub, lab trust). Click **Request assessment**.
4. **New assessment request** (`/demo/requests/new`): test case is the pinned SQL injection check of issue #881
   (`GET /rest/products/search`, parameter `q`, CWE-89). Intrusiveness `active_safe`, scope host `127.0.0.1`, path
   prefix `/rest/products/search`, budget 8 requests and 300 seconds. Submit.
5. **Gate 1** on the request page: click **Approve at Gate 1** as the requester. It is refused with
   `separation_of_duties` (the requester cannot approve their own request).
6. Click **Sign out**, then sign in as `owner@acme.test` (asset owner). Open the same request
   (`/demo/requests/<id>`) and approve. This is a real second login.
7. Still as the owner, sign out and sign in as `appsec@acme.test` again. Click **Start run**.
8. **Live run** (`/demo/runs/<id>`): the timeline polls every 1.5 s. Stages: run accepted (pins), scope check, planner
   selection, detection probe (`apple'`, benign), two replays, negative control (`apple`), finding, run completed. The
   probe and control are real HTTP requests to the lab target. The run takes about 8 seconds.
9. **Finding** (`/demo/findings/<id>`): the confirmed SQL injection. Evidence shows the probe response (HTTP 500,
   `SQLITE_ERROR`), the negative control (HTTP 200, no error), the replay table and a copyable `curl` repro.
10. **Report**: **Download report (HTML)** or **Download report (Markdown)** on the finding page.
11. `/demo/about` lists what is real and what is a stub. Read it before presenting.

Check the whole story without a browser: `node scripts/demo.mjs smoke`. It runs Gate 1 (SoD refusal, then
approval), a run, the repro on the lab target, both reports and the scope refusal, and exits 1 on any failure.

### Real versus demo stub

| Piece | State |
|---|---|
| Keycloak login, BFF session, roles | Real |
| Tenant `acme`, seeded users | Real (seed in `blackwing_demo`) |
| Asset ownership (lab trust) | Demo stub: no DNS or HTTP proof |
| Request scope, intrusiveness, budget checks | Real rules, demo tables (`demo` schema, no RLS) |
| Gate 1 separation of duties and asset-owner role | Real rule, demo storage (not the audit ledger) |
| Planner, specialist | Demo stub: deterministic, no model call |
| Sandbox, egress gateway, Temporal | Demo stub: the runner probes the lab target from the demo worker process |
| Probes, oracle (error signature), negative control | Real logic and real HTTP to Juice Shop |
| Severity (CVSS v4.0 score) | Demo-assigned, not calculated |
| Report (HTML, Markdown) | Real rendering of the stored finding |
| Kill switch, Gate 3 release, audit ledger | Not in the demo |

The browser never calls the demo API. The demo web server calls it with `BW_DEMO_INTERNAL_TOKEN` (in `.env.demo`)
and the identity of the Keycloak session. The API refuses any call without that token (401).

### Demo-only code and migration

- `apps/api/src/demo/**`, mounted by `apps/api/src/run.ts` only when `BW_DEMO_MODE=1`.
- `apps/worker/src/demo/**`, started as the `demo-runner` service. It refuses to start unless `BW_DEMO_MODE=1`.
- `apps/web/src/app/demo/**` and `apps/web/src/components/demo/**`.
- `packages/db/migrations/20261029200000_demo_story_schema.sql`: schema `demo`, no RLS, granted to `bw_app`. It is
  inert unless the demo code reads it. Do not use it for customer data.

## Status of the story

The story runs on localhost with the stubs listed above. The production assessment, Gate 1, run and finding
pieces are still being built on `main`; the demo keeps its own tables until they land. See
`docs/runbooks/demo-status.md`.

## Design fidelity

The demo follows the Blackwing design in [`design/`](../../design/README.md): tokens from `design/tokens.json`
(CSS variables in `packages/ui`, never hex in pages), Poppins and JetBrains Mono self-hosted from
`apps/web/public/fonts`, and the layout grammar of the pass-1 screens (top bar, icon rail, breadcrumb header,
status chips, authorisation strip, right-hand context panel). The shell is `apps/web/src/components/demo/shell.tsx`,
the components are in `apps/web/src/components/demo/design.tsx`.

Screenshots (light and dark) are in [`demo-screenshots/`](demo-screenshots/). Each design screen has a
side-by-side pair: `design-*.png` is the Claude Design prototype, `demo-*.png` is this demo.

| Demo page | Design reference | Deviation |
|---|---|---|
| Live run (`/demo/runs/:id`) | 1a Flight deck | Lanes are the runner stages, not agents. There is no Pause or Kill in the demo API, so both are disabled with the reason. No Gate 2 banner: the demo has no runtime exception. |
| Gate 1 (`/demo/requests/:id`) | 2a Gate 2 layout | Gate 1 has no countdown (the demo does not auto-deny). Deny is the dark button and Approve the outlined one, as in the design. A requester sees Approve disabled with the reason. |
| Kill (3a), emergency link (3b), Gate 2 (2a, 2b) | Screens pass 1 | Not built. They need runtime controls the demo API does not have (KILL #170, GATE2 #203). |
| Authorisation strip | "Authorised under SA-…" | The demo has no standing authorisation, so the strip shows the Gate 1 approver, scope and budget instead of an SA id and key. |
| Top bar search and bell | Top bar | Search is shown but not wired. No alert count, because the demo has no alerts. |

Sign-in (`/login`) takes the same tokens and the single brand-red word of the sign-in screen.

Pairs for review (design prototype first, then this demo, light theme):

| Design | Demo |
|---|---|
| [`design-flight-deck-1a.png`](demo-screenshots/design-flight-deck-1a.png) (1a Flight deck) | [`demo-run-light.png`](demo-screenshots/demo-run-light.png), [`demo-run-dark.png`](demo-screenshots/demo-run-dark.png) |
| Gate 2 (2a) and Kill (3a) | Not built, see the table above |

The other pages have no design screen. They use the same components: [dashboard](demo-screenshots/demo-dashboard-light.png),
[assets](demo-screenshots/demo-assets-light.png), [new request](demo-screenshots/demo-new-request-light.png),
[Gate 1](demo-screenshots/demo-request-light.png), [finding](demo-screenshots/demo-finding-light.png) and
[about](demo-screenshots/demo-about-light.png). Each has a `-dark.png` pair.
