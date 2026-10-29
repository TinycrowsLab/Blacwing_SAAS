# Dev seed data (`pnpm db:seed`)

DEVENV-011 (#165). Seeds the local database with the minimum data for a first grey-box run against the
local Juice Shop. Development and test only: the command refuses every `NODE_ENV` except `development` and `test` (error code
`SEED_FORBIDDEN_IN_PROD`), before it reads any config or opens a connection.

## Run it

```sh
pnpm dev:deps          # Postgres, Keycloak, OpenBao, ...
pnpm db:migrate        # the seed never creates tables
pnpm db:seed           # idempotent: run it as often as you like
pnpm db:seed:reset     # delete the seeded tenant rows, then seed again
pnpm db:seed --only=assets,credentials   # run only the named steps (see "Steps")
```

## Steps

The run is a list of named steps, in order. `tenant` (the tenant `acme` and its users) always runs. The
others write tenant-scoped rows: `memberships`, `assets`, `credentials`, `standing-authorisations` and
`role-matrices`. `--only=<a,b>` runs just the named steps. An unknown or empty name is refused before anything
is written. A step left out by `--only` is not reported as skipped. `--reset` clears every seeded row first,
whatever `--only` says, so a reset never leaves a child row behind its deleted asset.

It reads `.env` at the repository root: `DATABASE_URL` (app role, RLS applies), `MIGRATION_DATABASE_URL`
(owner role, platform rows only), `BW_TARGET_JUICE_SHOP_URL` (default `http://127.0.0.1:13000`, used by e2e),
`BW_TARGET_JUICE_SHOP_GATEWAY_URL` (default `http://juice-shop:3000`, the compose service name the egress
gateway targets; the seed refuses `localhost` and loopback) and, optionally, `BW_DEV_KEYCLOAK_PUBLIC_URL`, `BW_DEV_KEYCLOAK_REALM`, `BW_DEV_KEYCLOAK_ADMIN_USER` and
`BW_DEV_KEYCLOAK_ADMIN_PASSWORD`. `${VAR}` references in `.env` are expanded.

## What it writes

| Entity | Rows |
|---|---|
| `tenants` | `acme` (`active`, `eu-west-1`, plan `dev`) |
| `users` | one per Keycloak test user (DEVENV-004): appsec, owner, dev, admin, auditor, operator |
| `memberships` | five. The Platform Operator is deliberately not a member of `acme`. |
| `assets` | one `web_app` at the Juice Shop URL, `environment=dev`, owned by the Asset Owner, `verified` via `manual_letter`, with an F6 attestation (lockout exemption) |
| `asset_credentials` | `customer` and `admin`: `secret_ref = openbao://secret/data/tenants/acme/assets/juice-shop/credentials/<role>` plus a JSON login recipe. No plaintext ever. |
| `standing_authorisations` | one `active` SA, `active_safe`, valid from the seed time for 90 days (re-seeding renews it), requested by AppSec and approved by the Asset Owner |
| `role_matrices` | Juice Shop functions × `anonymous`/`customer`/`admin`, giving the expected access (F9) |

Rows use deterministic UUIDv7 keys and upserts, so a re-run, or a run after a partial one, converges
without duplicates. Every tenant-scoped row is written as the app role inside a transaction that sets
`SET LOCAL app.tenant_id`. After writing, the seed counts what it can see under `acme` and checks that a
random other tenant sees nothing. It fails if any seeded row leaks.

## Safety notes

- **Missing schema.** The seed compares the catalogue with `SEED_SCHEMA_CONTRACT`
  (`packages/db/src/seed/schema-contract.ts`). The platform tables (`tenants`, `users`) must exist, or the run
  stops before writing anything and names what is missing. A tenant-scoped step whose tables are missing (or
  whose dependency was skipped) is skipped and logged as `seed.skipped` with the missing table or column, and
  the rest of the seed still runs. Run `pnpm db:migrate` to create them. The integration test runs against the
  real migrations, so every tenant-scoped table (assets, credentials, role matrices, standing authorisations) exists.
- **Separation of duties (§8.4).** A plan where the requester is also the approver is rejected before any
  write.
- **Keycloak subjects.** With admin credentials set, the seed looks up each user's `sub` in the dev realm.
  A user that is absent, or a Keycloak that cannot be reached, only produces a warning. The user then
  keeps a `pending:<username>` subject, and a subject that was confirmed earlier is never overwritten.
- **SA signature.** The SA carries a dev EdDSA JWS whose key is generated for the run and then thrown away.
  No trust store holds that key, so the envelope verifier (#375) rejects the signature until the signing
  service exists. A seeded SA cannot pass §8.1 verification by accident.
- **Audit.** The seed writes no audit event. `@blackwing/audit` depends on `@blackwing/db`, so this package
  cannot call the ledger emitter, and a raw insert would bypass the hash chain. The run logs `seed.complete`
  instead. Production tenants are provisioned through onboarding, which audits, and are never seeded.
- **Secrets.** OpenBao secrets are referenced, never written. The log summary contains counts and names
  only.
