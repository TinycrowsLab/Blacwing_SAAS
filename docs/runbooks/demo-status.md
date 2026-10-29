# Demo status

Last updated: 2026-10-29 (scripts/demo.mjs commit 3b814fe). Owner: demo assembler.

| Area | State |
|---|---|
| `pnpm demo` start-up (deps, Juice Shop, demo database, migrations, seed, API, worker, web) | Works. API answers on 13400, web on 3000, login redirects to Keycloak, Juice Shop on 3001. |
| Migrations on `blackwing_demo` | All 13 applied. |
| Seed | Tenant `acme` and six users. Asset, credential, standing-authorisation and role-matrix seeders are skipped until those tables are merged (`seed.skipped`). |
| Demo users (operator, approver, viewer) | Use the existing realm users (see runbook). Demo-specific Keycloak users are not created yet. |
| Console story (dashboard, asset, assessment request, Gate 1, run, finding, report) | Not built. |
| Deterministic demo runner for Juice Shop SQLi (#881) | Not built. |
| LAN exposure | Documented in the runbook, not tested from another machine. |
| Scheduled 20-minute smoke loop | Not running. Re-run `pnpm demo status`, then the curl checks in the runbook. |
