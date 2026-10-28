# Runbook: console sign-in (BFF OIDC)

Code: `apps/web/src/lib/auth/`, routes `apps/web/src/app/api/auth/*`. Read with
[§5](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage)
(OIDC Auth Code + PKCE through a Next.js BFF with httpOnly cookies) and §8.7 (tokens and secrets never reach the
browser or the logs) in the Context Pack's security invariants.

Every human signs in to the console through the Next.js Backend-for-Frontend. The browser never holds a token:
it holds one sealed, opaque session id. The access, refresh and ID tokens live in Valkey.

## Flow

| Route | Method | Does |
|---|---|---|
| `/api/auth/login?returnTo=` | GET | Creates PKCE (`S256`), `state` and `nonce`, seals them with `returnTo` into the 10-minute `__Host-bw_login` cookie and redirects to Keycloak. `returnTo` must be an internal path; anything else becomes `/`. |
| `/auth/callback` (rewritten to `/api/auth/callback`) | GET | Checks `state` against the login cookie, exchanges the code server-side with the verifier, verifies the ID token (signature via JWKS, `iss`, `aud`, `exp`, `nonce`, 30 s clock leeway), then creates the session. Any failure goes to `/login?error=<reason>` with no session. |
| `/api/auth/session` | GET | whoami: public identity, tenant, roles, `csrfToken`, `expiresAt`. Renews the tokens silently when they expire within 60 s. |
| `/api/auth/refresh` | POST | Same renewal, on demand. Needs the `x-bw-csrf` header. |
| `/api/auth/logout` | POST | Deletes the session, clears the cookie and answers `{ "redirectTo" }`, the Keycloak `end_session_endpoint` (RP-initiated logout) with `id_token_hint`. Needs `x-bw-csrf` while a session exists. |

The redirect URI registered in Keycloak is `${BW_CONSOLE_ORIGIN}/auth/callback` (`scripts/keycloak-realm.mjs`).

## Cookies and storage

- `__Host-bw_session` and `__Host-bw_login`: httpOnly, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`. They carry an
  AES-256-GCM sealed payload (purpose bound as AAD, so one cannot be used as the other).
- Valkey `bw:web:sess:<sid>` holds the session record (tokens, identity, CSRF secret), sealed again with the same
  key, with a TTL of the refresh-token lifetime (at most 12 h). `bw:web:sess-lock:<sid>` is the 15 s refresh lock.
- Login mints a new session id (no fixation). A refresh replaces the tokens under the same id and keeps the CSRF secret,
  so other tabs and server-rendered pages keep working.
- Refresh is single-flight across tabs and replicas: one request holds the lock and calls Keycloak, the others wait
  up to 3 s for the renewed record. A refresh Keycloak refuses (`invalid_grant`: revoked, expired, or a rotated token
  presented again) deletes the session and the next request is `401`, which sends the user back through login. An
  outage of Keycloak or Valkey is a `503` with `Retry-After`; the session is kept.

## Configuration

| Key | Notes |
|---|---|
| `KEYCLOAK_ISSUER_URL`, `KEYCLOAK_CLIENT_ID` | Realm issuer and client. `https` is required in staging and production. |
| `KEYCLOAK_CLIENT_SECRET` | Only for a confidential client (the dev `bw-console-bff`); unset for the public PKCE client. |
| `BW_CONSOLE_ORIGIN` | The console origin as the browser sees it. `https` in staging and production. |
| `REDIS_URL` | Valkey for the sessions. |
| `BW_WEB_SESSION_SECRET` | At least 32 random characters, resolved from OpenBao and injected as a secret. The sealing key is derived from it (HKDF-SHA-256). |
| `BW_WEB_SESSION_SECRET_PREVIOUS` | Optional. The secret being rotated out: it still opens cookies and records, it never seals. |
| `KEYCLOAK_SESSION_ADMIN_CLIENT_ID`, `KEYCLOAK_SESSION_ADMIN_CLIENT_SECRET` | Optional, both or neither. A service-account client allowed to log users out in the realm (`manage-users`). Used by revocation to end a user's Keycloak sessions; without it a revocation reports Keycloak as `skipped`. |

Rotate the secret without signing anyone out: set `BW_WEB_SESSION_SECRET_PREVIOUS` to the old value and
`BW_WEB_SESSION_SECRET` to the new one, roll the web pods, and remove the previous value after the longest session
lifetime (12 h). Losing the secret entirely signs everyone out (fail closed).

The API (`apps/api/src/auth/session-cookie.ts`) opens the same session cookie and records, so it reads the same
`BW_WEB_SESSION_SECRET` (and `_PREVIOUS`) and the same Valkey. Rotate the secret on the API and the web app together,
with the previous value still set, or the API refuses console sessions.

Recommended Keycloak setting: enable refresh token rotation (`revokeRefreshToken`) on the realm so a stolen refresh
token is detected on reuse; the BFF already treats the resulting `invalid_grant` as a revoked session.

## Back-channel logout and revocation (IAM-006 follow-up, #336)

- `POST /api/auth/backchannel-logout` takes Keycloak's `logout_token` (form field). The token must verify against the
  realm keys (signature, `iss`, `aud`), carry the back-channel logout `events` member, carry no `nonce`, name a `sid` or
  a `sub`, and be at most 120 s old. Its `jti` is claimed once in Valkey (`bw:web:claim:<jti>`), so a replay is refused.
  The sessions named by the token's `sid` (through `bw:web:sess-idx:idp:<sid>`), or else by its `sub`, end at once. The
  answer is `200` with no body on success (also when no session matched), `400` for a refused token and `503` while
  Keycloak or Valkey is down, so Keycloak retries. The realm client must set `backchannel.logout.url` to this path.
- Revocation (`revokeSessions({ userId, tenantId, reason })` in `apps/web/src/lib/auth/revocation.ts`) ends the BFF
  sessions of a user, a tenant, or a user within one tenant, then logs the user out at Keycloak through the Admin API
  (`KEYCLOAK_SESSION_ADMIN_CLIENT_*`). The BFF side is applied first and is authoritative: a revoked session cannot be
  read or refreshed (a refresh still in flight loses its write and the user logs in again). Keycloak is retried three
  times and reported as `done`, `skipped` or `failed`. Each ended session writes an `auth.session_revoked` event.
- Valkey indexes: `bw:web:sess-idx:user:<sub>`, `tenant:<tenantId>` and `idp:<sid>` are sets of session ids, kept for the
  longest session lifetime and pruned as sessions end. The session record stays the authority, so a stale index member
  never keeps a session alive. Large revocations walk the sets in pages of 100.
- Valkey outage: every revocation and logout check fails closed (`503`); nothing is reported as revoked when it is not.

## Metrics, traces, audit

`auth_login_total{result}`, `auth_refresh_total{result}` and `auth_logout_total` are OpenTelemetry counters
(`@blackwing/web` meter); `backchannel_logout_total{result}` and `session_revocations_total{scope}` count back-channel
requests and revocations; spans `auth.callback`, `auth.session`, `auth.logout` and `auth.backchannel_logout`. Results are bounded codes, never
user data. Login, failed login, logout and revoked-session events are written as structured log lines with ids only;
the audit ledger writer is IAM-012 (#340).

## Validation

```bash
pnpm --filter @blackwing/web test        # flows, CSRF, cookies, refresh single-flight, returnTo, failures
pnpm --filter @blackwing/web test:int    # session store and cross-replica refresh against a real Valkey (Docker)
pnpm test:e2e                            # specs/flows/auth-bff.e2e.ts against the dev stack
```

Manual check against the dev stack (`pnpm dev:deps`, `pnpm dev`, console at `http://localhost:3000`): sign in as a seeded
user; in the browser dev tools confirm `__Host-bw_session` is httpOnly and Secure, that `document.cookie` does not list
it and that no storage holds a JWT; `GET /api/auth/session` returns `200` without any token field; `POST
/api/auth/logout` without the `x-bw-csrf` header returns `403`.
