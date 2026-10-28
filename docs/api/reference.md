# API reference

The public `/v1` REST API, version 0.0.0. This page is generated from [`openapi.json`](openapi.json) by `pnpm openapi:generate`; do not edit it by hand. CI fails when it is stale.

It documents 10 operations. Read [Conventions](conventions.md) for pagination, idempotency, concurrency and errors, and [Authentication](auth.md) for tokens and scopes.

The internal Run Broker API (`/internal/broker`) is not part of this reference.

## Contents

- kill
  - [POST /kill](#post-kill)
  - [GET /kill/{id}](#get-killid)
- audit
  - [GET /audit/events](#get-auditevents)
- runs
  - [GET /runs/{runId}/events](#get-runsrunidevents)
- personas
  - [GET /personas](#get-personas)
  - [GET /personas/{persona}](#get-personaspersona)
  - [GET /personas/{persona}/override](#get-personaspersonaoverride)
  - [PUT /personas/{persona}/override](#put-personaspersonaoverride)
- signup
  - [POST /signup](#post-signup)
  - [POST /signup/verify](#post-signupverify)

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

Problem details; code is one of INVALID_CURSOR, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

Content type `application/problem+json`: [Problem](#problem).

Example: Invalid cursor.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_CURSOR",
  "title": "Invalid cursor",
  "status": 400,
  "code": "INVALID_CURSOR",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

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

Example: Signup token invalid or expired.

```json
{
  "type": "https://errors.blackwing.dev/SIGNUP_TOKEN_INVALID",
  "title": "Signup token invalid or expired",
  "status": 400,
  "code": "SIGNUP_TOKEN_INVALID",
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

## audit

Audit ledger search: read-only, tenant-scoped, cursor-paginated (F34, §8.8).

### GET /audit/events

**Search the audit ledger of the caller tenant**

Requires audit:read (auditor, org_admin). Newest first, by (occurredAt, seq). The tenant comes from the caller, never from the query. `from` and `to` are ISO-8601 UTC with a Z. Pass the previous nextCursor to continue; a cursor is bound to its filters. The query itself is recorded as audit.queried. includeChain=true needs the auditor role.

- Operation ID: `listAuditEvents`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter      | In    | Required | Type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Description                               |
| -------------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `actorId`      | query | no       | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |                                           |
| `action`       | query | no       | enum: `"auth.login"`, `"auth.logout"`, `"auth.sso_link"`, `"auth.api_token_issued"`, `"auth.api_token_revoked"`, `"authz.denied"`, `"authz.role_changed"`, `"asset.created"`, `"asset.verified"`, `"sa.requested"`, `"sa.approved"`, `"sa.rejected"`, `"sa.revoked"`, `"gate1.decided"`, `"gate2.decided"`, `"gate3.released"`, `"run.created"`, `"run.state_changed"`, `"tool.invoked"`, `"egress.blocked"`, `"kill.fired"`, `"kill.completed"`, `"finding.released"`, `"finding.risk_accepted"`, `"export.generated"`, `"secret.resolved"`, `"config.changed"`, `"connector.configured"`, `"kill.triggered"`, `"kill.forbidden"`, `"kill.egress_blocked"`, `"kill.sandboxes_terminated"`, `"secret.kek_provisioned"`, `"secret.kek_rotated"`, `"secret.kek_disabled"`, `"kill.keys_revoked"`, `"kill.workflows_cancelled"`, `"activity.started"`, `"activity.succeeded"`, `"activity.failed"`, `"workflow.started"`, `"workflow.completed"`, `"workflow.failed"`, `"workflow.cancelled"`, `"workflow.continued_as_new"`, `"soc_kill.link_minted"`, `"soc_kill.triggered"`, `"soc_kill.rejected"`, `"outbox.delivery_failed"`, `"scope.request.created"`, `"scope.request.status_changed"`, `"operator.kill_previewed"`, `"operator.kill_fired"`, `"audit.queried"`, `"secret.rotated"`, `"secret.rewrapped"`, `"persona.override_changed"`, `"auth.sso_config_changed"`, `"tenant.created"`, `"signup.verified"` |                                           |
| `targetId`     | query | no       | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |                                           |
| `runId`        | query | no       | string (uuid)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                           |
| `outcome`      | query | no       | enum: `"success"`, `"failure"`, `"denied"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                           |
| `from`         | query | no       | string (date-time)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                           |
| `to`           | query | no       | string (date-time)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                           |
| `includeChain` | query | no       | enum: `"true"`, `"false"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Auditors only: include hash and prevHash. |
| `cursor`       | query | no       | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |                                           |
| `limit`        | query | no       | integer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                           |

#### Response 200

One page of events, newest first. nextCursor is absent on the last page.

Content type `application/json`: object.

Example: A page with a next cursor.

```json
{
  "items": [
    {
      "id": "01890a5d-ac96-774b-bcce-b302099a8057",
      "seq": 42,
      "occurredAt": "2026-10-20T10:00:00.000Z",
      "action": "kill.fired",
      "severity": "critical",
      "actor": {
        "type": "user",
        "id": "usr_01jabc"
      },
      "target": {
        "type": "run",
        "id": "01890a5d-ac96-774b-bcce-b302099a8058"
      },
      "outcome": "success",
      "reason": "unexpected 5xx spike",
      "metadata": {
        "scope": "run"
      },
      "traceId": null,
      "runId": "01890a5d-ac96-774b-bcce-b302099a8058"
    }
  ],
  "nextCursor": "eyJrIjpbIjIwMjYtMTAtMjBUMTA6MDA6MDAuMDAwWiIsNDJdfQ.c2ln"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR.

Content type `application/problem+json`: [Problem](#problem).

Example: Invalid cursor.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_CURSOR",
  "title": "Invalid cursor",
  "status": 400,
  "code": "INVALID_CURSOR",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING.

Content type `application/problem+json`: [Problem](#problem).

Example: Forbidden.

```json
{
  "type": "https://errors.blackwing.dev/FORBIDDEN",
  "title": "Forbidden",
  "status": 403,
  "code": "FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_CONTEXT_MISSING",
  "title": "Tenant context missing",
  "status": 403,
  "code": "TENANT_CONTEXT_MISSING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND.

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

Example: Persona not defined.

```json
{
  "type": "https://errors.blackwing.dev/PERSONA_NOT_DEFINED",
  "title": "Persona not defined",
  "status": 404,
  "code": "PERSONA_NOT_DEFINED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: No released prompt version.

```json
{
  "type": "https://errors.blackwing.dev/PROMPT_NO_RELEASED_VERSION",
  "title": "No released prompt version",
  "status": 404,
  "code": "PROMPT_NO_RELEASED_VERSION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret not found.

```json
{
  "type": "https://errors.blackwing.dev/SECRET_NOT_FOUND",
  "title": "Secret not found",
  "status": 404,
  "code": "SECRET_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Identity provider resource not found.

```json
{
  "type": "https://errors.blackwing.dev/KEYCLOAK_NOT_FOUND",
  "title": "Identity provider resource not found",
  "status": 404,
  "code": "KEYCLOAK_NOT_FOUND",
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

Problem details; code is one of VALIDATION_FAILED.

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

## runs

Live run events over Server-Sent Events, with resume after disconnect.

### GET /runs/{runId}/events

**Stream the live events of one run (text/event-stream)**

Requires run:read in the caller tenant. A run outside that tenant answers 403 exactly like a missing one. Each run event is one frame: `id` is the stream entry id, `event` the run event type, `data` the JSON event. Reconnect with the `Last-Event-ID` header (or `lastEventId` query) to replay the missed events; at most API_SSE_MAX_REPLAY are replayed. Control frames (no id): `state` and `end` for a finished run or a terminal event, `resync` (refetch the run: events were trimmed, the client was too slow, or the replay was too long), `timeout` (API_SSE_MAX_DURATION_MS reached) and `error` (the event source failed; reconnect with backoff). The `event` names `state`, `resync`, `end`, `timeout` and `error` are reserved for control frames. A heartbeat comment (`: heartbeat`) is sent every API_SSE_HEARTBEAT_MS while idle.

- Operation ID: `streamRunEvents`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter       | In     | Required | Type          | Description                                                            |
| --------------- | ------ | -------- | ------------- | ---------------------------------------------------------------------- |
| `runId`         | path   | yes      | string (uuid) |                                                                        |
| `Last-Event-ID` | header | no       | string        | Stream id of the last event received; resumes after it.                |
| `lastEventId`   | query  | no       | string        | Same as the Last-Event-ID header, for clients that cannot set headers. |

#### Response 200

The event stream.

Content type `text/event-stream`: string.

Example: Example.

```json
"id: 1700000000000-0\nevent: message.partial\ndata: {\"type\":\"message.partial\",\"ts\":\"2026-10-20T10:00:00.000Z\",\"seq\":1,\"payload\":{}}\n\n"
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

Content type `application/problem+json`: [Problem](#problem).

Example: Invalid cursor.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_CURSOR",
  "title": "Invalid cursor",
  "status": 400,
  "code": "INVALID_CURSOR",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

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

Example: Signup token invalid or expired.

```json
{
  "type": "https://errors.blackwing.dev/SIGNUP_TOKEN_INVALID",
  "title": "Signup token invalid or expired",
  "status": 400,
  "code": "SIGNUP_TOKEN_INVALID",
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

Problem details; code is one of TENANT_CONTEXT_MISSING, FORBIDDEN.

Content type `application/problem+json`: [Problem](#problem).

Example: Tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_CONTEXT_MISSING",
  "title": "Tenant context missing",
  "status": 403,
  "code": "TENANT_CONTEXT_MISSING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Forbidden.

```json
{
  "type": "https://errors.blackwing.dev/FORBIDDEN",
  "title": "Forbidden",
  "status": 403,
  "code": "FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND.

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

Example: Persona not defined.

```json
{
  "type": "https://errors.blackwing.dev/PERSONA_NOT_DEFINED",
  "title": "Persona not defined",
  "status": 404,
  "code": "PERSONA_NOT_DEFINED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: No released prompt version.

```json
{
  "type": "https://errors.blackwing.dev/PROMPT_NO_RELEASED_VERSION",
  "title": "No released prompt version",
  "status": 404,
  "code": "PROMPT_NO_RELEASED_VERSION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret not found.

```json
{
  "type": "https://errors.blackwing.dev/SECRET_NOT_FOUND",
  "title": "Secret not found",
  "status": 404,
  "code": "SECRET_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Identity provider resource not found.

```json
{
  "type": "https://errors.blackwing.dev/KEYCLOAK_NOT_FOUND",
  "title": "Identity provider resource not found",
  "status": 404,
  "code": "KEYCLOAK_NOT_FOUND",
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

Problem details; code is one of VALIDATION_FAILED.

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

## personas

The persona registry (definitions with the tenant effective settings) and tenant overrides of a persona: effort, turn and spend budgets, and standard-tier lowering.

### GET /personas

**The persona registry for the caller tenant**

Requires run:read, which every tenant role holds. Lists the fixed roster of personas in roster order, each with the settings a run of the caller tenant would pin (the tenant override merged in). Guardrail flags and internal fields are not published.

- Operation ID: `listPersonas`
- Authentication: `bearerAuth` or `sessionCookie`

#### Response 200

The PersonaRegistryList view.

Content type `application/json`: [PersonaRegistryList](#personaregistrylist).

Example: set.

```json
{
  "items": [
    {
      "name": "osint",
      "mandate": "Gather public information about approved assets.",
      "promptVersion": "1.0.0",
      "tierAlias": "standard",
      "effective": {
        "model": "claude-opus-5-5",
        "effort": "low",
        "maxTurns": 10,
        "maxBudgetUsd": 2
      },
      "overridden": ["effort", "maxTurns"],
      "allowedTools": ["Read"],
      "disallowedTools": ["WebFetch", "WebSearch"],
      "declaredOracleTypes": [],
      "inputs": ["scope"],
      "intrusivenessCeiling": "passive",
      "requiresSubmission": false,
      "helpers": []
    }
  ]
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

Content type `application/problem+json`: [Problem](#problem).

Example: Invalid cursor.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_CURSOR",
  "title": "Invalid cursor",
  "status": 400,
  "code": "INVALID_CURSOR",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

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

Example: Signup token invalid or expired.

```json
{
  "type": "https://errors.blackwing.dev/SIGNUP_TOKEN_INVALID",
  "title": "Signup token invalid or expired",
  "status": 400,
  "code": "SIGNUP_TOKEN_INVALID",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING.

Content type `application/problem+json`: [Problem](#problem).

Example: Forbidden.

```json
{
  "type": "https://errors.blackwing.dev/FORBIDDEN",
  "title": "Forbidden",
  "status": 403,
  "code": "FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_CONTEXT_MISSING",
  "title": "Tenant context missing",
  "status": 403,
  "code": "TENANT_CONTEXT_MISSING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND.

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

Example: Persona not defined.

```json
{
  "type": "https://errors.blackwing.dev/PERSONA_NOT_DEFINED",
  "title": "Persona not defined",
  "status": 404,
  "code": "PERSONA_NOT_DEFINED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: No released prompt version.

```json
{
  "type": "https://errors.blackwing.dev/PROMPT_NO_RELEASED_VERSION",
  "title": "No released prompt version",
  "status": 404,
  "code": "PROMPT_NO_RELEASED_VERSION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret not found.

```json
{
  "type": "https://errors.blackwing.dev/SECRET_NOT_FOUND",
  "title": "Secret not found",
  "status": 404,
  "code": "SECRET_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Identity provider resource not found.

```json
{
  "type": "https://errors.blackwing.dev/KEYCLOAK_NOT_FOUND",
  "title": "Identity provider resource not found",
  "status": 404,
  "code": "KEYCLOAK_NOT_FOUND",
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

### GET /personas/{persona}

**One persona of the registry for the caller tenant**

Requires run:read. The same view as the list, for one persona of the fixed roster.

- Operation ID: `getPersona`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type                                                                                                                                                                                                                                                                                                                                                                                  | Description                    |
| --------- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `persona` | path | yes      | enum: `"orchestrator"`, `"planner"`, `"sub-planner"`, `"passive-recon"`, `"osint"`, `"active-recon"`, `"threat-intel"`, `"source-spec-ingestion"`, `"session-setup"`, `"web-api-specialist"`, `"auth-logic-specialist"`, `"infrastructure-specialist"`, `"code-specialist"`, `"exploit-developer"`, `"mentor"`, `"reflector"`, `"validator-assistant"`, `"reporter"`, `"remediation"` | A persona of the fixed roster. |

#### Response 200

The PersonaRegistryView view.

Content type `application/json`: [PersonaRegistryView](#personaregistryview).

Example: set.

```json
{
  "name": "osint",
  "mandate": "Gather public information about approved assets.",
  "promptVersion": "1.0.0",
  "tierAlias": "standard",
  "effective": {
    "model": "claude-opus-5-5",
    "effort": "low",
    "maxTurns": 10,
    "maxBudgetUsd": 2
  },
  "overridden": ["effort", "maxTurns"],
  "allowedTools": ["Read"],
  "disallowedTools": ["WebFetch", "WebSearch"],
  "declaredOracleTypes": [],
  "inputs": ["scope"],
  "intrusivenessCeiling": "passive",
  "requiresSubmission": false,
  "helpers": []
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

Content type `application/problem+json`: [Problem](#problem).

Example: Invalid cursor.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_CURSOR",
  "title": "Invalid cursor",
  "status": 400,
  "code": "INVALID_CURSOR",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

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

Example: Signup token invalid or expired.

```json
{
  "type": "https://errors.blackwing.dev/SIGNUP_TOKEN_INVALID",
  "title": "Signup token invalid or expired",
  "status": 400,
  "code": "SIGNUP_TOKEN_INVALID",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING.

Content type `application/problem+json`: [Problem](#problem).

Example: Forbidden.

```json
{
  "type": "https://errors.blackwing.dev/FORBIDDEN",
  "title": "Forbidden",
  "status": 403,
  "code": "FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_CONTEXT_MISSING",
  "title": "Tenant context missing",
  "status": 403,
  "code": "TENANT_CONTEXT_MISSING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of PERSONA_NOT_DEFINED.

Content type `application/problem+json`: [Problem](#problem).

Example: Persona not defined.

```json
{
  "type": "https://errors.blackwing.dev/PERSONA_NOT_DEFINED",
  "title": "Persona not defined",
  "status": 404,
  "code": "PERSONA_NOT_DEFINED",
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

Problem details; code is one of PERSONA_UNKNOWN.

Content type `application/problem+json`: [Problem](#problem).

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

### GET /personas/{persona}/override

**The tenant override of a persona**

Requires settings:read. Answers the override the tenant set, or null when none is set (the base values apply).

- Operation ID: `getPersonaOverride`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type                                                                                                                                                                                                                                                                                                                                                                                  | Description                    |
| --------- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `persona` | path | yes      | enum: `"orchestrator"`, `"planner"`, `"sub-planner"`, `"passive-recon"`, `"osint"`, `"active-recon"`, `"threat-intel"`, `"source-spec-ingestion"`, `"session-setup"`, `"web-api-specialist"`, `"auth-logic-specialist"`, `"infrastructure-specialist"`, `"code-specialist"`, `"exploit-developer"`, `"mentor"`, `"reflector"`, `"validator-assistant"`, `"reporter"`, `"remediation"` | A persona of the fixed roster. |

#### Response 200

The persona override view.

Content type `application/json`: [PersonaOverrideView](#personaoverrideview).

Example: set.

```json
{
  "persona": "osint",
  "override": {
    "effort": "low",
    "maxTurns": 10
  },
  "updatedAt": "2026-10-20T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

Content type `application/problem+json`: [Problem](#problem).

Example: Invalid cursor.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_CURSOR",
  "title": "Invalid cursor",
  "status": 400,
  "code": "INVALID_CURSOR",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

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

Example: Signup token invalid or expired.

```json
{
  "type": "https://errors.blackwing.dev/SIGNUP_TOKEN_INVALID",
  "title": "Signup token invalid or expired",
  "status": 400,
  "code": "SIGNUP_TOKEN_INVALID",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING.

Content type `application/problem+json`: [Problem](#problem).

Example: Forbidden.

```json
{
  "type": "https://errors.blackwing.dev/FORBIDDEN",
  "title": "Forbidden",
  "status": 403,
  "code": "FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_CONTEXT_MISSING",
  "title": "Tenant context missing",
  "status": 403,
  "code": "TENANT_CONTEXT_MISSING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND.

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

Example: Persona not defined.

```json
{
  "type": "https://errors.blackwing.dev/PERSONA_NOT_DEFINED",
  "title": "Persona not defined",
  "status": 404,
  "code": "PERSONA_NOT_DEFINED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: No released prompt version.

```json
{
  "type": "https://errors.blackwing.dev/PROMPT_NO_RELEASED_VERSION",
  "title": "No released prompt version",
  "status": 404,
  "code": "PROMPT_NO_RELEASED_VERSION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret not found.

```json
{
  "type": "https://errors.blackwing.dev/SECRET_NOT_FOUND",
  "title": "Secret not found",
  "status": 404,
  "code": "SECRET_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Identity provider resource not found.

```json
{
  "type": "https://errors.blackwing.dev/KEYCLOAK_NOT_FOUND",
  "title": "Identity provider resource not found",
  "status": 404,
  "code": "KEYCLOAK_NOT_FOUND",
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

Problem details; code is one of PERSONA_UNKNOWN.

Content type `application/problem+json`: [Problem](#problem).

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

### PUT /personas/{persona}/override

**Replace the tenant override of a persona**

Requires settings:write (org_admin). The body replaces the whole override; an empty object resets the persona to its base values. Only effort, maxTurns, maxBudgetUsd and lowerStandardTier are accepted: any other field answers OVERRIDE_FIELD_FORBIDDEN. Values above the persona bounds are clamped, never raised. The change is audited as persona.override_changed.

- Operation ID: `putPersonaOverride`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type                                                                                                                                                                                                                                                                                                                                                                                  | Description                    |
| --------- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `persona` | path | yes      | enum: `"orchestrator"`, `"planner"`, `"sub-planner"`, `"passive-recon"`, `"osint"`, `"active-recon"`, `"threat-intel"`, `"source-spec-ingestion"`, `"session-setup"`, `"web-api-specialist"`, `"auth-logic-specialist"`, `"infrastructure-specialist"`, `"code-specialist"`, `"exploit-developer"`, `"mentor"`, `"reflector"`, `"validator-assistant"`, `"reporter"`, `"remediation"` | A persona of the fixed roster. |

**Request body** (required)

Content type `application/json`: [PersonaOverride](#personaoverride).

Example: Shorter run.

```json
{
  "effort": "low",
  "maxTurns": 10
}
```

Example: Use the base values.

```json
{}
```

#### Response 200

The override as stored.

Content type `application/json`: [PersonaOverrideView](#personaoverrideview).

Example: set.

```json
{
  "persona": "osint",
  "override": {
    "effort": "low",
    "maxTurns": 10
  },
  "updatedAt": "2026-10-20T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

Content type `application/problem+json`: [Problem](#problem).

Example: Invalid cursor.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_CURSOR",
  "title": "Invalid cursor",
  "status": 400,
  "code": "INVALID_CURSOR",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

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

Example: Signup token invalid or expired.

```json
{
  "type": "https://errors.blackwing.dev/SIGNUP_TOKEN_INVALID",
  "title": "Signup token invalid or expired",
  "status": 400,
  "code": "SIGNUP_TOKEN_INVALID",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, OVERRIDE_FIELD_FORBIDDEN.

Content type `application/problem+json`: [Problem](#problem).

Example: Forbidden.

```json
{
  "type": "https://errors.blackwing.dev/FORBIDDEN",
  "title": "Forbidden",
  "status": 403,
  "code": "FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_CONTEXT_MISSING",
  "title": "Tenant context missing",
  "status": 403,
  "code": "TENANT_CONTEXT_MISSING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Persona override field not permitted.

```json
{
  "type": "https://errors.blackwing.dev/OVERRIDE_FIELD_FORBIDDEN",
  "title": "Persona override field not permitted",
  "status": 403,
  "code": "OVERRIDE_FIELD_FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND.

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

Example: Persona not defined.

```json
{
  "type": "https://errors.blackwing.dev/PERSONA_NOT_DEFINED",
  "title": "Persona not defined",
  "status": 404,
  "code": "PERSONA_NOT_DEFINED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: No released prompt version.

```json
{
  "type": "https://errors.blackwing.dev/PROMPT_NO_RELEASED_VERSION",
  "title": "No released prompt version",
  "status": 404,
  "code": "PROMPT_NO_RELEASED_VERSION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret not found.

```json
{
  "type": "https://errors.blackwing.dev/SECRET_NOT_FOUND",
  "title": "Secret not found",
  "status": 404,
  "code": "SECRET_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Identity provider resource not found.

```json
{
  "type": "https://errors.blackwing.dev/KEYCLOAK_NOT_FOUND",
  "title": "Identity provider resource not found",
  "status": 404,
  "code": "KEYCLOAK_NOT_FOUND",
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

Problem details; code is one of PERSONA_UNKNOWN, VALIDATION_FAILED.

Content type `application/problem+json`: [Problem](#problem).

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

## signup

Self-service signup: verify an e-mail address, then create the organisation and its owner.

### POST /signup

**Ask for a verification e-mail to create an organisation**

Always answers 202 with the same body, whether or not the address already has an account, so the endpoint cannot be used to enumerate customers. A verification link is mailed; nothing is created until it is used.

- Operation ID: `requestSignup`
- Authentication: None.

| Parameter         | In     | Required | Type   | Description |
| ----------------- | ------ | -------- | ------ | ----------- |
| `Idempotency-Key` | header | yes      | string |             |

**Request body** (required)

Content type `application/json`: [SignupRequest](#signuprequest).

Example: Example.

```json
{
  "email": "owner@acme.example",
  "orgName": "Acme Security"
}
```

#### Response 202

Verification requested.

Content type `application/json`: [SignupAccepted](#signupaccepted).

Example: Example.

```json
{
  "status": "verification_requested"
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: No credentials presented.

```json
{
  "type": "https://errors.blackwing.dev/AUTH_NO_CREDENTIALS",
  "title": "No credentials presented",
  "status": 401,
  "code": "AUTH_NO_CREDENTIALS",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Invalid credentials.

```json
{
  "type": "https://errors.blackwing.dev/AUTH_INVALID_TOKEN",
  "title": "Invalid credentials",
  "status": 401,
  "code": "AUTH_INVALID_TOKEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Credentials expired.

```json
{
  "type": "https://errors.blackwing.dev/AUTH_EXPIRED",
  "title": "Credentials expired",
  "status": 401,
  "code": "AUTH_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Run token required.

```json
{
  "type": "https://errors.blackwing.dev/SBX_UNAUTHENTICATED",
  "title": "Run token required",
  "status": 401,
  "code": "SBX_UNAUTHENTICATED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Service authentication failed.

```json
{
  "type": "https://errors.blackwing.dev/SERVICE_AUTH_FAILED",
  "title": "Service authentication failed",
  "status": 401,
  "code": "SERVICE_AUTH_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 403

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, TENANT_MISMATCH, SECRET_PURPOSE_DENIED.

Content type `application/problem+json`: [Problem](#problem).

Example: Forbidden.

```json
{
  "type": "https://errors.blackwing.dev/FORBIDDEN",
  "title": "Forbidden",
  "status": 403,
  "code": "FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_CONTEXT_MISSING",
  "title": "Tenant context missing",
  "status": 403,
  "code": "TENANT_CONTEXT_MISSING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Cross tenant access denied.

```json
{
  "type": "https://errors.blackwing.dev/CROSS_TENANT_DENIED",
  "title": "Cross tenant access denied",
  "status": 403,
  "code": "CROSS_TENANT_DENIED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Seeding forbidden in this environment.

```json
{
  "type": "https://errors.blackwing.dev/SEED_FORBIDDEN_IN_PROD",
  "title": "Seeding forbidden in this environment",
  "status": 403,
  "code": "SEED_FORBIDDEN_IN_PROD",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Tenant context mismatch.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_CONTEXT_MISMATCH",
  "title": "Tenant context mismatch",
  "status": 403,
  "code": "TENANT_CONTEXT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Out of authorised scope.

```json
{
  "type": "https://errors.blackwing.dev/SCOPE_VIOLATION",
  "title": "Out of authorised scope",
  "status": 403,
  "code": "SCOPE_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Intrusiveness exceeds the authorised ceiling.

```json
{
  "type": "https://errors.blackwing.dev/SCOPE_INTRUSIVENESS_EXCEEDS_CEILING",
  "title": "Intrusiveness exceeds the authorised ceiling",
  "status": 403,
  "code": "SCOPE_INTRUSIVENESS_EXCEEDS_CEILING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Destructive intrusiveness is forbidden.

```json
{
  "type": "https://errors.blackwing.dev/SCOPE_DESTRUCTIVE_FORBIDDEN",
  "title": "Destructive intrusiveness is forbidden",
  "status": 403,
  "code": "SCOPE_DESTRUCTIVE_FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Budget exceeds the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/SCOPE_BUDGET_EXCEEDS_SA",
  "title": "Budget exceeds the standing authorisation",
  "status": 403,
  "code": "SCOPE_BUDGET_EXCEEDS_SA",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Persona override field not permitted.

```json
{
  "type": "https://errors.blackwing.dev/OVERRIDE_FIELD_FORBIDDEN",
  "title": "Persona override field not permitted",
  "status": 403,
  "code": "OVERRIDE_FIELD_FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Model not allowed.

```json
{
  "type": "https://errors.blackwing.dev/MODEL_NOT_ALLOWED",
  "title": "Model not allowed",
  "status": 403,
  "code": "MODEL_NOT_ALLOWED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret context mismatch.

```json
{
  "type": "https://errors.blackwing.dev/AAD_MISMATCH",
  "title": "Secret context mismatch",
  "status": 403,
  "code": "AAD_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Draft prompt forbidden in production.

```json
{
  "type": "https://errors.blackwing.dev/PROMPT_DRAFT_FORBIDDEN",
  "title": "Draft prompt forbidden in production",
  "status": 403,
  "code": "PROMPT_DRAFT_FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

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

Example: Platform operator required.

```json
{
  "type": "https://errors.blackwing.dev/NOT_OPERATOR",
  "title": "Platform operator required",
  "status": 403,
  "code": "NOT_OPERATOR",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_MISMATCH",
  "title": "Tenant mismatch",
  "status": 403,
  "code": "TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret purpose not permitted.

```json
{
  "type": "https://errors.blackwing.dev/SECRET_PURPOSE_DENIED",
  "title": "Secret purpose not permitted",
  "status": 403,
  "code": "SECRET_PURPOSE_DENIED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND.

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

Example: Persona not defined.

```json
{
  "type": "https://errors.blackwing.dev/PERSONA_NOT_DEFINED",
  "title": "Persona not defined",
  "status": 404,
  "code": "PERSONA_NOT_DEFINED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: No released prompt version.

```json
{
  "type": "https://errors.blackwing.dev/PROMPT_NO_RELEASED_VERSION",
  "title": "No released prompt version",
  "status": 404,
  "code": "PROMPT_NO_RELEASED_VERSION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret not found.

```json
{
  "type": "https://errors.blackwing.dev/SECRET_NOT_FOUND",
  "title": "Secret not found",
  "status": 404,
  "code": "SECRET_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Identity provider resource not found.

```json
{
  "type": "https://errors.blackwing.dev/KEYCLOAK_NOT_FOUND",
  "title": "Identity provider resource not found",
  "status": 404,
  "code": "KEYCLOAK_NOT_FOUND",
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

Problem details; code is one of VALIDATION_FAILED, IDEMPOTENCY_KEY_MISMATCH.

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

### POST /signup/verify

**Verify the e-mail address and create the organisation**

Consumes the single-use token from the e-mail. An unknown, expired, used or cancelled token is 400 SIGNUP_TOKEN_INVALID and creates nothing. When the address already has an account no second tenant is created: the answer is existing_account and the caller goes to login.

- Operation ID: `verifySignup`
- Authentication: None.

**Request body** (required)

Content type `application/json`: [SignupVerifyRequest](#signupverifyrequest).

Example: Example.

```json
{
  "token": "k3mT0xq9m1b1Vd2u7Rj8nQe4wYc6ZaPfH5sLgUoXiBA"
}
```

#### Response 200

The signup was verified.

Content type `application/json`: [SignupVerified](#signupverified).

Example: created.

```json
{
  "outcome": "tenant_created",
  "tenantId": "01890a5d-ac96-774b-bcce-b302099a8057",
  "slug": "acme-security"
}
```

Example: existing.

```json
{
  "outcome": "existing_account"
}
```

#### Response 400

Problem details; code is one of SIGNUP_TOKEN_INVALID.

Content type `application/problem+json`: [Problem](#problem).

Example: Signup token invalid or expired.

```json
{
  "type": "https://errors.blackwing.dev/SIGNUP_TOKEN_INVALID",
  "title": "Signup token invalid or expired",
  "status": 400,
  "code": "SIGNUP_TOKEN_INVALID",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 401

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: No credentials presented.

```json
{
  "type": "https://errors.blackwing.dev/AUTH_NO_CREDENTIALS",
  "title": "No credentials presented",
  "status": 401,
  "code": "AUTH_NO_CREDENTIALS",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Invalid credentials.

```json
{
  "type": "https://errors.blackwing.dev/AUTH_INVALID_TOKEN",
  "title": "Invalid credentials",
  "status": 401,
  "code": "AUTH_INVALID_TOKEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Credentials expired.

```json
{
  "type": "https://errors.blackwing.dev/AUTH_EXPIRED",
  "title": "Credentials expired",
  "status": 401,
  "code": "AUTH_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Run token required.

```json
{
  "type": "https://errors.blackwing.dev/SBX_UNAUTHENTICATED",
  "title": "Run token required",
  "status": 401,
  "code": "SBX_UNAUTHENTICATED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Service authentication failed.

```json
{
  "type": "https://errors.blackwing.dev/SERVICE_AUTH_FAILED",
  "title": "Service authentication failed",
  "status": 401,
  "code": "SERVICE_AUTH_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 403

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, TENANT_MISMATCH, SECRET_PURPOSE_DENIED.

Content type `application/problem+json`: [Problem](#problem).

Example: Forbidden.

```json
{
  "type": "https://errors.blackwing.dev/FORBIDDEN",
  "title": "Forbidden",
  "status": 403,
  "code": "FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_CONTEXT_MISSING",
  "title": "Tenant context missing",
  "status": 403,
  "code": "TENANT_CONTEXT_MISSING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Cross tenant access denied.

```json
{
  "type": "https://errors.blackwing.dev/CROSS_TENANT_DENIED",
  "title": "Cross tenant access denied",
  "status": 403,
  "code": "CROSS_TENANT_DENIED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Seeding forbidden in this environment.

```json
{
  "type": "https://errors.blackwing.dev/SEED_FORBIDDEN_IN_PROD",
  "title": "Seeding forbidden in this environment",
  "status": 403,
  "code": "SEED_FORBIDDEN_IN_PROD",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Tenant context mismatch.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_CONTEXT_MISMATCH",
  "title": "Tenant context mismatch",
  "status": 403,
  "code": "TENANT_CONTEXT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Out of authorised scope.

```json
{
  "type": "https://errors.blackwing.dev/SCOPE_VIOLATION",
  "title": "Out of authorised scope",
  "status": 403,
  "code": "SCOPE_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Intrusiveness exceeds the authorised ceiling.

```json
{
  "type": "https://errors.blackwing.dev/SCOPE_INTRUSIVENESS_EXCEEDS_CEILING",
  "title": "Intrusiveness exceeds the authorised ceiling",
  "status": 403,
  "code": "SCOPE_INTRUSIVENESS_EXCEEDS_CEILING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Destructive intrusiveness is forbidden.

```json
{
  "type": "https://errors.blackwing.dev/SCOPE_DESTRUCTIVE_FORBIDDEN",
  "title": "Destructive intrusiveness is forbidden",
  "status": 403,
  "code": "SCOPE_DESTRUCTIVE_FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Budget exceeds the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/SCOPE_BUDGET_EXCEEDS_SA",
  "title": "Budget exceeds the standing authorisation",
  "status": 403,
  "code": "SCOPE_BUDGET_EXCEEDS_SA",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Persona override field not permitted.

```json
{
  "type": "https://errors.blackwing.dev/OVERRIDE_FIELD_FORBIDDEN",
  "title": "Persona override field not permitted",
  "status": 403,
  "code": "OVERRIDE_FIELD_FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Model not allowed.

```json
{
  "type": "https://errors.blackwing.dev/MODEL_NOT_ALLOWED",
  "title": "Model not allowed",
  "status": 403,
  "code": "MODEL_NOT_ALLOWED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret context mismatch.

```json
{
  "type": "https://errors.blackwing.dev/AAD_MISMATCH",
  "title": "Secret context mismatch",
  "status": 403,
  "code": "AAD_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Draft prompt forbidden in production.

```json
{
  "type": "https://errors.blackwing.dev/PROMPT_DRAFT_FORBIDDEN",
  "title": "Draft prompt forbidden in production",
  "status": 403,
  "code": "PROMPT_DRAFT_FORBIDDEN",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

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

Example: Platform operator required.

```json
{
  "type": "https://errors.blackwing.dev/NOT_OPERATOR",
  "title": "Platform operator required",
  "status": 403,
  "code": "NOT_OPERATOR",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/TENANT_MISMATCH",
  "title": "Tenant mismatch",
  "status": 403,
  "code": "TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret purpose not permitted.

```json
{
  "type": "https://errors.blackwing.dev/SECRET_PURPOSE_DENIED",
  "title": "Secret purpose not permitted",
  "status": 403,
  "code": "SECRET_PURPOSE_DENIED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND.

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

Example: Persona not defined.

```json
{
  "type": "https://errors.blackwing.dev/PERSONA_NOT_DEFINED",
  "title": "Persona not defined",
  "status": 404,
  "code": "PERSONA_NOT_DEFINED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: No released prompt version.

```json
{
  "type": "https://errors.blackwing.dev/PROMPT_NO_RELEASED_VERSION",
  "title": "No released prompt version",
  "status": 404,
  "code": "PROMPT_NO_RELEASED_VERSION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Secret not found.

```json
{
  "type": "https://errors.blackwing.dev/SECRET_NOT_FOUND",
  "title": "Secret not found",
  "status": 404,
  "code": "SECRET_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Identity provider resource not found.

```json
{
  "type": "https://errors.blackwing.dev/KEYCLOAK_NOT_FOUND",
  "title": "Identity provider resource not found",
  "status": 404,
  "code": "KEYCLOAK_NOT_FOUND",
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

Problem details; code is one of VALIDATION_FAILED.

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

## Schemas

### AuditEventView

| Property      | Type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Required | Description                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------ |
| `id`          | string (uuid)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | yes      |                                                                          |
| `seq`         | integer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | yes      |                                                                          |
| `occurredAt`  | string (date-time)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | yes      |                                                                          |
| `action`      | enum: `"auth.login"`, `"auth.logout"`, `"auth.sso_link"`, `"auth.api_token_issued"`, `"auth.api_token_revoked"`, `"authz.denied"`, `"authz.role_changed"`, `"asset.created"`, `"asset.verified"`, `"sa.requested"`, `"sa.approved"`, `"sa.rejected"`, `"sa.revoked"`, `"gate1.decided"`, `"gate2.decided"`, `"gate3.released"`, `"run.created"`, `"run.state_changed"`, `"tool.invoked"`, `"egress.blocked"`, `"kill.fired"`, `"kill.completed"`, `"finding.released"`, `"finding.risk_accepted"`, `"export.generated"`, `"secret.resolved"`, `"config.changed"`, `"connector.configured"`, `"kill.triggered"`, `"kill.forbidden"`, `"kill.egress_blocked"`, `"kill.sandboxes_terminated"`, `"secret.kek_provisioned"`, `"secret.kek_rotated"`, `"secret.kek_disabled"`, `"kill.keys_revoked"`, `"kill.workflows_cancelled"`, `"activity.started"`, `"activity.succeeded"`, `"activity.failed"`, `"workflow.started"`, `"workflow.completed"`, `"workflow.failed"`, `"workflow.cancelled"`, `"workflow.continued_as_new"`, `"soc_kill.link_minted"`, `"soc_kill.triggered"`, `"soc_kill.rejected"`, `"outbox.delivery_failed"`, `"scope.request.created"`, `"scope.request.status_changed"`, `"operator.kill_previewed"`, `"operator.kill_fired"`, `"audit.queried"`, `"secret.rotated"`, `"secret.rewrapped"`, `"persona.override_changed"`, `"auth.sso_config_changed"`, `"tenant.created"`, `"signup.verified"` | yes      |                                                                          |
| `severity`    | enum: `"info"`, `"notice"`, `"warning"`, `"critical"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | yes      |                                                                          |
| `actor`       | object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | yes      | Who acted. `email` is only returned to auditors.                         |
| `target`      | object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | yes      |                                                                          |
| `outcome`     | enum: `"success"`, `"failure"`, `"denied"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | yes      |                                                                          |
| `reason`      | any                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | yes      |                                                                          |
| `metadata`    | object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | yes      | Empty for callers that are not auditors.                                 |
| `metadataRef` | object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | no       | Only returned to auditors.                                               |
| `traceId`     | any                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | yes      |                                                                          |
| `runId`       | any                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | yes      |                                                                          |
| `hash`        | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | no       | Hex SHA-256 chain hash. Only with includeChain=true.                     |
| `prevHash`    | any                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | no       | Hex previous hash; null on the genesis row. Only with includeChain=true. |

Full schema:

```json
{
  "type": "object",
  "required": [
    "id",
    "seq",
    "occurredAt",
    "action",
    "severity",
    "actor",
    "target",
    "outcome",
    "reason",
    "metadata",
    "traceId",
    "runId"
  ],
  "additionalProperties": false,
  "properties": {
    "id": {
      "type": "string",
      "format": "uuid"
    },
    "seq": {
      "type": "integer",
      "minimum": 1
    },
    "occurredAt": {
      "type": "string",
      "format": "date-time"
    },
    "action": {
      "type": "string",
      "enum": [
        "auth.login",
        "auth.logout",
        "auth.sso_link",
        "auth.api_token_issued",
        "auth.api_token_revoked",
        "authz.denied",
        "authz.role_changed",
        "asset.created",
        "asset.verified",
        "sa.requested",
        "sa.approved",
        "sa.rejected",
        "sa.revoked",
        "gate1.decided",
        "gate2.decided",
        "gate3.released",
        "run.created",
        "run.state_changed",
        "tool.invoked",
        "egress.blocked",
        "kill.fired",
        "kill.completed",
        "finding.released",
        "finding.risk_accepted",
        "export.generated",
        "secret.resolved",
        "config.changed",
        "connector.configured",
        "kill.triggered",
        "kill.forbidden",
        "kill.egress_blocked",
        "kill.sandboxes_terminated",
        "secret.kek_provisioned",
        "secret.kek_rotated",
        "secret.kek_disabled",
        "kill.keys_revoked",
        "kill.workflows_cancelled",
        "activity.started",
        "activity.succeeded",
        "activity.failed",
        "workflow.started",
        "workflow.completed",
        "workflow.failed",
        "workflow.cancelled",
        "workflow.continued_as_new",
        "soc_kill.link_minted",
        "soc_kill.triggered",
        "soc_kill.rejected",
        "outbox.delivery_failed",
        "scope.request.created",
        "scope.request.status_changed",
        "operator.kill_previewed",
        "operator.kill_fired",
        "audit.queried",
        "secret.rotated",
        "secret.rewrapped",
        "persona.override_changed",
        "auth.sso_config_changed",
        "tenant.created",
        "signup.verified"
      ]
    },
    "severity": {
      "type": "string",
      "enum": ["info", "notice", "warning", "critical"]
    },
    "actor": {
      "type": "object",
      "description": "Who acted. `email` is only returned to auditors.",
      "required": ["type"],
      "properties": {
        "type": {
          "type": "string",
          "enum": ["user", "operator", "service", "system", "anonymous"]
        },
        "id": {
          "type": "string"
        },
        "email": {
          "type": "string"
        },
        "tokenId": {
          "type": "string"
        }
      }
    },
    "target": {
      "type": "object",
      "required": ["type", "id"],
      "properties": {
        "type": {
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "publicId": {
          "type": "string"
        }
      }
    },
    "outcome": {
      "type": "string",
      "enum": ["success", "failure", "denied"]
    },
    "reason": {
      "type": ["string", "null"]
    },
    "metadata": {
      "type": "object",
      "description": "Empty for callers that are not auditors."
    },
    "metadataRef": {
      "type": "object",
      "description": "Only returned to auditors."
    },
    "traceId": {
      "type": ["string", "null"]
    },
    "runId": {
      "type": ["string", "null"],
      "format": "uuid"
    },
    "hash": {
      "type": "string",
      "description": "Hex SHA-256 chain hash. Only with includeChain=true."
    },
    "prevHash": {
      "type": ["string", "null"],
      "description": "Hex previous hash; null on the genesis row. Only with includeChain=true."
    }
  }
}
```

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

### PersonaOverride

| Property            | Type                                                    | Required | Description |
| ------------------- | ------------------------------------------------------- | -------- | ----------- |
| `effort`            | enum: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | no       |             |
| `maxTurns`          | integer                                                 | no       |             |
| `maxBudgetUsd`      | number                                                  | no       |             |
| `lowerStandardTier` | boolean                                                 | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "effort": {
      "type": "string",
      "enum": ["low", "medium", "high", "xhigh", "max"]
    },
    "maxTurns": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10000
    },
    "maxBudgetUsd": {
      "type": "number",
      "exclusiveMinimum": 0,
      "maximum": 10000
    },
    "lowerStandardTier": {
      "type": "boolean"
    }
  },
  "additionalProperties": false
}
```

### PersonaOverrideView

| Property    | Type                                                                                                                                                                                                                                                                                                                                                                                  | Required | Description |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `persona`   | enum: `"orchestrator"`, `"planner"`, `"sub-planner"`, `"passive-recon"`, `"osint"`, `"active-recon"`, `"threat-intel"`, `"source-spec-ingestion"`, `"session-setup"`, `"web-api-specialist"`, `"auth-logic-specialist"`, `"infrastructure-specialist"`, `"code-specialist"`, `"exploit-developer"`, `"mentor"`, `"reflector"`, `"validator-assistant"`, `"reporter"`, `"remediation"` | yes      |             |
| `override`  | [PersonaOverride](#personaoverride) or null                                                                                                                                                                                                                                                                                                                                           | yes      |             |
| `updatedAt` | any                                                                                                                                                                                                                                                                                                                                                                                   | yes      |             |

Full schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["persona", "override", "updatedAt"],
  "properties": {
    "persona": {
      "type": "string",
      "enum": [
        "orchestrator",
        "planner",
        "sub-planner",
        "passive-recon",
        "osint",
        "active-recon",
        "threat-intel",
        "source-spec-ingestion",
        "session-setup",
        "web-api-specialist",
        "auth-logic-specialist",
        "infrastructure-specialist",
        "code-specialist",
        "exploit-developer",
        "mentor",
        "reflector",
        "validator-assistant",
        "reporter",
        "remediation"
      ]
    },
    "override": {
      "anyOf": [
        {
          "$ref": "#/components/schemas/PersonaOverride"
        },
        {
          "type": "null"
        }
      ]
    },
    "updatedAt": {
      "type": ["string", "null"],
      "format": "date-time"
    }
  }
}
```

### PersonaRegistryList

| Property | Type                                                 | Required | Description |
| -------- | ---------------------------------------------------- | -------- | ----------- |
| `items`  | array of [PersonaRegistryView](#personaregistryview) | yes      |             |

Full schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["items"],
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/PersonaRegistryView"
      }
    }
  }
}
```

### PersonaRegistryView

| Property               | Type                                                                                                                                                                                                                                                                                                                                                                                  | Required | Description |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `name`                 | enum: `"orchestrator"`, `"planner"`, `"sub-planner"`, `"passive-recon"`, `"osint"`, `"active-recon"`, `"threat-intel"`, `"source-spec-ingestion"`, `"session-setup"`, `"web-api-specialist"`, `"auth-logic-specialist"`, `"infrastructure-specialist"`, `"code-specialist"`, `"exploit-developer"`, `"mentor"`, `"reflector"`, `"validator-assistant"`, `"reporter"`, `"remediation"` | yes      |             |
| `mandate`              | string                                                                                                                                                                                                                                                                                                                                                                                | yes      |             |
| `promptVersion`        | string                                                                                                                                                                                                                                                                                                                                                                                | yes      |             |
| `tierAlias`            | enum: `"deep"`, `"standard"`, `"fast"`                                                                                                                                                                                                                                                                                                                                                | yes      |             |
| `effective`            | object                                                                                                                                                                                                                                                                                                                                                                                | yes      |             |
| `overridden`           | array of enum: `"effort"`, `"maxTurns"`, `"maxBudgetUsd"`, `"lowerStandardTier"`                                                                                                                                                                                                                                                                                                      | yes      |             |
| `allowedTools`         | array of string                                                                                                                                                                                                                                                                                                                                                                       | yes      |             |
| `disallowedTools`      | array of string                                                                                                                                                                                                                                                                                                                                                                       | yes      |             |
| `declaredOracleTypes`  | array of enum: `"reflected_marker"`, `"status_diff"`, `"timing_with_baseline"`, `"out_of_band"`, `"access_matrix"`, `"error_signature"`, `"file_read"`, `"header_flag"`                                                                                                                                                                                                               | yes      |             |
| `inputs`               | array of string                                                                                                                                                                                                                                                                                                                                                                       | yes      |             |
| `intrusivenessCeiling` | enum: `"passive"`, `"active_safe"`, `"state_changing"`                                                                                                                                                                                                                                                                                                                                | yes      |             |
| `requiresSubmission`   | boolean                                                                                                                                                                                                                                                                                                                                                                               | yes      |             |
| `helpers`              | array of object                                                                                                                                                                                                                                                                                                                                                                       | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "enum": [
        "orchestrator",
        "planner",
        "sub-planner",
        "passive-recon",
        "osint",
        "active-recon",
        "threat-intel",
        "source-spec-ingestion",
        "session-setup",
        "web-api-specialist",
        "auth-logic-specialist",
        "infrastructure-specialist",
        "code-specialist",
        "exploit-developer",
        "mentor",
        "reflector",
        "validator-assistant",
        "reporter",
        "remediation"
      ]
    },
    "mandate": {
      "type": "string",
      "minLength": 1
    },
    "promptVersion": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$"
    },
    "tierAlias": {
      "type": "string",
      "enum": ["deep", "standard", "fast"]
    },
    "effective": {
      "type": "object",
      "properties": {
        "model": {
          "type": "string",
          "minLength": 1
        },
        "effort": {
          "type": "string",
          "enum": ["low", "medium", "high", "xhigh", "max"]
        },
        "maxTurns": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "maxBudgetUsd": {
          "type": "number",
          "exclusiveMinimum": 0
        }
      },
      "required": ["model", "effort", "maxTurns", "maxBudgetUsd"],
      "additionalProperties": false
    },
    "overridden": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["effort", "maxTurns", "maxBudgetUsd", "lowerStandardTier"]
      }
    },
    "allowedTools": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "disallowedTools": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "declaredOracleTypes": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "reflected_marker",
          "status_diff",
          "timing_with_baseline",
          "out_of_band",
          "access_matrix",
          "error_signature",
          "file_read",
          "header_flag"
        ]
      }
    },
    "inputs": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "intrusivenessCeiling": {
      "type": "string",
      "enum": ["passive", "active_safe", "state_changing"]
    },
    "requiresSubmission": {
      "type": "boolean"
    },
    "helpers": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1
          },
          "description": {
            "type": "string",
            "minLength": 1
          },
          "tierAlias": {
            "type": "string",
            "enum": ["deep", "standard", "fast"]
          },
          "allowedTools": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "required": ["name", "description", "tierAlias", "allowedTools"],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "name",
    "mandate",
    "promptVersion",
    "tierAlias",
    "effective",
    "overridden",
    "allowedTools",
    "disallowedTools",
    "declaredOracleTypes",
    "inputs",
    "intrusivenessCeiling",
    "requiresSubmission",
    "helpers"
  ],
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

### SignupAccepted

| Property | Type   | Required | Description |
| -------- | ------ | -------- | ----------- |
| `status` | string | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "const": "verification_requested"
    }
  },
  "required": ["status"],
  "additionalProperties": false
}
```

### SignupRequest

| Property  | Type           | Required | Description |
| --------- | -------------- | -------- | ----------- |
| `email`   | string (email) | yes      |             |
| `orgName` | string         | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "email": {
      "type": "string",
      "maxLength": 320,
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "orgName": {
      "type": "string",
      "minLength": 2,
      "maxLength": 100
    }
  },
  "required": ["email", "orgName"],
  "additionalProperties": false
}
```

### SignupVerified

Full schema:

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "outcome": {
          "type": "string",
          "const": "tenant_created"
        },
        "tenantId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "slug": {
          "type": "string",
          "minLength": 3,
          "maxLength": 63,
          "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$"
        }
      },
      "required": ["outcome", "tenantId", "slug"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "outcome": {
          "type": "string",
          "const": "existing_account"
        }
      },
      "required": ["outcome"],
      "additionalProperties": false
    }
  ]
}
```

### SignupVerifyRequest

| Property | Type   | Required | Description |
| -------- | ------ | -------- | ----------- |
| `token`  | string | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "token": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    }
  },
  "required": ["token"],
  "additionalProperties": false
}
```
