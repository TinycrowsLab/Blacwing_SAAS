# API reference

The control-plane REST API is described by an OpenAPI 3.1 document generated from the Zod contracts in
`@blackwing/contracts` (CONTEXT_PACK [§9](../architecture/CONTEXT_PACK.md#9-api-conventions)). The generated files are
committed and checked for drift in CI.

| Document | Contents |
|---|---|
| [`openapi.json`](openapi.json) | The control-plane REST API (`/v1`): resources, error codes and examples. |
| [`openapi/kill.v1.json`](openapi/kill.v1.json) | The kill-switch endpoints, versioned on their own. |

Regenerate with `pnpm openapi:generate`. `pnpm check:drift` fails when a generated file is stale.

Conventions that apply to every endpoint:

- Errors use RFC 9457 problem+json (`type`, `title`, `status`, `detail`, `code`, `traceId`).
- Lists are cursor-based (`?cursor=&limit=`, at most 200 per page).
- POST requests that create runs, exports or tickets require an `Idempotency-Key` header.
- Mutable resources use `If-Match` with the ETag for optimistic concurrency.
- Rate limits are per token and return `429` with `Retry-After`.

The internal Run Broker API (`/internal/broker/*`) is reachable only from the sandbox network and is not part of this
reference.
