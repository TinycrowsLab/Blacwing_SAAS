# API reference

The public `/v1` REST API, version 0.0.0. This page is generated from [`openapi.json`](openapi.json) by `pnpm openapi:generate`; do not edit it by hand. CI fails when it is stale.

It documents 2 operations. Read [Conventions](conventions.md) for pagination, idempotency, concurrency and errors, and [Authentication](auth.md) for tokens and scopes.

The internal Run Broker API (`/internal/broker`) is not part of this reference.

## Contents

- kill
  - [POST /kill](#post-kill)
  - [GET /kill/{id}](#get-killid)

## kill

Kill switch: stop every agent in a run, asset or tenant scope.

### POST /kill

**Trigger the kill switch for a run, asset or the whole tenant**

Requires kill:trigger and the Cedar Kill::trigger resource check. An asset_owner may kill only assets they own; only org_admin may kill the tenant. Propagation is asynchronous: poll the Location.

- Operation ID: `triggerKill`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter         | In     | Required | Type   | Description |
| ----------------- | ------ | -------- | ------ | ----------- |
| `Idempotency-Key` | header | yes      | string |             |

**Request body** (required)

Content type `application/json`: [KillTriggerRequest](#killtriggerrequest).

Example: Kill one run.

```json
{
  "scope": "run",
  "scopeRefId": "01890a5d-ac96-774b-bcce-b302099a8058",
  "reason": "unexpected 5xx spike"
}
```

Example: Kill every run on an asset.

```json
{
  "scope": "asset",
  "scopeRefId": "01890a5d-ac96-774b-bcce-b302099a8058",
  "reason": "change freeze"
}
```

Example: Kill every run in the tenant.

```json
{
  "scope": "tenant",
  "reason": "incident declared"
}
```

#### Response 202

Kill accepted. status is halted when nothing in scope was running.

| Header     | Description                                    |
| ---------- | ---------------------------------------------- |
| `Location` | URL of the kill event, /v1/kill/{killEventId}. |

Content type `application/json`: [KillTriggerResponse](#killtriggerresponse).

Example: initiated.

```json
{
  "killEventId": "01890a5d-ac96-774b-bcce-b302099a8057",
  "status": "initiated",
  "triggeredAt": "2026-10-20T10:00:00.000Z"
}
```

Example: nothing running.

```json
{
  "killEventId": "01890a5d-ac96-774b-bcce-b302099a8057",
  "status": "halted",
  "triggeredAt": "2026-10-20T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of IDEMPOTENCY_KEY_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Idempotency key required.

```json
{
  "type": "https://errors.blackwing.dev/IDEMPOTENCY_KEY_REQUIRED",
  "title": "Idempotency key required",
  "status": 400,
  "code": "IDEMPOTENCY_KEY_REQUIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 401

Problem details; code is one of UNAUTHENTICATED.

Content type `application/problem+json`: [Problem](#problem).

Example: Authentication required.

```json
{
  "type": "https://errors.blackwing.dev/UNAUTHENTICATED",
  "title": "Authentication required",
  "status": 401,
  "code": "UNAUTHENTICATED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 403

Problem details; code is one of KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE.

Content type `application/problem+json`: [Problem](#problem).

Example: Kill not permitted.

```json
{
  "type": "https://errors.blackwing.dev/KILL_FORBIDDEN",
  "title": "Kill not permitted",
  "status": 403,
  "code": "KILL_FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Global kill is not allowed on this endpoint.

```json
{
  "type": "https://errors.blackwing.dev/KILL_GLOBAL_NOT_ALLOWED_HERE",
  "title": "Global kill is not allowed on this endpoint",
  "status": 403,
  "code": "KILL_GLOBAL_NOT_ALLOWED_HERE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND.

Content type `application/problem+json`: [Problem](#problem).

Example: Resource not found.

```json
{
  "type": "https://errors.blackwing.dev/NOT_FOUND",
  "title": "Resource not found",
  "status": 404,
  "code": "NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, RUN_NOT_ACTIVE, SECRET_DISABLED, KEYCLOAK_CONFLICT.

Content type `application/problem+json`: [Problem](#problem).

Example: Conflict.

```json
{
  "type": "https://errors.blackwing.dev/CONFLICT",
  "title": "Conflict",
  "status": 409,
  "code": "CONFLICT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal run state transition.

```json
{
  "type": "https://errors.blackwing.dev/ILLEGAL_RUN_TRANSITION",
  "title": "Illegal run state transition",
  "status": 409,
  "code": "ILLEGAL_RUN_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Key version disabled.

```json
{
  "type": "https://errors.blackwing.dev/KEK_DISABLED",
  "title": "Key version disabled",
  "status": 409,
  "code": "KEK_DISABLED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Database serialization conflict.

```json
{
  "type": "https://errors.blackwing.dev/DB_SERIALIZATION_CONFLICT",
  "title": "Database serialization conflict",
  "status": 409,
  "code": "DB_SERIALIZATION_CONFLICT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Kill already in progress.

```json
{
  "type": "https://errors.blackwing.dev/KILL_ALREADY_IN_PROGRESS",
  "title": "Kill already in progress",
  "status": 409,
  "code": "KILL_ALREADY_IN_PROGRESS",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Run is not active.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_ACTIVE",
  "title": "Run is not active",
  "status": 409,
  "code": "RUN_NOT_ACTIVE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret disabled.

```json
{
  "type": "https://errors.blackwing.dev/SECRET_DISABLED",
  "title": "Secret disabled",
  "status": 409,
  "code": "SECRET_DISABLED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Identity provider conflict.

```json
{
  "type": "https://errors.blackwing.dev/KEYCLOAK_CONFLICT",
  "title": "Identity provider conflict",
  "status": 409,
  "code": "KEYCLOAK_CONFLICT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of KILL_SCOPE_INVALID, KILL_REF_REQUIRED, VALIDATION_FAILED, IDEMPOTENCY_KEY_MISMATCH.

Content type `application/problem+json`: [Problem](#problem).

Example: Invalid kill scope.

```json
{
  "type": "https://errors.blackwing.dev/KILL_SCOPE_INVALID",
  "title": "Invalid kill scope",
  "status": 422,
  "code": "KILL_SCOPE_INVALID",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Kill scope reference required.

```json
{
  "type": "https://errors.blackwing.dev/KILL_REF_REQUIRED",
  "title": "Kill scope reference required",
  "status": 422,
  "code": "KILL_REF_REQUIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Validation failed.

```json
{
  "type": "https://errors.blackwing.dev/VALIDATION_FAILED",
  "title": "Validation failed",
  "status": 422,
  "code": "VALIDATION_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Idempotency key reused with a different request.

```json
{
  "type": "https://errors.blackwing.dev/IDEMPOTENCY_KEY_MISMATCH",
  "title": "Idempotency key reused with a different request",
  "status": 422,
  "code": "IDEMPOTENCY_KEY_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 429

Problem details; code is one of RATE_LIMITED.

Content type `application/problem+json`: [Problem](#problem).

Example: Too many requests.

```json
{
  "type": "https://errors.blackwing.dev/RATE_LIMITED",
  "title": "Too many requests",
  "status": 429,
  "code": "RATE_LIMITED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 500

Problem details; code is one of INTERNAL.

Content type `application/problem+json`: [Problem](#problem).

Example: Internal server error.

```json
{
  "type": "https://errors.blackwing.dev/INTERNAL",
  "title": "Internal server error",
  "status": 500,
  "code": "INTERNAL",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

### GET /kill/{id}

**A kill event with its halt timings**

- Operation ID: `getKillEvent`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type          | Description |
| --------- | ---- | -------- | ------------- | ----------- |
| `id`      | path | yes      | string (uuid) |             |

#### Response 200

The kill event.

Content type `application/json`: [KillEvent](#killevent).

Example: halted.

```json
{
  "killEventId": "01890a5d-ac96-774b-bcce-b302099a8057",
  "tenantId": "01890a5d-ac96-774b-bcce-b302099a8058",
  "scope": "run",
  "scopeRefId": "01890a5d-ac96-774b-bcce-b302099a8058",
  "source": "api",
  "actorType": "user",
  "actorRef": "01890a5d-ac96-774b-bcce-b302099a8058",
  "reason": "unexpected 5xx spike",
  "status": "halted",
  "triggeredAt": "2026-10-20T10:00:00.000Z",
  "egressBlockedAt": "2026-10-20T10:00:00.400Z",
  "sandboxesTerminatedAt": "2026-10-20T10:00:03.100Z",
  "keysRevokedAt": "2026-10-20T10:00:03.200Z",
  "workflowsCancelledAt": "2026-10-20T10:00:03.300Z",
  "completedAt": "2026-10-20T10:00:03.300Z",
  "haltMs": 3300,
  "affected": {
    "runs": 1,
    "sessions": 2,
    "sandboxes": 2,
    "keys": 2,
    "workflows": 3
  },
  "reenabledAt": null,
  "reenabledBy": null,
  "createdAt": "2026-10-20T10:00:00.000Z",
  "updatedAt": "2026-10-20T10:00:03.300Z"
}
```

#### Response 400

Problem details; code is one of SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Malformed request.

```json
{
  "type": "https://errors.blackwing.dev/SBX_BAD_REQUEST",
  "title": "Malformed request",
  "status": 400,
  "code": "SBX_BAD_REQUEST",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Idempotency key required.

```json
{
  "type": "https://errors.blackwing.dev/IDEMPOTENCY_KEY_REQUIRED",
  "title": "Idempotency key required",
  "status": 400,
  "code": "IDEMPOTENCY_KEY_REQUIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 401

Problem details; code is one of UNAUTHENTICATED.

Content type `application/problem+json`: [Problem](#problem).

Example: Authentication required.

```json
{
  "type": "https://errors.blackwing.dev/UNAUTHENTICATED",
  "title": "Authentication required",
  "status": 401,
  "code": "UNAUTHENTICATED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 403

Problem details; code is one of KILL_FORBIDDEN.

Content type `application/problem+json`: [Problem](#problem).

Example: Kill not permitted.

```json
{
  "type": "https://errors.blackwing.dev/KILL_FORBIDDEN",
  "title": "Kill not permitted",
  "status": 403,
  "code": "KILL_FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND.

Content type `application/problem+json`: [Problem](#problem).

Example: Resource not found.

```json
{
  "type": "https://errors.blackwing.dev/NOT_FOUND",
  "title": "Resource not found",
  "status": 404,
  "code": "NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, RUN_NOT_ACTIVE, SECRET_DISABLED, KEYCLOAK_CONFLICT.

Content type `application/problem+json`: [Problem](#problem).

Example: Conflict.

```json
{
  "type": "https://errors.blackwing.dev/CONFLICT",
  "title": "Conflict",
  "status": 409,
  "code": "CONFLICT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal run state transition.

```json
{
  "type": "https://errors.blackwing.dev/ILLEGAL_RUN_TRANSITION",
  "title": "Illegal run state transition",
  "status": 409,
  "code": "ILLEGAL_RUN_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Key version disabled.

```json
{
  "type": "https://errors.blackwing.dev/KEK_DISABLED",
  "title": "Key version disabled",
  "status": 409,
  "code": "KEK_DISABLED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Database serialization conflict.

```json
{
  "type": "https://errors.blackwing.dev/DB_SERIALIZATION_CONFLICT",
  "title": "Database serialization conflict",
  "status": 409,
  "code": "DB_SERIALIZATION_CONFLICT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Kill already in progress.

```json
{
  "type": "https://errors.blackwing.dev/KILL_ALREADY_IN_PROGRESS",
  "title": "Kill already in progress",
  "status": 409,
  "code": "KILL_ALREADY_IN_PROGRESS",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Run is not active.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_ACTIVE",
  "title": "Run is not active",
  "status": 409,
  "code": "RUN_NOT_ACTIVE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret disabled.

```json
{
  "type": "https://errors.blackwing.dev/SECRET_DISABLED",
  "title": "Secret disabled",
  "status": 409,
  "code": "SECRET_DISABLED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Identity provider conflict.

```json
{
  "type": "https://errors.blackwing.dev/KEYCLOAK_CONFLICT",
  "title": "Identity provider conflict",
  "status": 409,
  "code": "KEYCLOAK_CONFLICT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, AUDIT_EVENT_INVALID.

Content type `application/problem+json`: [Problem](#problem).

Example: Validation failed.

```json
{
  "type": "https://errors.blackwing.dev/VALIDATION_FAILED",
  "title": "Validation failed",
  "status": 422,
  "code": "VALIDATION_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Invalid intrusiveness class.

```json
{
  "type": "https://errors.blackwing.dev/SCOPE_INVALID_CLASS",
  "title": "Invalid intrusiveness class",
  "status": 422,
  "code": "SCOPE_INVALID_CLASS",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Invalid request budget.

```json
{
  "type": "https://errors.blackwing.dev/SCOPE_INVALID_BUDGET",
  "title": "Invalid request budget",
  "status": 422,
  "code": "SCOPE_INVALID_BUDGET",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Invalid scope rule.

```json
{
  "type": "https://errors.blackwing.dev/SCOPE_INVALID_RULE",
  "title": "Invalid scope rule",
  "status": 422,
  "code": "SCOPE_INVALID_RULE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Unknown persona.

```json
{
  "type": "https://errors.blackwing.dev/PERSONA_UNKNOWN",
  "title": "Unknown persona",
  "status": 422,
  "code": "PERSONA_UNKNOWN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Forbidden tool in persona.

```json
{
  "type": "https://errors.blackwing.dev/PERSONA_FORBIDDEN_TOOL",
  "title": "Forbidden tool in persona",
  "status": 422,
  "code": "PERSONA_FORBIDDEN_TOOL",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Invalid persona definition.

```json
{
  "type": "https://errors.blackwing.dev/PERSONA_INVALID",
  "title": "Invalid persona definition",
  "status": 422,
  "code": "PERSONA_INVALID",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Invalid secret envelope.

```json
{
  "type": "https://errors.blackwing.dev/ENVELOPE_INVALID",
  "title": "Invalid secret envelope",
  "status": 422,
  "code": "ENVELOPE_INVALID",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Invalid prompt file.

```json
{
  "type": "https://errors.blackwing.dev/PROMPT_INVALID",
  "title": "Invalid prompt file",
  "status": 422,
  "code": "PROMPT_INVALID",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Prompt placeholder unfilled.

```json
{
  "type": "https://errors.blackwing.dev/PROMPT_PLACEHOLDER_MISSING",
  "title": "Prompt placeholder unfilled",
  "status": 422,
  "code": "PROMPT_PLACEHOLDER_MISSING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Invalid secret reference.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_SECRET_REF",
  "title": "Invalid secret reference",
  "status": 422,
  "code": "INVALID_SECRET_REF",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Sandbox image missing.

```json
{
  "type": "https://errors.blackwing.dev/SBX_IMAGE_MISSING",
  "title": "Sandbox image missing",
  "status": 422,
  "code": "SBX_IMAGE_MISSING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Invalid kill scope.

```json
{
  "type": "https://errors.blackwing.dev/KILL_SCOPE_INVALID",
  "title": "Invalid kill scope",
  "status": 422,
  "code": "KILL_SCOPE_INVALID",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Kill scope reference required.

```json
{
  "type": "https://errors.blackwing.dev/KILL_REF_REQUIRED",
  "title": "Kill scope reference required",
  "status": 422,
  "code": "KILL_REF_REQUIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Idempotency key reused with a different request.

```json
{
  "type": "https://errors.blackwing.dev/IDEMPOTENCY_KEY_MISMATCH",
  "title": "Idempotency key reused with a different request",
  "status": 422,
  "code": "IDEMPOTENCY_KEY_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Invalid audit event.

```json
{
  "type": "https://errors.blackwing.dev/AUDIT_EVENT_INVALID",
  "title": "Invalid audit event",
  "status": 422,
  "code": "AUDIT_EVENT_INVALID",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 429

Problem details; code is one of RATE_LIMITED.

Content type `application/problem+json`: [Problem](#problem).

Example: Too many requests.

```json
{
  "type": "https://errors.blackwing.dev/RATE_LIMITED",
  "title": "Too many requests",
  "status": 429,
  "code": "RATE_LIMITED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 500

Problem details; code is one of INTERNAL.

Content type `application/problem+json`: [Problem](#problem).

Example: Internal server error.

```json
{
  "type": "https://errors.blackwing.dev/INTERNAL",
  "title": "Internal server error",
  "status": 500,
  "code": "INTERNAL",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

## Schemas

### KillEvent

| Property                | Type                                                                               | Required | Description |
| ----------------------- | ---------------------------------------------------------------------------------- | -------- | ----------- |
| `killEventId`           | string                                                                             | yes      |             |
| `tenantId`              | string or null                                                                     | yes      |             |
| `scope`                 | enum: `"run"`, `"asset"`, `"tenant"`, `"global"`                                   | yes      |             |
| `scopeRefId`            | string or null                                                                     | yes      |             |
| `source`                | enum: `"console"`, `"api"`, `"soc_link"`, `"operator"`, `"system"`                 | yes      |             |
| `actorType`             | string                                                                             | yes      |             |
| `actorRef`              | string                                                                             | yes      |             |
| `reason`                | string                                                                             | yes      |             |
| `status`                | enum: `"initiated"`, `"propagating"`, `"halted"`, `"partially_halted"`, `"failed"` | yes      |             |
| `triggeredAt`           | string (date-time)                                                                 | yes      |             |
| `egressBlockedAt`       | string (date-time) or null                                                         | yes      |             |
| `sandboxesTerminatedAt` | string (date-time) or null                                                         | yes      |             |
| `keysRevokedAt`         | string (date-time) or null                                                         | yes      |             |
| `workflowsCancelledAt`  | string (date-time) or null                                                         | yes      |             |
| `completedAt`           | string (date-time) or null                                                         | yes      |             |
| `haltMs`                | integer or null                                                                    | yes      |             |
| `affected`              | object                                                                             | yes      |             |
| `reenabledAt`           | string (date-time) or null                                                         | yes      |             |
| `reenabledBy`           | string or null                                                                     | yes      |             |
| `createdAt`             | string (date-time)                                                                 | yes      |             |
| `updatedAt`             | string (date-time)                                                                 | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "killEventId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "tenantId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "scope": {
      "type": "string",
      "enum": ["run", "asset", "tenant", "global"]
    },
    "scopeRefId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "source": {
      "type": "string",
      "enum": ["console", "api", "soc_link", "operator", "system"]
    },
    "actorType": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "actorRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255
    },
    "reason": {
      "type": "string",
      "maxLength": 2000
    },
    "status": {
      "type": "string",
      "enum": ["initiated", "propagating", "halted", "partially_halted", "failed"]
    },
    "triggeredAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    },
    "egressBlockedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "sandboxesTerminatedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "keysRevokedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "workflowsCancelledAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "completedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "haltMs": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        {
          "type": "null"
        }
      ]
    },
    "affected": {
      "type": "object",
      "properties": {
        "egress": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "identity": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255
              },
              "outcome": {
                "type": "string",
                "enum": ["blocked", "already_blocked", "failed"]
              }
            },
            "required": ["identity", "outcome"],
            "additionalProperties": false
          }
        },
        "runs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "sessions": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "sandboxes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "sandboxResults": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "sandboxId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255
              },
              "outcome": {
                "type": "string",
                "enum": ["terminated", "already_gone", "terminating", "failed"]
              }
            },
            "required": ["sandboxId", "outcome"],
            "additionalProperties": false
          }
        },
        "keys": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "keyResults": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "keyId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255
              },
              "outcome": {
                "type": "string",
                "enum": ["revoked", "already_revoked", "failed"]
              }
            },
            "required": ["keyId", "outcome"],
            "additionalProperties": false
          }
        },
        "workflows": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "workflowResults": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "workflowId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255
              },
              "outcome": {
                "type": "string",
                "enum": ["cancelled", "already_closed", "not_found", "failed"]
              }
            },
            "required": ["workflowId", "outcome"],
            "additionalProperties": false
          }
        },
        "reversalsFlagged": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "additionalProperties": false
    },
    "reenabledAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
        },
        {
          "type": "null"
        }
      ]
    },
    "reenabledBy": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    }
  },
  "required": [
    "killEventId",
    "tenantId",
    "scope",
    "scopeRefId",
    "source",
    "actorType",
    "actorRef",
    "reason",
    "status",
    "triggeredAt",
    "egressBlockedAt",
    "sandboxesTerminatedAt",
    "keysRevokedAt",
    "workflowsCancelledAt",
    "completedAt",
    "haltMs",
    "affected",
    "reenabledAt",
    "reenabledBy",
    "createdAt",
    "updatedAt"
  ],
  "additionalProperties": false
}
```

### KillTriggerRequest

| Property     | Type                                 | Required | Description |
| ------------ | ------------------------------------ | -------- | ----------- |
| `scope`      | enum: `"run"`, `"asset"`, `"tenant"` | yes      |             |
| `scopeRefId` | string                               | no       |             |
| `reason`     | string                               | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": ["run", "asset", "tenant"]
    },
    "scopeRefId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "reason": {
      "type": "string",
      "maxLength": 2000
    }
  },
  "required": ["scope", "reason"],
  "additionalProperties": false
}
```

### KillTriggerResponse

| Property      | Type                                                                               | Required | Description |
| ------------- | ---------------------------------------------------------------------------------- | -------- | ----------- |
| `killEventId` | string                                                                             | yes      |             |
| `status`      | enum: `"initiated"`, `"propagating"`, `"halted"`, `"partially_halted"`, `"failed"` | yes      |             |
| `triggeredAt` | string (date-time)                                                                 | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "killEventId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "status": {
      "type": "string",
      "enum": ["initiated", "propagating", "halted", "partially_halted", "failed"]
    },
    "triggeredAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    }
  },
  "required": ["killEventId", "status", "triggeredAt"],
  "additionalProperties": false
}
```

### Problem

| Property  | Type            | Required | Description |
| --------- | --------------- | -------- | ----------- |
| `type`    | string (uri)    | yes      |             |
| `title`   | string          | yes      |             |
| `status`  | integer         | yes      |             |
| `detail`  | string          | no       |             |
| `code`    | string          | yes      |             |
| `traceId` | string          | yes      |             |
| `errors`  | array of object | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "format": "uri"
    },
    "title": {
      "type": "string"
    },
    "status": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "detail": {
      "type": "string"
    },
    "code": {
      "type": "string"
    },
    "traceId": {
      "type": "string"
    },
    "errors": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          },
          "message": {
            "type": "string"
          },
          "code": {
            "type": "string"
          }
        },
        "required": ["path", "message", "code"],
        "additionalProperties": false
      }
    }
  },
  "required": ["type", "title", "status", "code", "traceId"],
  "additionalProperties": false
}
```
