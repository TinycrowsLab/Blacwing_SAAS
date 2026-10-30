# Runbook: internal secret resolve API (SECRETS-006)

Code: `packages/secrets/src/resolve*.ts`, `service-auth.ts`. Read with
[§8.6 (tenant isolation)](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch),
§8.7 (secrets by reference), §8.8 (audit) and §8.11 (deterministic authorisation) in the same section.

`POST /internal/secrets/resolve` is the single sanctioned read path for secret values. A platform service sends a
`secret_ref`; the Secrets Service decrypts it at the moment of use and returns the plaintext. The sandbox and the
model never call it and never see the value.

## Request and response

```http
POST /internal/secrets/resolve
Authorization: Bearer bwsvc_<claims>.<signature>
X-Tenant-Id: <lowercase tenant uuid>
Content-Type: application/json

{ "secretRef": "bw-secret://<tenant>/<secret>[?v=n]", "callerPurpose": "asset_login", "runId": "<uuidv7>", "context": { "host": "app.example.com" } }
```

`200` returns `{ "value", "version", "type" }` with `Cache-Control: no-store`. Every error is
`{ "code", "title", "status", "retryable" }` with the registered code and no message or input.

| Code | Status | When |
|---|---|---|
| `SERVICE_AUTH_FAILED` | 401 | No, unknown, expired, revoked or forged service token. Counted, not audited (no trusted tenant). |
| `TENANT_CONTEXT_MISSING` | 403 | `X-Tenant-Id` missing or not a lowercase UUID. |
| `TENANT_MISMATCH` | 403 | The reference or the run belongs to another tenant than the caller states. |
| `SECRET_PURPOSE_DENIED` | 403 | The purpose is outside the service's matrix, the record's purpose or type does not match, or Cedar denied. |
| `SECRET_NOT_FOUND` | 404 | Unknown secret or version (another tenant's secret looks the same). |
| `SECRET_DISABLED` / `SECRET_SHREDDED` | 409 / 410 | The secret is switched off or its value is gone. |
| `SECRET_VERSION_RETIRED` | 410 | A pinned `?v=` version went past its rotation grace period (`SECRET_VERSION_GRACE_MS`, default 1 hour). The consumer must drop the `?v=` pin to use the current version, or re-pin to the version that is current now. |
| `RUN_KILLED` / `RUN_NOT_ACTIVE` | 423 / 409 | The run was killed (so revoked virtual keys cannot be re-minted) or has ended. |
| `RATE_LIMITED` | 429 | Per-service limit; `Retry-After` is set. The refusal is still audited. |
| `KEK_UNAVAILABLE` | 503 | OpenBao sealed or unreachable. Fail closed; nothing is served, and the cache is never served past its TTL. |
| `EXTERNAL_BACKEND_UNAVAILABLE` | 503 | A customer-owned (BYOK) store timed out, failed, or has no adapter yet. |
| `UNKNOWN_SECRET_BACKEND` | 500 | A record names a backend the registry holds no adapter for. A wiring defect (issue #112): never retried, never answered by another backend. |
| `INVALID_SECRET_REF` / `VALIDATION_FAILED` | 422 | Malformed reference or body. |

## Who may resolve what

Authentication says who calls; the matrix in `DEFAULT_SERVICE_MATRIX` says what they may read. mTLS or a valid
token alone is not authorisation. The request's `callerPurpose` must be allowed for the service and equal the
secret's stored `purpose`, and the secret's `type` must be allowed.

| Service | Purposes | Needs an active run |
|---|---|---|
| `session-manager`, `egress-gateway` | `asset_login` | yes |
| `model-gateway` | `provider_key` | yes |
| `worker:connectors` | `connector_credential` | no |
| `worker:notify` | `notify_channel` | no |

A Cedar adapter (`authorize` dependency, POLICY) can only narrow this; if it throws, the resolve is denied.

## Network exposure (acceptance: not reachable from the sandbox)

The handler must be mounted on an internal listener that is **not** the Run Broker listener (api port 13400,
which `20-run-broker.yaml` opens to sandbox pods). Three independent layers keep sandboxes out:

1. NetworkPolicy: a sandbox pod may reach exactly the egress gateway, the model gateway and the Run Broker
   (`infra/k3s/network-policies/30-sandbox.yaml`, proved by `scripts/k3s-network-policies.test.mjs`). The
   resolve listener's ingress policy lists only `session-manager`, `egress-gateway`, `model-gateway` and
   `worker` pods; do not add a sandbox selector.
2. Source check: `SECRET_RESOLVE_ALLOWED_CIDRS` is the allowlist of the callers' pod CIDRs, checked against the
   socket peer (never `X-Forwarded-For`). An empty list refuses every request. The sandbox CIDR must not be in it
   (it sits inside the private ranges, so a "private address" check alone would not be enough).
3. Service token: the sandbox holds no `bwsvc_` token. Tokens are minted per service by deployment tooling
   (`signServiceToken`), at most 24 hours long, and revocable.

## Operating it

- Configuration: `SECRET_RESOLVE_SERVICE_TOKEN_KEY`, `SECRET_RESOLVE_ALLOWED_CIDRS`, `SECRET_RESOLVE_CACHE_TTL_MS`
  (default `0`, off; at most 300000), `SECRET_RESOLVE_RATE_LIMIT_PER_MINUTE` (see `.env.example`).
- Envelope binding: a record's value is encrypted with the context `{ secretId, purpose }` where `purpose` is the
  record's `purpose`. The write API (SECRETS-004) must encrypt the same way or the resolve fails `AAD_MISMATCH`.
- Audit: every authenticated resolve emits `secret.resolved` (`success`, `denied` or `failure`) before the value
  is returned; if the ledger write fails the caller gets `INTERNAL`, not the value. Metadata holds the service,
  purpose, secret id, version and context keys, never the value or the context values.
- Cache: when enabled, plaintext lives only in process memory, keyed by service, purpose, reference and context.
  Authorisation, run state and secret status are re-checked on every call, so a kill or a disable takes effect at
  once. A rotated secret that a reference resolves without `?v=` can be served up to the TTL after rotation.
- Metrics (`ResolveMetrics` port, registered by the host app): `secret_resolve_total{service,result}`,
  `secret_resolve_latency_seconds`, `secret_resolve_denied_total{reason}`. Trace span `secret.resolve`. Logs carry
  `{tenantId, secretId, callerService, runId, outcome}`.

## Validation

1. `pnpm --filter @blackwing/secrets test` passes (auth, matrix, tenant, kill, shredded, KEK down, rate limit,
   cache TTL, audit-before-return).
2. From a sandbox pod, `wget` to the resolve listener times out (NetworkPolicy), and the call from a pod outside
   the allowlist returns `403`.
3. With a valid `bwsvc_` token, resolve a test secret and confirm one `secret.resolved` event in the tenant's
   audit ledger and no plaintext in logs or the event.
