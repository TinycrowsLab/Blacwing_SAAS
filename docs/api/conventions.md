# API conventions

Every endpoint in the [reference](reference.md) follows these rules (CONTEXT_PACK [§9](../architecture/CONTEXT_PACK.md#9-api-conventions)).
The examples use placeholder values only. Never send a real token or secret in a request that you write down or share.

## Base URL and format

- All REST routes live under `/v1`, for example `POST /v1/kill`.
- Requests and responses are JSON. Field names are camelCase.
- Timestamps are ISO 8601 in UTC with milliseconds, for example `2026-10-20T10:00:00.000Z`.
- Identifiers are UUIDv7 strings.
- The internal Run Broker API (`/internal/broker`) is used only from the sandbox network. It is not part of the public
  API and is not described in this reference.

## Errors

Every failure answers with `application/problem+json` (RFC 9457):

| Field | Meaning |
|---|---|
| `type` | `https://errors.blackwing.dev/{code}`, a stable URI for the error. |
| `title` | A fixed, human-readable title for the code. |
| `status` | The HTTP status, repeated in the body. |
| `detail` | Optional. A short explanation for this request. It never contains internals or stack traces. |
| `code` | The stable error code, in upper snake case, for example `IDEMPOTENCY_KEY_REQUIRED`. Codes are never renamed or reused. |
| `traceId` | A 32-character hex id. Quote it when you report a failure. |
| `errors` | Optional. Per-field problems for `422 VALIDATION_FAILED`. |

Branch on `code`, not on `title` or `detail`. The codes that clients most often handle:

| Code | Status | When |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid session or token. |
| `FORBIDDEN` | 403 | The caller lacks the permission or the resource check denied the action. |
| `NOT_FOUND` | 404 | The resource does not exist for this tenant. |
| `CONFLICT` | 409 | The request conflicts with the current state. |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | A creating `POST` has no `Idempotency-Key` header. |
| `VALIDATION_FAILED` | 422 | The body or a parameter is malformed. |
| `IDEMPOTENCY_KEY_MISMATCH` | 422 | The same `Idempotency-Key` was sent with a different request. |
| `PRECONDITION_REQUIRED` | 428 | A mutation has no usable `If-Match` header. |
| `PRECONDITION_FAILED` | 412 | `If-Match` no longer matches the current ETag. Read the resource again. |
| `RATE_LIMITED` | 429 | The token exceeded its rate limit. Wait for `Retry-After`, then retry. |
| `KILL_SWITCH_ACTIVE` | 423 | The kill switch blocks the action. |
| `NOT_IMPLEMENTED` | 501 | The endpoint is reserved and not yet available. |
| `TX_RETRY_EXHAUSTED` | 503 | A transient overload. It is retryable. |

Errors that the error registry marks as retryable, such as `RATE_LIMITED` and `TX_RETRY_EXHAUSTED`, may succeed when the same
request is repeated later. Every other error needs a changed request or a changed state first.

## Pagination

List endpoints are cursor-based:

- `cursor` is an opaque string from the previous page's `nextCursor`. It is at most 2048 characters. Do not parse it. The
  platform signs cursors, so an altered one is refused.
- `limit` is an integer. The default is 50, and a value above 200 is served as 200. Zero, negative and non-integer values are
  refused with `422 VALIDATION_FAILED`.
- A page answers `items`, `nextCursor` (`null` on the last page) and `hasMore`.

Follow `nextCursor` until it is `null`. Do not assume a fixed page count.

## Idempotency

A `POST` that creates a run, an export or a ticket requires an `Idempotency-Key` header. The kill-switch trigger requires it
as well. The reference marks it as required on each operation.

- The key is 8 to 255 printable ASCII characters with no spaces. Use a UUID or another random value per logical
  request.
- A retry with the same key and the same body returns the first result. The replayed response carries the header
  `Idempotency-Replayed: true`.
- The same key with a different body is refused with `422 IDEMPOTENCY_KEY_MISMATCH`. The platform never replays the
  wrong result.
- While the first request is still running, a duplicate answers `409` with a `Retry-After` header. Wait, then retry with
  the same key.
- The platform stores a SHA-256 hash of the key, never the raw key.

## Concurrency control (ETag and If-Match)

Mutable resources carry a strong `ETag`. The rules are:

1. Read the resource. Keep the `ETag` header value, including its quotes, for example `"3"`.
2. Send the same value in `If-Match` on the change.
3. If the value is stale, the platform answers `412 PRECONDITION_FAILED`. Read the resource again and decide whether the
   change still applies.
4. If `If-Match` is missing, or is a weak validator (`W/"..."`), the platform answers `428 PRECONDITION_REQUIRED`.

## Rate limits

Limits apply per token. A request over the limit answers `429 RATE_LIMITED` with a `Retry-After` header in whole
seconds. Wait at least that long before the next request. Batch work where the endpoint allows it, and do not retry in a
tight loop.

## Authentication and authorisation

Every operation names its security schemes in the reference. See [Authentication](auth.md) for how to obtain and send
credentials.

Authorisation runs in two steps. The first checks the RBAC permission for the operation. The second checks the resource
against the tenant's Cedar policy. Both must allow the request. A failed check answers `403 FORBIDDEN` or a more specific
403 code, such as `KILL_FORBIDDEN`. A request that names a resource of another tenant is refused, and the refusal is
audited.

## Versioning and deprecation

The major version is in the path (`/v1`). An operation that is being replaced is marked **Deprecated** in the reference
and names its replacement in its description. Keep `operationId`s stable: they are the names of the generated client
methods.
