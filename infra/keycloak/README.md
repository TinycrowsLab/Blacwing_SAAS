# Keycloak realm as code (IAM-001)

`realm-blackwing.json` is the staging/prod realm `blackwing` (Keycloak 26.4.2, pinned by digest in
`infra/compose/docker-compose.dev.yml`). `${BW_*}` placeholders are resolved from the environment by
`scripts/keycloak-sync.mjs` at apply time. Confidential-client secrets are injected from OpenBao (via the
Helm Secret) and never appear in this file.

- Clients: `blackwing-console` (public, PKCE S256, strict redirect/origin, no wildcards),
  `blackwing-api` (confidential, token audience), `blackwing-cli` (client credentials for `bw_ci_` flows,
  audience `blackwing-api`).
- Claims: client scope `bw-claims` maps `tenantId`, `roles` and the `blackwing-api` audience. `acr` comes
  from the built-in `acr` scope with `acr.loa.map` (password=1, mfa=2) for step-up (IAM-009).
- Organizations enabled, brute-force detection on, `sslRequired=external`, access token 5 min.
- Apply: `node scripts/keycloak-sync.mjs apply` (idempotent upsert; never deletes, never touches users,
  orgs or IdPs). `node scripts/keycloak-sync.mjs check` validates the file offline. Helm Job:
  `infra/helm/bw-keycloak-realm`.
- Dev: `infra/compose/keycloak/realm-export.json` (realm `blackwing-dev`, clients `bw-console-bff`,
  `bw-api`, `bw-ci`) is imported by `pnpm dev:deps` with `--import-realm`, which skips an existing realm.
