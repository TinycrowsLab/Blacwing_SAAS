# Keycloak realm as code (IAM-001)

`realm-blackwing.json` is the staging/prod realm `blackwing` (Keycloak 26.4.2, pinned by digest in
`infra/compose/docker-compose.dev.yml`). `${BW_*}` placeholders are resolved from the environment by
`scripts/keycloak-sync.mjs` at apply time. Confidential-client secrets are injected from OpenBao (via the
Helm Secret) and never appear in this file.

- Clients: `blackwing-console` (public, PKCE S256, strict redirect/origin, no wildcards),
  `blackwing-api` (confidential, token audience), `blackwing-cli` (client credentials for `bw_ci_` flows,
  audience `blackwing-api`).
- Claims: client scope `bw-claims` maps `tenantId`, `roles` and the `blackwing-api` audience. `acr` comes
  from the built-in `acr` scope with `acr.loa.map` (`password`=1, `strong`=2) for step-up (IAM-009). A login that
  completed a second factor asserts `acr=strong`.
- Organizations enabled, brute-force detection on, `sslRequired=external`, access token 5 min.
- Apply: `node scripts/keycloak-sync.mjs apply` (idempotent upsert; never deletes, never touches users,
  orgs or IdPs). `node scripts/keycloak-sync.mjs check` validates the file offline. Helm Job:
  `infra/helm/bw-keycloak-realm`.
- Dev: `infra/compose/keycloak/realm-export.json` (realm `blackwing-dev`, clients `bw-console-bff`,
  `bw-api`, `bw-ci`) is imported by `pnpm dev:deps` with `--import-realm`, which skips an existing realm.

## Platform-operator realm (#838)

`realm-blackwing-operators.json` is the realm `blackwing-operators`: Blackwing staff, a separate identity space from
the tenant realm. The sync validates it (`node scripts/keycloak-sync.mjs check`) and applies it with the tenant realm.

- No tenant: there is no `tenantId` mapper anywhere in the realm, so an operator token never names a tenant. Operators
  reach tenant data only through the audited operator API (ADMIN-010+).
- No brokering, no self-registration, no users in the file, `sslRequired=external`, brute-force detection on.
- Clients: `operator-bff` (confidential, Authorization Code + PKCE `S256`, redirect
  `/operator/api/auth/callback`) and `operator-api` (audience only: no browser, password or service-account flow).
  Secrets are `${BW_KEYCLOAK_OPERATOR_BFF_SECRET}` and `${BW_KEYCLOAK_OPERATOR_API_SECRET}`, injected from OpenBao.
- Roles: `platform_operator`, `verification_reviewer`, `platform_admin`.
- MFA is mandatory: the browser flow `blackwing operator browser` requires a second factor (WebAuthn or TOTP) with no
  conditional bypass. `CONFIGURE_TOTP` is a default action, so the first login forces enrolment. The token `acr` is
  `operator_strong` only after the second factor (`acr.loa.map`: `password`=1, `operator_strong`=2). The API refuses any
  other `acr` with `OPERATOR_MFA_REQUIRED`.

OFFLINE-STUB(online-porting #906): not covered offline are a live login through the flow, the `acr` the realm actually
asserts, and enrolment. These need a running Keycloak (Docker) and are tracked in #906.

## MFA for local accounts (IAM-005)

- Browser flow `blackwing browser` (declared under `mfa` in the realm file, bound as `browserFlow`): username and
  password, then a conditional OTP sub-flow and a conditional WebAuthn sub-flow. Each sub-flow runs only when the
  user has that factor enrolled, so TOTP alone and WebAuthn alone both satisfy MFA. A user with both is asked for
  both. OTP codes are single-use with a look-ahead window of one period (clock drift). WebAuthn requires user
  verification.
- Required actions `CONFIGURE_TOTP` and `webauthn-register` are enabled. The sync creates the flow and the required
  actions. A live flow that differs from the file fails the sync; the sync never rewrites a live flow. Re-running it
  creates nothing.
- Policy (`apps/api/src/keycloak/mfa.ts`): per organisation `mfaRequired` and `allowedFactors` (must include TOTP,
  the fallback for browsers without WebAuthn), stored as the organisation attributes `bw.mfaRequired` and
  `bw.mfaFactors`. `org-admin` and `platform-operator` always require MFA. A required user with no allowed factor
  gets the `CONFIGURE_TOTP` required action until enrolment completes.
- Recovery codes: Keycloak issues them once and consumes each on use. Show them to the user once; never log them.
  Keycloak 26.4 may gate the `recovery-codes` feature and its `CONFIGURE_RECOVERY_AUTHN_CODES` required action behind
  a feature flag. That is not enabled by this realm file yet; confirm it on a live realm first.
- Admin reset (`MfaService.resetFactors`): needs a session at `acr=strong`, refuses self-service resets, and removes
  the user's OTP, WebAuthn and recovery credentials. It is audited as `auth.mfa_reset`. It must run under a dedicated
  least-privilege service account that can manage user credentials; the organisation client cannot.
- Not covered offline: live enrolment and login, the flow's `acr` assertion, recovery-code login, and enrolment
  ingestion (`auth.mfa_enrolled` and the enrolment and challenge metrics). These need a running Keycloak. Tracked in
  #903 (`OFFLINE-STUB(online-porting #903)`).
