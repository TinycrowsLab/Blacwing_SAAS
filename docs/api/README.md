# API reference

The control-plane REST API is described by an OpenAPI 3.1 document generated from the Zod contracts in
`@blackwing/contracts` (CONTEXT_PACK [§9](../architecture/CONTEXT_PACK.md#9-api-conventions)). The generated files are
committed and checked for drift in CI.

| Document | Contents |
|---|---|
| [`openapi.json`](openapi.json) | The control-plane REST API (`/v1`): resources, error codes and examples. |
| [`openapi/kill.v1.json`](openapi/kill.v1.json) | The kill-switch endpoints, versioned on their own. |
| [`reference.md`](reference.md) | The API reference: every operation, parameter, request and response, schema and example, generated from `openapi.json`. |
| [`conventions.md`](conventions.md) | Base URL, errors (problem+json and error codes), pagination, idempotency, ETag/If-Match and rate limits. |
| [`auth.md`](auth.md) | Session cookies, personal access tokens (`bw_pat_`), CI tokens (`bw_ci_`), scopes and safe handling. |
| [`openapi/operator-kill.v1.json`](openapi/operator-kill.v1.json) | The platform-operator global and tenant kill control (`/operator/v1/kill`). |

Regenerate with `pnpm openapi:generate`, which also writes `reference.md` (`pnpm api-reference:check` fails when it is
stale). `pnpm check:drift` fails when a generated file is stale. The docs site (`pnpm docs:build`) publishes these pages.

The typed TypeScript client (`packages/api-client`, `@blackwing/api-client`) is generated from `openapi.json` by
`pnpm --filter @blackwing/api-client api-client:gen` (also run by `pnpm openapi:generate`). It has one typed method
per `operationId`, throws `ApiProblemError` for problem+json answers, follows `nextCursor` with `paginate()`, and
sets `Idempotency-Key` and `If-Match` through `withIdempotencyKey()` and `withIfMatch()`. A unit test fails when the
committed client is stale.

Conventions that apply to every endpoint:

- Errors use RFC 9457 problem+json (`type`, `title`, `status`, `detail`, `code`, `traceId`).
- Lists are cursor-based (`?cursor=&limit=`, at most 200 per page).
- POST requests that create runs, exports or tickets require an `Idempotency-Key` header.
- Mutable resources use `If-Match` with the ETag for optimistic concurrency.
- Rate limits are per token and return `429` with `Retry-After`.

The internal Run Broker API (`/internal/broker/*`) is reachable only from the sandbox network and is not part of this
reference.
