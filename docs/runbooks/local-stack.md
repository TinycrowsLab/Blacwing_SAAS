---
last_validated: 2026-11-05
---

# Runbook: run Blackwing locally (`pnpm start:local`)

One command runs the whole product on this machine: the web console, the API, the worker and the AI hunt engine,
plus the OWASP Juice Shop lab target. Code: `scripts/blackwing.mjs`. Sign-in is Google only
([console sign-in](web-sign-in.md)).

## Start

```sh
pnpm dev:deps       # once: Postgres and the rest of the dependency stack (start:local runs it if Postgres is down)
pnpm start:local    # idempotent: database, migrations, seed, lab, API, worker, hunt engine, web
node scripts/blackwing.mjs status
pnpm stop:local
```

Then open **http://localhost:3100** and choose **Continue with Google** with an administrator account
(`BW_ADMIN_EMAILS`). Use `localhost`, not `127.0.0.1`: the Google client allows only
`http://localhost:3100/api/auth/callback/google`.

The web console runs as a production build (`next build`, then `next start` on `127.0.0.1:3100`), so pages do
not recompile on click. After changing web code, run `pnpm stop:local && pnpm start:local` to rebuild.

Logs are in `.demo/logs/` (`api.log`, `worker.log`, `demo-runner.log`, `web.log`, `web-build.log`); pids in
`.demo/pids.json`. Both are gitignored.

## Configuration (`.env.demo`, gitignored)

| Key | Set by | Meaning |
|---|---|---|
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | you | The Google OAuth web client. |
| `BW_ADMIN_EMAILS` | you | Comma-separated Google e-mails that may sign in. Each one holds every role and may approve its own requests (recorded as self-approved in the audit ledger). |
| `AUTH_SECRET` | the script, once | Encrypts the session cookie. Changing it signs everyone out. |
| `BW_DEMO_INTERNAL_TOKEN` | the script, once | Shared secret between the web server and the API. |

The script also sets `AUTH_URL=http://localhost:3100` and `AUTH_TRUST_HOST=true` for the web process. Environment
overrides: `DEMO_WEB_PORT` (3100), `DEMO_PUBLIC_ORIGIN` (the console origin, if not `http://localhost:3100`),
`DEMO_API_PORT` (13400), `DEMO_LAB_PORT` (3001). An administrator's directory user and tenant membership are created
by the API on the first request after sign-in.

## What the script does

1. Starts the dependency stack with `pnpm dev:deps` when Postgres is not running.
2. Creates the database `blackwing_demo`, applies migrations and seeds the `acme` tenant.
3. Starts the Juice Shop lab on `127.0.0.1:3001` when Docker is available (`node scripts/blackwing.mjs lab` starts
   only the lab) and registers it as the verified asset **Juice Shop lab**.
4. Starts the API (`127.0.0.1:13400`), the worker and the hunt engine, builds the web console and starts it.

## Validation

```sh
DEMO_SMOKE_TARGET=http://127.0.0.1:3001 node scripts/blackwing.mjs smoke
```

It checks that `/` redirects to `/login` when signed out, that `/login` renders, that `/api/auth/providers` lists
Google with the right callback, that the API refuses a call without the internal token, and then runs one
assessment end to end on the internal API hop (asset, Gate 1 with separation of duties, run, findings). It exits 1
on any failure.
