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
| Juice Shop not reachable | `docker logs bw-demo-juice`, or `docker rm -f bw-demo-juice` and rerun `pnpm demo`. |

## Status of the story

The console flow (dashboard, asset, assessment request, Gate 1 approval, run, finding, report) is not built on
`main` yet. The API has no asset or assessment endpoints, and the console has no dashboard, asset or request pages.
The seed also skips the `assets` tables until they are merged. See `docs/runbooks/demo-status.md`.
