# @blackwing/errors

The typed `AppError` hierarchy, the stable error-code registry and the RFC 9457 problem+json mapper
(CONTEXT_PACK §5: "Errors use a typed `AppError` hierarchy with stable `code`s"; §9: problem+json with
`type`, `title`, `status`, `detail`, `code`, `traceId`). Every package throws these errors, and every
API boundary turns them into problem+json through this package.

```ts
import { createProblemDetailsMapper, NotFoundError, toProblemResponse } from "@blackwing/errors";

throw new NotFoundError(`finding ${id} not visible to tenant ${tenantId}`, { detail: "No finding with that id." });

// At the boundary (the API exception filter, API epic), once per error:
const mapper = createProblemDetailsMapper({ environment: config.NODE_ENV, redact, log });
const { status, headers, body } = mapper.toProblemResponse(err, traceId);
// status 404, headers { "content-type": "application/problem+json", "cache-control": "no-store" }
// body { type: "https://errors.blackwing.dev/NOT_FOUND", title: "Resource not found", status: 404,
//        detail: "No finding with that id.", code: "NOT_FOUND", traceId }
```

## Error codes

`ERROR_CODES` in `src/codes.ts` is the one registry. The `ErrorCode` union, `httpStatusFor`, the
problem `type` URI and the titles all derive from it, so a code cannot exist without a status. It is
frozen. Codes are public API: never rename or reuse one, add a new one instead.

| Code | HTTP | Subclass | Retryable by default |
|---|---|---|---|
| `VALIDATION_FAILED` | 422 | `ValidationError` | no |
| `UNAUTHENTICATED` | 401 | `AuthError` | no |
| `FORBIDDEN` | 403 | `ForbiddenError` | no |
| `NOT_FOUND` | 404 | `NotFoundError` | no |
| `CONFLICT` | 409 | `ConflictError` | no |
| `PRECONDITION_FAILED` | 412 | `PreconditionFailedError` | no |
| `RATE_LIMITED` | 429 | `RateLimitedError` (`retryAfterSeconds` sets `Retry-After`) | yes |
| `ILLEGAL_RUN_TRANSITION` | 409 | `IllegalRunTransitionError(from, to)` | no |
| `TENANT_CONTEXT_MISSING` | 500 | `TenantContextMissingError` (fails closed, §7/§8.6) | no |
| `KILL_SWITCH_ACTIVE` | 423 | `KillSwitchActiveError` (`scope`: run/asset/tenant/global) | no |
| `SCOPE_VIOLATION` | 403 | `ScopeViolationError` | no |
| `SCOPE_INTRUSIVENESS_EXCEEDS_CEILING` | 403 | `IntrusivenessError` (in `@blackwing/contracts`, SCOPE-003) | no |
| `SCOPE_DESTRUCTIVE_FORBIDDEN` | 403 | `IntrusivenessError` (in `@blackwing/contracts`, SCOPE-003) | no |
| `SCOPE_INVALID_CLASS` | 422 | `IntrusivenessError` (in `@blackwing/contracts`, SCOPE-003) | no |
| `SCOPE_INVALID_BUDGET` | 422 | `BudgetError` (in `@blackwing/contracts`, SCOPE-004) | no |
| `SCOPE_BUDGET_EXCEEDS_SA` | 403 | `BudgetError` (in `@blackwing/contracts`, SCOPE-004) | no |
| `CONFIG_INVALID` | 500 | `ConfigValidationError` (in `@blackwing/config`, FOUND-007) | no |
| `INTERNAL` | 500 | `InternalError` | no |

`title` is the registry's English title (v1). Clients branch on `code`, never on `title` or `detail`.

## AppError

```ts
class AppError extends Error {
  readonly code: ErrorCode;     // stable machine key
  readonly httpStatus: number;  // always the registry status for `code`
  readonly detail?: string;     // client-facing explanation, optional
  readonly retryable: boolean;  // registry default, overridable per occurrence
  // cause?: unknown (standard ES2022 option, non-enumerable)
}
```

- `message` is for logs and `detail` is for the API caller. Write `detail` so that a client may read
  it: no secret, no internal identifier, no tenant information. For `NotFoundError` the caller must not
  be able to tell "does not exist" from "belongs to another tenant" (§8.6).
- `cause` is kept for the server-side log only. `JSON.stringify(err)` gives
  `{ name, code, httpStatus, retryable }`: no stack, cause or detail.
- Each epic adds its own subclasses on top of these (for example `class AssetNotVerifiedError extends
  ForbiddenError`). Add a registry code only for a new client-visible failure class.
- `isAppError(value)` also recognises instances from another copy of the package (a shared
  `Symbol.for` brand), and refuses any instance whose `code` is not registered.

## Mapper

`toProblemDetails(err, traceId, options?)` and `toProblemResponse(err, traceId, options?)` never throw:

- **AppError**: `type`, `title` and `status` come from the registry by `code`, never from the thrown
  object. `detail` is taken from the error, passed through the redactor, dropped if it contains a stack
  trace or is empty, and capped at 1024 characters.
- **Anything else** (a plain `Error`, a string, `undefined`, a hostile proxy): `INTERNAL`, 500, the
  generic title and no `detail`. The real failure goes only to the log sink, redacted.
- **5xx detail** is withheld unless `environment` is `development` or `test`. A missing `environment`
  behaves as production. This package never reads `process.env`; pass `config.NODE_ENV`.
- **4xx detail outside development/test** is shown only when `options.redact` (the registry redactor)
  is injected. Without it the mapper cannot know the registered secret values, so it drops every
  `detail` (fails closed, §8.7) rather than relying on the built-in patterns alone.
- **traceId** is echoed when it is 1-128 characters of `[A-Za-z0-9._:-]`, and is `"unknown"` otherwise.
- **Logging**: `options.log` is called exactly once per mapped error with `{ level, code, status,
  traceId, retryable, err }`, where `err` is `serializeErrorForLog(err)`: the cause chain (cut at depth 8
  or on a cycle) and stacks, every string redacted. `level` is `error` for 5xx and `warn` for 4xx. A
  failing sink is swallowed.

## Redaction

The secret-value registry belongs to `@blackwing/config` and `@blackwing/logger` (FOUND-007/FOUND-008),
which sit above this package in the dependency graph. The boundary therefore injects the logger's value
redactor (`redactText` from `@blackwing/logger`) as `options.redact`. It runs first. Then a built-in pass always runs, whatever was injected,
for Blackwing's own credential formats: `bwk_…`, `bw_pat_…`, `bw_ci_…`, `Bearer`/`Basic`/`Token`
values, URL userinfo and PEM private keys. If the injected redactor throws or returns something other
than a string, the text is dropped from the response (and replaced with `[REDACTED]` in the log). It
fails closed.

## Exports

| Export | Purpose |
|---|---|
| `AppError` and its subclasses, `isAppError` | Throwing and recognising errors |
| `ERROR_CODES`, `ERROR_CODE_LIST`, `ErrorCode`, `isErrorCode`, `httpStatusFor`, `problemTypeFor` | The registry |
| `toProblemDetails`, `toProblemResponse`, `createProblemDetailsMapper`, `PROBLEM_JSON_CONTENT_TYPE` | Boundary mapping |
| `serializeErrorForLog`, `redactBuiltinSecrets`, `containsStackTrace`, `REDACTED` | Logging helpers |
