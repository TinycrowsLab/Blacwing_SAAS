# API reference

The public `/v1` REST API, version 0.0.0. This page is generated from [`openapi.json`](openapi.json) by `pnpm openapi:generate`; do not edit it by hand. CI fails when it is stale.

It documents 47 operations. Read [Conventions](conventions.md) for pagination, idempotency, concurrency and errors, and [Authentication](auth.md) for tokens and scopes.

The internal Run Broker API (`/internal/broker`) is not part of this reference.

## Contents

- kill
  - [GET /kill](#get-kill)
  - [POST /kill](#post-kill)
  - [GET /kill/{id}](#get-killid)
- audit
  - [GET /audit/events](#get-auditevents)
- runs
  - [GET /runs/{runId}/events](#get-runsrunidevents)
- surface
  - [GET /runs/{runId}/surface](#get-runsrunidsurface)
- gate1
  - [GET /runs/{runId}/gate1](#get-runsrunidgate1)
  - [POST /runs/{runId}/gate1/decisions](#post-runsrunidgate1decisions)
- personas
  - [GET /personas](#get-personas)
  - [GET /personas/{persona}](#get-personaspersona)
  - [GET /personas/{persona}/override](#get-personaspersonaoverride)
  - [PUT /personas/{persona}/override](#put-personaspersonaoverride)
- signup
  - [POST /signup](#post-signup)
  - [POST /signup/verify](#post-signupverify)
- tenant
  - [GET /tenant/settings](#get-tenantsettings)
  - [PATCH /tenant/settings](#patch-tenantsettings)
- assessment-requests
  - [GET /assessment-requests](#get-assessment-requests)
  - [POST /assessment-requests](#post-assessment-requests)
  - [GET /assessment-requests/{id}](#get-assessment-requestsid)
  - [PATCH /assessment-requests/{id}](#patch-assessment-requestsid)
  - [POST /assessment-requests/{id}/submit](#post-assessment-requestsidsubmit)
  - [POST /assessment-requests/{id}/withdraw](#post-assessment-requestsidwithdraw)
- assets
  - [GET /assets](#get-assets)
  - [POST /assets](#post-assets)
  - [GET /assets/{id}](#get-assetsid)
  - [DELETE /assets/{id}](#delete-assetsid)
  - [PATCH /assets/{id}](#patch-assetsid)
- standing-authorisations
  - [GET /standing-authorisations](#get-standing-authorisations)
  - [POST /standing-authorisations](#post-standing-authorisations)
  - [GET /standing-authorisations/{id}](#get-standing-authorisationsid)
  - [PATCH /standing-authorisations/{id}](#patch-standing-authorisationsid)
  - [POST /standing-authorisations/{id}/submit](#post-standing-authorisationsidsubmit)
  - [POST /standing-authorisations/{id}/approve](#post-standing-authorisationsidapprove)
  - [POST /standing-authorisations/{id}/reject](#post-standing-authorisationsidreject)
- test-plans
  - [GET /runs/{runId}/test-plans](#get-runsrunidtest-plans)
  - [POST /runs/{runId}/test-plans](#post-runsrunidtest-plans)
  - [GET /runs/{runId}/test-plans/{version}](#get-runsrunidtest-plansversion)
  - [POST /test-plans/{planId}/cases](#post-test-plansplanidcases)
  - [GET /test-plans/{planId}/validation](#get-test-plansplanidvalidation)
  - [DELETE /test-cases/{caseId}](#delete-test-casescaseid)
  - [PATCH /test-cases/{caseId}](#patch-test-casescaseid)
- findings
  - [GET /findings](#get-findings)
  - [GET /findings/{id}](#get-findingsid)
- oncall
  - [GET /oncall/rosters](#get-oncallrosters)
  - [POST /oncall/rosters](#post-oncallrosters)
  - [GET /oncall/rosters/{id}](#get-oncallrostersid)
  - [PATCH /oncall/rosters/{id}](#patch-oncallrostersid)

## kill

Kill switch: stop every agent in a run, asset or tenant scope.

### GET /kill

**The tenant's most recent kill events, newest first**

- Operation ID: `listKillEvents`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In    | Required | Type    | Description |
| --------- | ----- | -------- | ------- | ----------- |
| `limit`   | query | no       | integer |             |

#### Response 200

The kill history of the caller tenant, newest first.

Content type `application/json`: [KillEventList](#killeventlist).

Example: The newest kill of the tenant.

```json
{
  "items": [
    {
      "killEventId": "01890a5d-ac96-774b-bcce-b302099a8057",
      "tenantId": "01890a5d-ac96-774b-bcce-b302099a8058",
      "scope": "asset",
      "scopeRefId": "01890a5d-ac96-774b-bcce-b302099a8058",
      "source": "console",
      "actorType": "user",
      "actorRef": "01890a5d-ac96-774b-bcce-b302099a8058",
      "reason": "change freeze",
      "status": "initiated",
      "triggeredAt": "2026-10-20T10:00:00.000Z",
      "egressBlockedAt": null,
      "sandboxesTerminatedAt": null,
      "keysRevokedAt": null,
      "workflowsCancelledAt": null,
      "completedAt": null,
      "haltMs": null,
      "affected": {},
      "reenabledAt": null,
      "reenabledBy": null,
      "createdAt": "2026-10-20T10:00:00.000Z",
      "updatedAt": "2026-10-20T10:00:00.000Z"
    }
  ]
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
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

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
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

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
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

| Parameter      | In    | Required | Type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Description                               |
| -------------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `actorId`      | query | no       | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                           |
| `action`       | query | no       | enum: `"auth.login"`, `"auth.logout"`, `"auth.sso_link"`, `"auth.api_token_issued"`, `"auth.api_token_revoked"`, `"authz.denied"`, `"authz.role_changed"`, `"asset.created"`, `"asset.verified"`, `"sa.requested"`, `"sa.approved"`, `"sa.rejected"`, `"sa.revoked"`, `"gate1.decided"`, `"gate2.decided"`, `"gate3.released"`, `"run.created"`, `"run.state_changed"`, `"tool.invoked"`, `"egress.blocked"`, `"kill.fired"`, `"kill.completed"`, `"finding.released"`, `"finding.risk_accepted"`, `"export.generated"`, `"secret.resolved"`, `"config.changed"`, `"connector.configured"`, `"kill.triggered"`, `"kill.forbidden"`, `"kill.egress_blocked"`, `"kill.sandboxes_terminated"`, `"secret.kek_provisioned"`, `"secret.kek_rotated"`, `"secret.kek_disabled"`, `"kill.keys_revoked"`, `"kill.workflows_cancelled"`, `"activity.started"`, `"activity.succeeded"`, `"activity.failed"`, `"workflow.started"`, `"workflow.completed"`, `"workflow.failed"`, `"workflow.cancelled"`, `"workflow.continued_as_new"`, `"soc_kill.link_minted"`, `"soc_kill.triggered"`, `"soc_kill.rejected"`, `"outbox.delivery_failed"`, `"scope.request.created"`, `"scope.request.status_changed"`, `"operator.kill_previewed"`, `"operator.kill_fired"`, `"audit.queried"`, `"secret.rotated"`, `"secret.rewrapped"`, `"persona.override_changed"`, `"auth.sso_config_changed"`, `"tenant.created"`, `"signup.verified"`, `"tenant.settings_updated"`, `"auth.operator_login"`, `"auth.operator_logout"`, `"auth.operator_session_revoked"`, `"authz.sa.created"`, `"authz.sa.state_changed"`, `"authz.sa.signed"`, `"authz.signing_key.rotated"`, `"authz.gate.decision"`, `"authz.sa.updated"`, `"authz.sa.submitted"`, `"run.surface.viewed"`, `"scope.request.updated"`, `"scope.request.submitted"`, `"scope.request.withdrawn"`, `"test_plan.version_created"`, `"test_case.created"`, `"test_case.updated"`, `"test_case.removed"`, `"asset.updated"`, `"asset.deleted"`, `"asset.owner_assigned"`, `"test_plan.validated"`, `"oncall.roster.updated"`, `"oncall.sod_skipped"` |                                           |
| `targetId`     | query | no       | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                           |
| `runId`        | query | no       | string (uuid)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                           |
| `outcome`      | query | no       | enum: `"success"`, `"failure"`, `"denied"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                           |
| `from`         | query | no       | string (date-time)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |                                           |
| `to`           | query | no       | string (date-time)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |                                           |
| `includeChain` | query | no       | enum: `"true"`, `"false"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Auditors only: include hash and prevHash. |
| `cursor`       | query | no       | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                           |
| `limit`        | query | no       | integer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                           |

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

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
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

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
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

## surface

Run surface graph for the console view, bounded and paginated.

### GET /runs/{runId}/surface

**Get the bounded surface graph of one run (nodes and edges)**

Requires run:read in the caller tenant and the Cedar surface policy (an asset owner reads only the runs of assets they own). A run outside the caller tenant, or an unknown run, answers 404 RUN_NOT_FOUND (uniform, no existence oracle). Nodes are ranked by degree then confidence and capped at GRAPH_VIZ_MAX_NODES (2000); edges at GRAPH_VIZ_MAX_EDGES (4000). A surface above a cap answers truncated: true with full totals. Pages are ordered by natural key: pass pageInfo.endCursor back as cursor while hasNextPage is true. Every returned edge joins two nodes of the same page. A finished run (killed or completed) stays viewable: runState carries its state. The read is audited as run.surface.viewed.

- Operation ID: `getRunSurface`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter       | In    | Required | Type                      | Description                                                                                                                                              |
| --------------- | ----- | -------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`         | path  | yes      | string (uuid)             |                                                                                                                                                          |
| `kinds`         | query | no       | string                    | Comma-separated node kinds to keep (asset, host, service, technology, endpoint, parameter, role).                                                        |
| `minConfidence` | query | no       | number                    | Keep nodes and edges with provenance confidence at least this (0 to 1).                                                                                  |
| `inScopeOnly`   | query | no       | enum: `"true"`, `"false"` | true keeps only nodes not marked out of scope (hosts with inScope false are dropped). The graph applies it, so truncation and totals reflect the filter. |
| `cursor`        | query | no       | string                    | Opaque cursor: the pageInfo.endCursor of the previous page.                                                                                              |
| `limit`         | query | no       | integer                   | Nodes per page, 1 to 200. Larger or non-numeric values answer 400 INVALID_QUERY.                                                                         |

#### Response 200

The view of one page of the run surface.

Content type `application/json`: [SurfaceRunView](#surfacerunview).

Example: Example.

```json
{
  "nodes": [
    {
      "id": "host:018f2a6e-1c00-7000-8000-00000000000a:api.example.test",
      "kind": "host",
      "label": "api.example.test",
      "inScope": true,
      "confidence": 0.9,
      "degree": 1,
      "provenance": {
        "runId": "01890a5d-ac96-774b-bcce-b302099a8058",
        "tool": "nmap",
        "firstSeenAt": "2026-10-29T10:00:00.000Z",
        "lastSeenAt": "2026-10-29T10:05:00.000Z"
      }
    }
  ],
  "edges": [],
  "totals": {
    "nodes": 1,
    "edges": 0
  },
  "truncated": false,
  "pageInfo": {
    "hasNextPage": false
  },
  "clusteredBy": "asset",
  "runState": "recon"
}
```

#### Response 400

Problem details; code is one of INVALID_QUERY, INVALID_CURSOR.

Content type `application/problem+json`: [Problem](#problem).

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

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

Problem details; code is one of RUN_NOT_FOUND.

Content type `application/problem+json`: [Problem](#problem).

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
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

## gate1

Gate 1: approval of the test plan before any test runs (separation of duties, §8.4).

### GET /runs/{runId}/gate1

**Read the test plan under Gate 1 review**

Requires testplan:read. `viewer.canDecide` is a UX hint: false for the requester, for a caller without testplan:approve, and for a run not awaiting Gate 1.

- Operation ID: `getGate1Plan`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type   | Description |
| --------- | ---- | -------- | ------ | ----------- |
| `runId`   | path | yes      | string |             |

#### Response 200

The plan and what the caller may do with it.

Content type `application/json`: [Gate1PlanView](#gate1planview).

Example: Example.

```json
{
  "runId": "run_01jbz3k6w8f5r4t2n9q7x0m1ab",
  "runState": "awaiting_gate1",
  "planVersion": 3,
  "requesterId": "user-requester",
  "requestedAt": "2026-10-29T08:00:00.000Z",
  "expiresAt": "2026-10-29T12:00:00.000Z",
  "testCases": [
    {
      "id": "tc-1",
      "title": "Security headers reviewed",
      "class": "passive",
      "targets": ["https://lab.example.test/"],
      "budget": {
        "maxRequests": 10,
        "maxRps": 1,
        "maxConcurrency": 1,
        "maxBytes": 100
      }
    }
  ],
  "budgetTotals": {
    "maxRequests": 10,
    "maxBytes": 100
  },
  "changes": null,
  "viewer": {
    "canDecide": true,
    "isRequester": false
  }
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
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

### POST /runs/{runId}/gate1/decisions

**Approve, request changes to, or reject a test plan**

Requires testplan:approve and an Idempotency-Key. The requester may not decide their own plan (403 SOD_VIOLATION). `planVersion` must be the version reviewed (409 GATE1_PLAN_STALE otherwise). A replay with the same key and body answers the first result.

- Operation ID: `decideGate1`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter         | In     | Required | Type   | Description                                                            |
| ----------------- | ------ | -------- | ------ | ---------------------------------------------------------------------- |
| `runId`           | path   | yes      | string |                                                                        |
| `Idempotency-Key` | header | yes      | string | Unique per decision attempt; reuse it only to retry the same decision. |

**Request body** (required)

Content type `application/json`: [Gate1DecisionRequest](#gate1decisionrequest).

Example: Example.

```json
{
  "decision": "request_changes",
  "planVersion": 3,
  "reason": "Drop the admin panel from scope."
}
```

#### Response 200

The decision and the run state it produced.

Content type `application/json`: [Gate1DecisionResponse](#gate1decisionresponse).

Example: Example.

```json
{
  "runId": "run_01jbz3k6w8f5r4t2n9q7x0m1ab",
  "decision": "approve",
  "planVersion": 3,
  "runState": "approved",
  "decidedAt": "2026-10-29T10:00:00.000Z"
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

Problem details; code is one of FORBIDDEN, SOD_VIOLATION, TENANT_CONTEXT_MISSING.

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

Example: Separation of duties violated.

```json
{
  "type": "https://errors.blackwing.dev/SOD_VIOLATION",
  "title": "Separation of duties violated",
  "status": 403,
  "code": "SOD_VIOLATION",
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

Problem details; code is one of GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
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

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
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

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
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

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
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

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, AUTHZ_SOD_VIOLATION, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, OPERATOR_MFA_REQUIRED, TENANT_MISMATCH, SECRET_PURPOSE_DENIED, GRAPH_NO_TENANT_CONTEXT, GRAPH_TENANT_MISMATCH, SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Example: Operator MFA required.

```json
{
  "type": "https://errors.blackwing.dev/OPERATOR_MFA_REQUIRED",
  "title": "Operator MFA required",
  "status": 403,
  "code": "OPERATOR_MFA_REQUIRED",
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

Example: Graph tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_NO_TENANT_CONTEXT",
  "title": "Graph tenant context missing",
  "status": 403,
  "code": "GRAPH_NO_TENANT_CONTEXT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Graph tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_TENANT_MISMATCH",
  "title": "Graph tenant mismatch",
  "status": 403,
  "code": "GRAPH_TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Separation of duties violated.

```json
{
  "type": "https://errors.blackwing.dev/SOD_VIOLATION",
  "title": "Separation of duties violated",
  "status": 403,
  "code": "SOD_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, AUTHZ_SOD_VIOLATION, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, OPERATOR_MFA_REQUIRED, TENANT_MISMATCH, SECRET_PURPOSE_DENIED, GRAPH_NO_TENANT_CONTEXT, GRAPH_TENANT_MISMATCH, SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Example: Operator MFA required.

```json
{
  "type": "https://errors.blackwing.dev/OPERATOR_MFA_REQUIRED",
  "title": "Operator MFA required",
  "status": 403,
  "code": "OPERATOR_MFA_REQUIRED",
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

Example: Graph tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_NO_TENANT_CONTEXT",
  "title": "Graph tenant context missing",
  "status": 403,
  "code": "GRAPH_NO_TENANT_CONTEXT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Graph tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_TENANT_MISMATCH",
  "title": "Graph tenant mismatch",
  "status": 403,
  "code": "GRAPH_TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Separation of duties violated.

```json
{
  "type": "https://errors.blackwing.dev/SOD_VIOLATION",
  "title": "Separation of duties violated",
  "status": 403,
  "code": "SOD_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
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

## tenant

Tenant settings: display timezone, default assessment mode and the read-only data region.

### GET /tenant/settings

**Read the tenant settings**

- Operation ID: `getTenantSettings`
- Authentication: `bearerAuth` or `sessionCookie`

#### Response 200

The current settings, region and ETag.

| Header | Description                                                            |
| ------ | ---------------------------------------------------------------------- |
| `ETag` | Strong validator of this settings state. Send it in If-Match on PATCH. |

Content type `application/json`: [TenantSettingsResponse](#tenantsettingsresponse).

Example: Settings with a display zone.

```json
{
  "settings": {
    "displayTimezone": "Europe/Berlin",
    "defaultAssessmentMode": "grey",
    "weekStartsOn": 1
  },
  "region": "eu-west-1",
  "updatedAt": "2026-10-01T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, AUTHZ_SOD_VIOLATION, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, OPERATOR_MFA_REQUIRED, TENANT_MISMATCH, SECRET_PURPOSE_DENIED, GRAPH_NO_TENANT_CONTEXT, GRAPH_TENANT_MISMATCH, SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Example: Operator MFA required.

```json
{
  "type": "https://errors.blackwing.dev/OPERATOR_MFA_REQUIRED",
  "title": "Operator MFA required",
  "status": 403,
  "code": "OPERATOR_MFA_REQUIRED",
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

Example: Graph tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_NO_TENANT_CONTEXT",
  "title": "Graph tenant context missing",
  "status": 403,
  "code": "GRAPH_NO_TENANT_CONTEXT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Graph tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_TENANT_MISMATCH",
  "title": "Graph tenant mismatch",
  "status": 403,
  "code": "GRAPH_TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Separation of duties violated.

```json
{
  "type": "https://errors.blackwing.dev/SOD_VIOLATION",
  "title": "Separation of duties violated",
  "status": 403,
  "code": "SOD_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
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

### PATCH /tenant/settings

**Change the tenant settings**

Requires If-Match. Unknown keys and region are rejected. An unknown time zone answers invalid_timezone. An empty or unchanged body is a no-op.

- Operation ID: `updateTenantSettings`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type   | Description                                                                                      |
| ---------- | ------ | -------- | ------ | ------------------------------------------------------------------------------------------------ |
| `If-Match` | header | yes      | string | The ETag of the settings being changed (from GET). A stale value answers 412, a missing one 428. |

**Request body** (required)

Content type `application/json`: [TenantSettingsPatch](#tenantsettingspatch).

Example: Change the display zone.

```json
{
  "displayTimezone": "Europe/Berlin"
}
```

#### Response 200

The settings after the change and the new ETag.

| Header | Description                                                            |
| ------ | ---------------------------------------------------------------------- |
| `ETag` | Strong validator of this settings state. Send it in If-Match on PATCH. |

Content type `application/json`: [TenantSettingsResponse](#tenantsettingsresponse).

Example: Settings with a display zone.

```json
{
  "settings": {
    "displayTimezone": "Europe/Berlin",
    "defaultAssessmentMode": "grey",
    "weekStartsOn": 1
  },
  "region": "eu-west-1",
  "updatedAt": "2026-10-01T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, AUTHZ_SOD_VIOLATION, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, OPERATOR_MFA_REQUIRED, TENANT_MISMATCH, SECRET_PURPOSE_DENIED, GRAPH_NO_TENANT_CONTEXT, GRAPH_TENANT_MISMATCH, SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Example: Operator MFA required.

```json
{
  "type": "https://errors.blackwing.dev/OPERATOR_MFA_REQUIRED",
  "title": "Operator MFA required",
  "status": 403,
  "code": "OPERATOR_MFA_REQUIRED",
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

Example: Graph tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_NO_TENANT_CONTEXT",
  "title": "Graph tenant context missing",
  "status": 403,
  "code": "GRAPH_NO_TENANT_CONTEXT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Graph tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_TENANT_MISMATCH",
  "title": "Graph tenant mismatch",
  "status": 403,
  "code": "GRAPH_TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Separation of duties violated.

```json
{
  "type": "https://errors.blackwing.dev/SOD_VIOLATION",
  "title": "Separation of duties violated",
  "status": 403,
  "code": "SOD_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of PRECONDITION_FAILED, ETAG_MISMATCH.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition failed.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_FAILED",
  "title": "Precondition failed",
  "status": 412,
  "code": "PRECONDITION_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: ETag mismatch.

```json
{
  "type": "https://errors.blackwing.dev/ETAG_MISMATCH",
  "title": "ETag mismatch",
  "status": 412,
  "code": "ETAG_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

## assessment-requests

Assessment requests: draft, edit, submit (validated against the standing authorisation) and withdraw. Submitting never starts a run.

### GET /assessment-requests

**List the assessment requests of the tenant, newest first**

- Operation ID: `listAssessmentRequests`
- Authentication: `bearerAuth` or `sessionCookie`

#### Response 200

The requests of the caller tenant.

Content type `application/json`: [AssessmentRequestList](#assessmentrequestlist).

Example: One draft.

```json
{
  "items": [
    {
      "id": "areq_01m64cavacexhrddgjb6xd80xv",
      "status": "draft",
      "mode": "grey",
      "objective": "Test the login flow for authentication bypass",
      "assetIds": ["0198f0a0-0000-7000-8000-0000000000e1"],
      "saId": "0198f0a0-0000-7000-8000-0000000000f1",
      "inputManifestId": null,
      "scopeRules": {
        "rules": [
          {
            "effect": "include",
            "host": "app.example.test"
          }
        ]
      },
      "maxIntrusiveness": "active_safe",
      "budgets": {
        "costCapUsd": 5,
        "maxRequests": 5000,
        "maxDurationMs": 3600000
      },
      "trigger": "console",
      "requestedBy": "0198f0a0-0000-7000-8000-0000000000a1",
      "stateVersion": 0,
      "createdAt": "2026-10-29T10:00:00.000Z",
      "updatedAt": "2026-10-29T10:00:00.000Z"
    }
  ]
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, AUTHZ_SOD_VIOLATION, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, OPERATOR_MFA_REQUIRED, TENANT_MISMATCH, SECRET_PURPOSE_DENIED, GRAPH_NO_TENANT_CONTEXT, GRAPH_TENANT_MISMATCH, SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Example: Operator MFA required.

```json
{
  "type": "https://errors.blackwing.dev/OPERATOR_MFA_REQUIRED",
  "title": "Operator MFA required",
  "status": 403,
  "code": "OPERATOR_MFA_REQUIRED",
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

Example: Graph tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_NO_TENANT_CONTEXT",
  "title": "Graph tenant context missing",
  "status": 403,
  "code": "GRAPH_NO_TENANT_CONTEXT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Graph tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_TENANT_MISMATCH",
  "title": "Graph tenant mismatch",
  "status": 403,
  "code": "GRAPH_TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Separation of duties violated.

```json
{
  "type": "https://errors.blackwing.dev/SOD_VIOLATION",
  "title": "Separation of duties violated",
  "status": 403,
  "code": "SOD_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
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

### POST /assessment-requests

**Create a draft assessment request**

Needs assessment:create. Every named asset must belong to the tenant (404 otherwise). Nothing is validated against the standing authorisation until submit.

- Operation ID: `createAssessmentRequest`
- Authentication: `bearerAuth` or `sessionCookie`

**Request body** (required)

Content type `application/json`: [AssessmentRequestCreate](#assessmentrequestcreate).

Example: A grey-box draft over one verified asset.

```json
{
  "mode": "grey",
  "objective": "Test the login flow for authentication bypass",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000e1"],
  "saId": "0198f0a0-0000-7000-8000-0000000000f1",
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  }
}
```

#### Response 201

The created draft and its ETag.

| Header | Description                                                                        |
| ------ | ---------------------------------------------------------------------------------- |
| `ETag` | Strong validator of this request state. Send it in If-Match on PATCH and withdraw. |

Content type `application/json`: [AssessmentRequest](#assessmentrequest).

Example: A draft request.

```json
{
  "id": "areq_01m64cavacexhrddgjb6xd80xv",
  "status": "draft",
  "mode": "grey",
  "objective": "Test the login flow for authentication bypass",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000e1"],
  "saId": "0198f0a0-0000-7000-8000-0000000000f1",
  "inputManifestId": null,
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  },
  "maxIntrusiveness": "active_safe",
  "budgets": {
    "costCapUsd": 5,
    "maxRequests": 5000,
    "maxDurationMs": 3600000
  },
  "trigger": "console",
  "requestedBy": "0198f0a0-0000-7000-8000-0000000000a1",
  "stateVersion": 0,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, AUTHZ_SOD_VIOLATION, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, OPERATOR_MFA_REQUIRED, TENANT_MISMATCH, SECRET_PURPOSE_DENIED, GRAPH_NO_TENANT_CONTEXT, GRAPH_TENANT_MISMATCH, SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Example: Operator MFA required.

```json
{
  "type": "https://errors.blackwing.dev/OPERATOR_MFA_REQUIRED",
  "title": "Operator MFA required",
  "status": 403,
  "code": "OPERATOR_MFA_REQUIRED",
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

Example: Graph tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_NO_TENANT_CONTEXT",
  "title": "Graph tenant context missing",
  "status": 403,
  "code": "GRAPH_NO_TENANT_CONTEXT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Graph tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_TENANT_MISMATCH",
  "title": "Graph tenant mismatch",
  "status": 403,
  "code": "GRAPH_TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Separation of duties violated.

```json
{
  "type": "https://errors.blackwing.dev/SOD_VIOLATION",
  "title": "Separation of duties violated",
  "status": 403,
  "code": "SOD_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Body validation failed (validation_failed).

Content type `application/problem+json`: [Problem](#problem).

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

### GET /assessment-requests/{id}

**Read one assessment request**

- Operation ID: `getAssessmentRequest`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type   | Description                                       |
| --------- | ---- | -------- | ------ | ------------------------------------------------- |
| `id`      | path | yes      | string | The `areq_…` public id of the assessment request. |

#### Response 200

The request and its ETag.

| Header | Description                                                                        |
| ------ | ---------------------------------------------------------------------------------- |
| `ETag` | Strong validator of this request state. Send it in If-Match on PATCH and withdraw. |

Content type `application/json`: [AssessmentRequest](#assessmentrequest).

Example: A draft request.

```json
{
  "id": "areq_01m64cavacexhrddgjb6xd80xv",
  "status": "draft",
  "mode": "grey",
  "objective": "Test the login flow for authentication bypass",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000e1"],
  "saId": "0198f0a0-0000-7000-8000-0000000000f1",
  "inputManifestId": null,
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  },
  "maxIntrusiveness": "active_safe",
  "budgets": {
    "costCapUsd": 5,
    "maxRequests": 5000,
    "maxDurationMs": 3600000
  },
  "trigger": "console",
  "requestedBy": "0198f0a0-0000-7000-8000-0000000000a1",
  "stateVersion": 0,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, AUTHZ_SOD_VIOLATION, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, OPERATOR_MFA_REQUIRED, TENANT_MISMATCH, SECRET_PURPOSE_DENIED, GRAPH_NO_TENANT_CONTEXT, GRAPH_TENANT_MISMATCH, SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Example: Operator MFA required.

```json
{
  "type": "https://errors.blackwing.dev/OPERATOR_MFA_REQUIRED",
  "title": "Operator MFA required",
  "status": 403,
  "code": "OPERATOR_MFA_REQUIRED",
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

Example: Graph tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_NO_TENANT_CONTEXT",
  "title": "Graph tenant context missing",
  "status": 403,
  "code": "GRAPH_NO_TENANT_CONTEXT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Graph tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_TENANT_MISMATCH",
  "title": "Graph tenant mismatch",
  "status": 403,
  "code": "GRAPH_TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Separation of duties violated.

```json
{
  "type": "https://errors.blackwing.dev/SOD_VIOLATION",
  "title": "Separation of duties violated",
  "status": 403,
  "code": "SOD_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Not found in this tenant.

Content type `application/problem+json`: [Problem](#problem).

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
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

### PATCH /assessment-requests/{id}

**Edit a draft assessment request**

Requires If-Match. Only a draft can be edited (409 otherwise). An empty body is refused.

- Operation ID: `updateAssessmentRequest`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type   | Description                                                                                     |
| ---------- | ------ | -------- | ------ | ----------------------------------------------------------------------------------------------- |
| `id`       | path   | yes      | string | The `areq_…` public id of the assessment request.                                               |
| `If-Match` | header | yes      | string | The ETag of the request being changed (from GET). A stale value answers 412, a missing one 428. |

**Request body** (required)

Content type `application/json`: [AssessmentRequestPatch](#assessmentrequestpatch).

#### Response 200

The edited draft and its new ETag.

| Header | Description                                                                        |
| ------ | ---------------------------------------------------------------------------------- |
| `ETag` | Strong validator of this request state. Send it in If-Match on PATCH and withdraw. |

Content type `application/json`: [AssessmentRequest](#assessmentrequest).

Example: A draft request.

```json
{
  "id": "areq_01m64cavacexhrddgjb6xd80xv",
  "status": "draft",
  "mode": "grey",
  "objective": "Test the login flow for authentication bypass",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000e1"],
  "saId": "0198f0a0-0000-7000-8000-0000000000f1",
  "inputManifestId": null,
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  },
  "maxIntrusiveness": "active_safe",
  "budgets": {
    "costCapUsd": 5,
    "maxRequests": 5000,
    "maxDurationMs": 3600000
  },
  "trigger": "console",
  "requestedBy": "0198f0a0-0000-7000-8000-0000000000a1",
  "stateVersion": 0,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, AUTHZ_SOD_VIOLATION, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, OPERATOR_MFA_REQUIRED, TENANT_MISMATCH, SECRET_PURPOSE_DENIED, GRAPH_NO_TENANT_CONTEXT, GRAPH_TENANT_MISMATCH, SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Example: Operator MFA required.

```json
{
  "type": "https://errors.blackwing.dev/OPERATOR_MFA_REQUIRED",
  "title": "Operator MFA required",
  "status": 403,
  "code": "OPERATOR_MFA_REQUIRED",
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

Example: Graph tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_NO_TENANT_CONTEXT",
  "title": "Graph tenant context missing",
  "status": 403,
  "code": "GRAPH_NO_TENANT_CONTEXT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Graph tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_TENANT_MISMATCH",
  "title": "Graph tenant mismatch",
  "status": 403,
  "code": "GRAPH_TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Separation of duties violated.

```json
{
  "type": "https://errors.blackwing.dev/SOD_VIOLATION",
  "title": "Separation of duties violated",
  "status": 403,
  "code": "SOD_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

The ETag is stale.

Content type `application/problem+json`: [Problem](#problem).

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 428

If-Match is missing.

Content type `application/problem+json`: [Problem](#problem).

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

### POST /assessment-requests/{id}/submit

**Submit a draft after the scope gate**

Runs every check of the gate (asset verification, standing authorisation status, expiry, coverage, intrusiveness ceiling, scope subset, budgets) and answers 422 with all failing checks in errors[] (each with its code and path). A halted tenant answers 409 tenant_halted. Needs Idempotency-Key.

- Operation ID: `submitAssessmentRequest`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter         | In     | Required | Type   | Description                                                                                                                    |
| ----------------- | ------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`              | path   | yes      | string | The `areq_…` public id of the assessment request.                                                                              |
| `Idempotency-Key` | header | yes      | string | Unique per submit attempt (8 to 255 visible ASCII characters). A replay answers the original response and creates nothing new. |

#### Response 200

The submitted request.

| Header | Description                                                                        |
| ------ | ---------------------------------------------------------------------------------- |
| `ETag` | Strong validator of this request state. Send it in If-Match on PATCH and withdraw. |

Content type `application/json`: [AssessmentRequest](#assessmentrequest).

Example: A draft request.

```json
{
  "id": "areq_01m64cavacexhrddgjb6xd80xv",
  "status": "draft",
  "mode": "grey",
  "objective": "Test the login flow for authentication bypass",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000e1"],
  "saId": "0198f0a0-0000-7000-8000-0000000000f1",
  "inputManifestId": null,
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  },
  "maxIntrusiveness": "active_safe",
  "budgets": {
    "costCapUsd": 5,
    "maxRequests": 5000,
    "maxDurationMs": 3600000
  },
  "trigger": "console",
  "requestedBy": "0198f0a0-0000-7000-8000-0000000000a1",
  "stateVersion": 0,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, AUTHZ_SOD_VIOLATION, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, OPERATOR_MFA_REQUIRED, TENANT_MISMATCH, SECRET_PURPOSE_DENIED, GRAPH_NO_TENANT_CONTEXT, GRAPH_TENANT_MISMATCH, SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Example: Operator MFA required.

```json
{
  "type": "https://errors.blackwing.dev/OPERATOR_MFA_REQUIRED",
  "title": "Operator MFA required",
  "status": 403,
  "code": "OPERATOR_MFA_REQUIRED",
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

Example: Graph tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_NO_TENANT_CONTEXT",
  "title": "Graph tenant context missing",
  "status": 403,
  "code": "GRAPH_NO_TENANT_CONTEXT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Graph tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_TENANT_MISMATCH",
  "title": "Graph tenant mismatch",
  "status": 403,
  "code": "GRAPH_TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Separation of duties violated.

```json
{
  "type": "https://errors.blackwing.dev/SOD_VIOLATION",
  "title": "Separation of duties violated",
  "status": 403,
  "code": "SOD_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

The tenant is halted (tenant_halted), or the request is no longer a draft.

Content type `application/problem+json`: [Problem](#problem).

#### Response 422

One or more submit checks failed; errors[] lists every failing check.

Content type `application/problem+json`: [Problem](#problem).

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

### POST /assessment-requests/{id}/withdraw

**Withdraw a request**

Requires If-Match. A withdrawn request is terminal.

- Operation ID: `withdrawAssessmentRequest`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type   | Description                                                                                     |
| ---------- | ------ | -------- | ------ | ----------------------------------------------------------------------------------------------- |
| `id`       | path   | yes      | string | The `areq_…` public id of the assessment request.                                               |
| `If-Match` | header | yes      | string | The ETag of the request being changed (from GET). A stale value answers 412, a missing one 428. |

#### Response 200

The withdrawn request.

| Header | Description                                                                        |
| ------ | ---------------------------------------------------------------------------------- |
| `ETag` | Strong validator of this request state. Send it in If-Match on PATCH and withdraw. |

Content type `application/json`: [AssessmentRequest](#assessmentrequest).

Example: A draft request.

```json
{
  "id": "areq_01m64cavacexhrddgjb6xd80xv",
  "status": "draft",
  "mode": "grey",
  "objective": "Test the login flow for authentication bypass",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000e1"],
  "saId": "0198f0a0-0000-7000-8000-0000000000f1",
  "inputManifestId": null,
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  },
  "maxIntrusiveness": "active_safe",
  "budgets": {
    "costCapUsd": 5,
    "maxRequests": 5000,
    "maxDurationMs": 3600000
  },
  "trigger": "console",
  "requestedBy": "0198f0a0-0000-7000-8000-0000000000a1",
  "stateVersion": 0,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, TENANT_CONTEXT_MISSING, CROSS_TENANT_DENIED, SEED_FORBIDDEN_IN_PROD, TENANT_CONTEXT_MISMATCH, SCOPE_VIOLATION, SCOPE_INTRUSIVENESS_EXCEEDS_CEILING, SCOPE_DESTRUCTIVE_FORBIDDEN, SCOPE_BUDGET_EXCEEDS_SA, AUTHZ_SOD_VIOLATION, OVERRIDE_FIELD_FORBIDDEN, MODEL_NOT_ALLOWED, AAD_MISMATCH, PROMPT_DRAFT_FORBIDDEN, KILL_FORBIDDEN, KILL_GLOBAL_NOT_ALLOWED_HERE, NOT_OPERATOR, OPERATOR_MFA_REQUIRED, TENANT_MISMATCH, SECRET_PURPOSE_DENIED, GRAPH_NO_TENANT_CONTEXT, GRAPH_TENANT_MISMATCH, SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Example: Operator MFA required.

```json
{
  "type": "https://errors.blackwing.dev/OPERATOR_MFA_REQUIRED",
  "title": "Operator MFA required",
  "status": 403,
  "code": "OPERATOR_MFA_REQUIRED",
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

Example: Graph tenant context missing.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_NO_TENANT_CONTEXT",
  "title": "Graph tenant context missing",
  "status": 403,
  "code": "GRAPH_NO_TENANT_CONTEXT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Graph tenant mismatch.

```json
{
  "type": "https://errors.blackwing.dev/GRAPH_TENANT_MISMATCH",
  "title": "Graph tenant mismatch",
  "status": 403,
  "code": "GRAPH_TENANT_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Separation of duties violated.

```json
{
  "type": "https://errors.blackwing.dev/SOD_VIOLATION",
  "title": "Separation of duties violated",
  "status": 403,
  "code": "SOD_VIOLATION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

The ETag is stale.

Content type `application/problem+json`: [Problem](#problem).

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 428

If-Match is missing.

Content type `application/problem+json`: [Problem](#problem).

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

## assets

Asset registry: register, read, list, update and retire assets.

### GET /assets

**List assets (cursor pages, newest first)**

- Operation ID: `listAssets`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter            | In    | Required | Type                                                                     | Description |
| -------------------- | ----- | -------- | ------------------------------------------------------------------------ | ----------- |
| `cursor`             | query | no       | string                                                                   |             |
| `limit`              | query | no       | integer                                                                  |             |
| `type`               | query | no       | enum: `"web_app"`, `"api"`, `"host"`, `"network_range"`, `"source_repo"` |             |
| `environment`        | query | no       | enum: `"prod"`, `"staging"`, `"dev"`, `"test"`                           |             |
| `verificationStatus` | query | no       | enum: `"unverified"`, `"pending"`, `"verified"`, `"rejected"`            |             |

#### Response 200

One page of the projection (the scoping wizard fields). `nextCursor` is null on the last page. Each item’s `id` is the UUID; the full view is on `GET /v1/assets/{id}`.

| Header          | Description |
| --------------- | ----------- |
| `Cache-Control` |             |

Content type `application/json`: [AssetPage](#assetpage).

Example: Example.

```json
{
  "items": [
    {
      "id": "0198f0a0-0000-7000-8000-0000000000e1",
      "name": "Juice Shop (lab)",
      "type": "web_app",
      "environment": "dev",
      "verificationStatus": "verified"
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, IDEMPOTENCY_KEY_MISMATCH, ASSET_INVALID_IDENTIFIER.

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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
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

### POST /assets

**Register an asset**

Creates an asset in the caller’s tenant, owned by `ownerUserId` (who must be a member). Identifiers are normalised; the asset starts `unverified` and cannot be targeted until verified (§8.10).

- Operation ID: `createAsset`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter         | In     | Required | Type   | Description                                                                                                                                      |
| ----------------- | ------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Idempotency-Key` | header | no       | string | Optional. A replay with the same key and body returns the asset the first request created (200); the same key with a different body answers 422. |

**Request body** (required)

Content type `application/json`: [CreateAssetBody](#createassetbody).

Example: Example.

```json
{
  "type": "web_app",
  "name": "Customer portal",
  "identifiers": [
    {
      "kind": "url",
      "value": "https://portal.example.com"
    }
  ],
  "environment": "staging",
  "ownerUserId": "0198f0a0-0000-7000-8000-00000000000a"
}
```

#### Response 200

Replay of an earlier create with the same `Idempotency-Key`: the same asset.

Content type `application/json`: [AssetView](#assetview).

Example: Example.

```json
{
  "id": "0198f0a0-0000-7000-8000-0000000000e1",
  "publicId": "asset_0r3h7k4xw0c8g1n5p2q6v9m3yt",
  "type": "web_app",
  "name": "Customer portal",
  "identifiers": [
    {
      "kind": "url",
      "value": "https://portal.example.com/"
    }
  ],
  "environment": "staging",
  "ownerUserId": "0198f0a0-0000-7000-8000-00000000000a",
  "verificationStatus": "unverified",
  "verificationMethod": null,
  "etag": "\"v1\"",
  "createdAt": "2026-10-30T10:00:00.000Z",
  "updatedAt": "2026-10-30T10:00:00.000Z",
  "warnings": []
}
```

#### Response 201

Created. The `ETag` header carries the asset version.

| Header     | Description |
| ---------- | ----------- |
| `ETag`     |             |
| `Location` |             |

Content type `application/json`: [AssetView](#assetview).

Example: Example.

```json
{
  "id": "0198f0a0-0000-7000-8000-0000000000e1",
  "publicId": "asset_0r3h7k4xw0c8g1n5p2q6v9m3yt",
  "type": "web_app",
  "name": "Customer portal",
  "identifiers": [
    {
      "kind": "url",
      "value": "https://portal.example.com/"
    }
  ],
  "environment": "staging",
  "ownerUserId": "0198f0a0-0000-7000-8000-00000000000a",
  "verificationStatus": "unverified",
  "verificationMethod": null,
  "etag": "\"v1\"",
  "createdAt": "2026-10-30T10:00:00.000Z",
  "updatedAt": "2026-10-30T10:00:00.000Z",
  "warnings": []
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, IDEMPOTENCY_KEY_MISMATCH, ASSET_INVALID_IDENTIFIER.

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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
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

### GET /assets/{id}

**Get one asset**

A soft-deleted asset is `404`, as is an id of another tenant (never `403`, §8.6).

- Operation ID: `getAsset`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type   | Description                  |
| --------- | ---- | -------- | ------ | ---------------------------- |
| `id`      | path | yes      | string | Public asset id (`asset_…`). |

#### Response 200

The asset. The `ETag` header is the value to send back in `If-Match`.

| Header | Description |
| ------ | ----------- |
| `ETag` |             |

Content type `application/json`: [AssetView](#assetview).

Example: Example.

```json
{
  "id": "0198f0a0-0000-7000-8000-0000000000e1",
  "publicId": "asset_0r3h7k4xw0c8g1n5p2q6v9m3yt",
  "type": "web_app",
  "name": "Customer portal",
  "identifiers": [
    {
      "kind": "url",
      "value": "https://portal.example.com/"
    }
  ],
  "environment": "staging",
  "ownerUserId": "0198f0a0-0000-7000-8000-00000000000a",
  "verificationStatus": "unverified",
  "verificationMethod": null,
  "etag": "\"v1\"",
  "createdAt": "2026-10-30T10:00:00.000Z",
  "updatedAt": "2026-10-30T10:00:00.000Z",
  "warnings": []
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of ASSET_STALE_WRITE, ASSET_IN_USE.

Content type `application/problem+json`: [Problem](#problem).

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, ASSET_INVALID_IDENTIFIER.

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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### DELETE /assets/{id}

**Soft-delete an asset**

The row is kept (audit history); the asset disappears from GET and list. Answers the retired asset. Refused with `409 ASSET_IN_USE` while an active or pending standing authorisation covers it.

- Operation ID: `deleteAsset`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type   | Description                                          |
| ---------- | ------ | -------- | ------ | ---------------------------------------------------- |
| `id`       | path   | yes      | string | Public asset id (`asset_…`).                         |
| `If-Match` | header | no       | string | Optional. When present, must match the current ETag. |

#### Response 200

Deleted. The body is the retired asset; the `ETag` header is its final version.

| Header | Description |
| ------ | ----------- |
| `ETag` |             |

Content type `application/json`: [AssetView](#assetview).

Example: Example.

```json
{
  "id": "0198f0a0-0000-7000-8000-0000000000e1",
  "publicId": "asset_0r3h7k4xw0c8g1n5p2q6v9m3yt",
  "type": "web_app",
  "name": "Customer portal",
  "identifiers": [
    {
      "kind": "url",
      "value": "https://portal.example.com/"
    }
  ],
  "environment": "staging",
  "ownerUserId": "0198f0a0-0000-7000-8000-00000000000a",
  "verificationStatus": "unverified",
  "verificationMethod": null,
  "etag": "\"v1\"",
  "createdAt": "2026-10-30T10:00:00.000Z",
  "updatedAt": "2026-10-30T10:00:00.000Z",
  "warnings": []
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of ASSET_STALE_WRITE, ASSET_IN_USE.

Content type `application/problem+json`: [Problem](#problem).

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of PRECONDITION_FAILED, ETAG_MISMATCH.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition failed.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_FAILED",
  "title": "Precondition failed",
  "status": 412,
  "code": "PRECONDITION_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: ETag mismatch.

```json
{
  "type": "https://errors.blackwing.dev/ETAG_MISMATCH",
  "title": "ETag mismatch",
  "status": 412,
  "code": "ETAG_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, ASSET_INVALID_IDENTIFIER.

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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### PATCH /assets/{id}

**Update an asset (optimistic concurrency)**

- Operation ID: `updateAsset`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type   | Description                                                                                                                           |
| ---------- | ------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | path   | yes      | string | Public asset id (`asset_…`).                                                                                                          |
| `If-Match` | header | yes      | string | The ETag from the last GET (or the write that produced the current version). Required; a stale value answers 409 `ASSET_STALE_WRITE`. |

**Request body** (required)

Content type `application/json`: [UpdateAssetBody](#updateassetbody).

Example: Example.

```json
{
  "name": "Customer portal (EU)"
}
```

#### Response 200

Updated. The `ETag` header carries the new version.

| Header | Description |
| ------ | ----------- |
| `ETag` |             |

Content type `application/json`: [AssetView](#assetview).

Example: Example.

```json
{
  "id": "0198f0a0-0000-7000-8000-0000000000e1",
  "publicId": "asset_0r3h7k4xw0c8g1n5p2q6v9m3yt",
  "type": "web_app",
  "name": "Customer portal",
  "identifiers": [
    {
      "kind": "url",
      "value": "https://portal.example.com/"
    }
  ],
  "environment": "staging",
  "ownerUserId": "0198f0a0-0000-7000-8000-00000000000a",
  "verificationStatus": "unverified",
  "verificationMethod": null,
  "etag": "\"v1\"",
  "createdAt": "2026-10-30T10:00:00.000Z",
  "updatedAt": "2026-10-30T10:00:00.000Z",
  "warnings": []
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of ASSET_STALE_WRITE, ASSET_IN_USE.

Content type `application/problem+json`: [Problem](#problem).

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of PRECONDITION_FAILED, ETAG_MISMATCH.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition failed.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_FAILED",
  "title": "Precondition failed",
  "status": 412,
  "code": "PRECONDITION_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: ETag mismatch.

```json
{
  "type": "https://errors.blackwing.dev/ETAG_MISMATCH",
  "title": "ETag mismatch",
  "status": 412,
  "code": "ETAG_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, ASSET_INVALID_IDENTIFIER.

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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

## standing-authorisations

Standing authorisations (AUTHZ-002, AUTHZ-008): the customer-signed, expiring permission to test assets. Drafts are created, read, changed and submitted for approval here; an asset owner approves (signing it) or rejects.

### GET /standing-authorisations

**List standing authorisations**

Cursor-paginated, in id order. nextCursor is null on the last page.

- Operation ID: `listStandingAuthorisations`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In    | Required | Type    | Description |
| --------- | ----- | -------- | ------- | ----------- |
| `cursor`  | query | no       | string  |             |
| `limit`   | query | no       | integer |             |

#### Response 200

One page of standing authorisations.

Content type `application/json`: object.

Example: A single, last page.

```json
{
  "items": [
    {
      "id": "sa_0198f0a0000070008000000000000001",
      "assetIds": ["0198f0a0-0000-7000-8000-0000000000a1"],
      "scopeRules": {
        "rules": [
          {
            "effect": "include",
            "host": "app.example.test"
          }
        ]
      },
      "maxIntrusiveness": "active_safe",
      "preApprovedTestClasses": ["header-audit"],
      "defaultBudgets": {
        "costCapUsd": 5,
        "maxRequests": 1000,
        "maxDurationMs": 3600000
      },
      "testWindows": [
        {
          "cron": "0 2 * * 1-5",
          "timezone": "Europe/Berlin",
          "durationMs": 7200000
        }
      ],
      "validFrom": "2026-11-01T00:00:00.000Z",
      "expiresAt": "2026-12-01T00:00:00.000Z",
      "requesterId": "0198f0a0-0000-7000-8000-0000000000a2",
      "approverId": null,
      "signature": null,
      "signingKeyId": null,
      "status": "draft",
      "revocationReason": null,
      "version": 1,
      "createdAt": "2026-10-29T10:00:00.000Z",
      "updatedAt": "2026-10-29T10:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "hasMore": false
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN.

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

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
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

### POST /standing-authorisations

**Create a draft standing authorisation**

Requires Idempotency-Key. The caller becomes the requester. The draft is not yet approved or signed.

- Operation ID: `createStandingAuthorisation`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter         | In     | Required | Type   | Description                                                                            |
| ----------------- | ------ | -------- | ------ | -------------------------------------------------------------------------------------- |
| `Idempotency-Key` | header | yes      | string | Replays of the same key return the first response; reuse with another body is refused. |

**Request body** (required)

Content type `application/json`: [CreateStandingAuthorisation](#createstandingauthorisation).

#### Response 201

The new draft and its ETag.

| Header | Description                                                                |
| ------ | -------------------------------------------------------------------------- |
| `ETag` | Strong validator of this version. Send it in If-Match on PATCH and submit. |

Content type `application/json`: [StandingAuthorisation](#standingauthorisation).

Example: A draft standing authorisation.

```json
{
  "id": "sa_0198f0a0000070008000000000000001",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000a1"],
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  },
  "maxIntrusiveness": "active_safe",
  "preApprovedTestClasses": ["header-audit"],
  "defaultBudgets": {
    "costCapUsd": 5,
    "maxRequests": 1000,
    "maxDurationMs": 3600000
  },
  "testWindows": [
    {
      "cron": "0 2 * * 1-5",
      "timezone": "Europe/Berlin",
      "durationMs": 7200000
    }
  ],
  "validFrom": "2026-11-01T00:00:00.000Z",
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "requesterId": "0198f0a0-0000-7000-8000-0000000000a2",
  "approverId": null,
  "signature": null,
  "signingKeyId": null,
  "status": "draft",
  "revocationReason": null,
  "version": 1,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z"
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, SCOPE_DESTRUCTIVE_FORBIDDEN.

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

Problem details; code is one of AUTHZ_NOT_DRAFT, AUTHZ_ILLEGAL_TRANSITION.

Content type `application/problem+json`: [Problem](#problem).

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of PRECONDITION_FAILED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition failed.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_FAILED",
  "title": "Precondition failed",
  "status": 412,
  "code": "PRECONDITION_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of IDEMPOTENCY_KEY_MISMATCH, VALIDATION_FAILED, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, SCOPE_INVALID_CLASS.

Content type `application/problem+json`: [Problem](#problem).

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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### GET /standing-authorisations/{id}

**Read one standing authorisation**

- Operation ID: `getStandingAuthorisation`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type   | Description                                  |
| --------- | ---- | -------- | ------ | -------------------------------------------- |
| `id`      | path | yes      | string | The standing authorisation public id (sa_…). |

#### Response 200

The standing authorisation and its ETag.

| Header | Description                                                                |
| ------ | -------------------------------------------------------------------------- |
| `ETag` | Strong validator of this version. Send it in If-Match on PATCH and submit. |

Content type `application/json`: [StandingAuthorisation](#standingauthorisation).

Example: A draft standing authorisation.

```json
{
  "id": "sa_0198f0a0000070008000000000000001",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000a1"],
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  },
  "maxIntrusiveness": "active_safe",
  "preApprovedTestClasses": ["header-audit"],
  "defaultBudgets": {
    "costCapUsd": 5,
    "maxRequests": 1000,
    "maxDurationMs": 3600000
  },
  "testWindows": [
    {
      "cron": "0 2 * * 1-5",
      "timezone": "Europe/Berlin",
      "durationMs": 7200000
    }
  ],
  "validFrom": "2026-11-01T00:00:00.000Z",
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "requesterId": "0198f0a0-0000-7000-8000-0000000000a2",
  "approverId": null,
  "signature": null,
  "signingKeyId": null,
  "status": "draft",
  "revocationReason": null,
  "version": 1,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN.

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

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
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

### PATCH /standing-authorisations/{id}

**Change a draft standing authorisation**

Requires If-Match. Only a draft can change (409 otherwise). Unknown keys are refused. An empty body is refused.

- Operation ID: `updateStandingAuthorisation`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type   | Description                                                                                                         |
| ---------- | ------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `id`       | path   | yes      | string | The standing authorisation public id (sa_…).                                                                        |
| `If-Match` | header | yes      | string | The ETag of the version being changed (from the last read or change). A stale value answers 412, a missing one 428. |

**Request body** (required)

Content type `application/json`: [PatchStandingAuthorisation](#patchstandingauthorisation).

#### Response 200

The draft after the change and its new ETag.

| Header | Description                                                                |
| ------ | -------------------------------------------------------------------------- |
| `ETag` | Strong validator of this version. Send it in If-Match on PATCH and submit. |

Content type `application/json`: [StandingAuthorisation](#standingauthorisation).

Example: A draft standing authorisation.

```json
{
  "id": "sa_0198f0a0000070008000000000000001",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000a1"],
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  },
  "maxIntrusiveness": "active_safe",
  "preApprovedTestClasses": ["header-audit"],
  "defaultBudgets": {
    "costCapUsd": 5,
    "maxRequests": 1000,
    "maxDurationMs": 3600000
  },
  "testWindows": [
    {
      "cron": "0 2 * * 1-5",
      "timezone": "Europe/Berlin",
      "durationMs": 7200000
    }
  ],
  "validFrom": "2026-11-01T00:00:00.000Z",
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "requesterId": "0198f0a0-0000-7000-8000-0000000000a2",
  "approverId": null,
  "signature": null,
  "signingKeyId": null,
  "status": "draft",
  "revocationReason": null,
  "version": 1,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, SCOPE_DESTRUCTIVE_FORBIDDEN.

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

Problem details; code is one of AUTHZ_NOT_DRAFT, AUTHZ_ILLEGAL_TRANSITION.

Content type `application/problem+json`: [Problem](#problem).

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of PRECONDITION_FAILED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition failed.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_FAILED",
  "title": "Precondition failed",
  "status": 412,
  "code": "PRECONDITION_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, SCOPE_INVALID_CLASS.

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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### POST /standing-authorisations/{id}/submit

**Submit a draft for approval**

Requires If-Match. Moves the draft to pending_approval. Every asset must be verified for the tenant.

- Operation ID: `submitStandingAuthorisation`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type   | Description                                                                                                         |
| ---------- | ------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `id`       | path   | yes      | string | The standing authorisation public id (sa_…).                                                                        |
| `If-Match` | header | yes      | string | The ETag of the version being changed (from the last read or change). A stale value answers 412, a missing one 428. |

#### Response 200

The standing authorisation in pending_approval and its ETag.

| Header | Description                                                                |
| ------ | -------------------------------------------------------------------------- |
| `ETag` | Strong validator of this version. Send it in If-Match on PATCH and submit. |

Content type `application/json`: [StandingAuthorisation](#standingauthorisation).

Example: A draft standing authorisation.

```json
{
  "id": "sa_0198f0a0000070008000000000000001",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000a1"],
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  },
  "maxIntrusiveness": "active_safe",
  "preApprovedTestClasses": ["header-audit"],
  "defaultBudgets": {
    "costCapUsd": 5,
    "maxRequests": 1000,
    "maxDurationMs": 3600000
  },
  "testWindows": [
    {
      "cron": "0 2 * * 1-5",
      "timezone": "Europe/Berlin",
      "durationMs": 7200000
    }
  ],
  "validFrom": "2026-11-01T00:00:00.000Z",
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "requesterId": "0198f0a0-0000-7000-8000-0000000000a2",
  "approverId": null,
  "signature": null,
  "signingKeyId": null,
  "status": "draft",
  "revocationReason": null,
  "version": 1,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, SCOPE_DESTRUCTIVE_FORBIDDEN.

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

Problem details; code is one of AUTHZ_NOT_DRAFT, AUTHZ_ILLEGAL_TRANSITION.

Content type `application/problem+json`: [Problem](#problem).

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of PRECONDITION_FAILED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition failed.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_FAILED",
  "title": "Precondition failed",
  "status": 412,
  "code": "PRECONDITION_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, SCOPE_INVALID_CLASS.

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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### POST /standing-authorisations/{id}/approve

**Approve and sign a pending standing authorisation**

Requires If-Match. The caller must hold asset_owner and must not be the requester (AUTHZ_SOD_VIOLATION). The session must have authenticated freshly with the step-up acr (AUTHZ_STEPUP_REQUIRED, 401). The approval signs the canonical envelope and moves the SA to active, in one transaction.

- Operation ID: `approveStandingAuthorisation`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type   | Description                                                                                                         |
| ---------- | ------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `id`       | path   | yes      | string | The standing authorisation public id (sa_…).                                                                        |
| `If-Match` | header | yes      | string | The ETag of the version being changed (from the last read or change). A stale value answers 412, a missing one 428. |

#### Response 200

The active, signed standing authorisation and its ETag.

| Header | Description                                                                |
| ------ | -------------------------------------------------------------------------- |
| `ETag` | Strong validator of this version. Send it in If-Match on PATCH and submit. |

Content type `application/json`: [StandingAuthorisation](#standingauthorisation).

Example: A draft standing authorisation.

```json
{
  "id": "sa_0198f0a0000070008000000000000001",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000a1"],
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  },
  "maxIntrusiveness": "active_safe",
  "preApprovedTestClasses": ["header-audit"],
  "defaultBudgets": {
    "costCapUsd": 5,
    "maxRequests": 1000,
    "maxDurationMs": 3600000
  },
  "testWindows": [
    {
      "cron": "0 2 * * 1-5",
      "timezone": "Europe/Berlin",
      "durationMs": 7200000
    }
  ],
  "validFrom": "2026-11-01T00:00:00.000Z",
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "requesterId": "0198f0a0-0000-7000-8000-0000000000a2",
  "approverId": null,
  "signature": null,
  "signingKeyId": null,
  "status": "draft",
  "revocationReason": null,
  "version": 1,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of AUTHZ_STEPUP_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 403

Problem details; code is one of FORBIDDEN, AUTHZ_SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Problem details; code is one of AUTHZ_ILLEGAL_TRANSITION.

Content type `application/problem+json`: [Problem](#problem).

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of PRECONDITION_FAILED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition failed.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_FAILED",
  "title": "Precondition failed",
  "status": 412,
  "code": "PRECONDITION_FAILED",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

#### Response 503

Problem details; code is one of AUTHZ_SIGNER_UNAVAILABLE.

Content type `application/problem+json`: [Problem](#problem).

Example: Authorisation signer unavailable.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SIGNER_UNAVAILABLE",
  "title": "Authorisation signer unavailable",
  "status": 503,
  "code": "AUTHZ_SIGNER_UNAVAILABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

### POST /standing-authorisations/{id}/reject

**Reject a pending standing authorisation**

Requires If-Match and a reason. The SA returns to draft for its requester; the reason is recorded with the gate decision.

- Operation ID: `rejectStandingAuthorisation`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type   | Description                                                                                                         |
| ---------- | ------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `id`       | path   | yes      | string | The standing authorisation public id (sa_…).                                                                        |
| `If-Match` | header | yes      | string | The ETag of the version being changed (from the last read or change). A stale value answers 412, a missing one 428. |

**Request body** (required)

Content type `application/json`: [RejectStandingAuthorisation](#rejectstandingauthorisation).

#### Response 200

The draft standing authorisation and its ETag.

| Header | Description                                                                |
| ------ | -------------------------------------------------------------------------- |
| `ETag` | Strong validator of this version. Send it in If-Match on PATCH and submit. |

Content type `application/json`: [StandingAuthorisation](#standingauthorisation).

Example: A draft standing authorisation.

```json
{
  "id": "sa_0198f0a0000070008000000000000001",
  "assetIds": ["0198f0a0-0000-7000-8000-0000000000a1"],
  "scopeRules": {
    "rules": [
      {
        "effect": "include",
        "host": "app.example.test"
      }
    ]
  },
  "maxIntrusiveness": "active_safe",
  "preApprovedTestClasses": ["header-audit"],
  "defaultBudgets": {
    "costCapUsd": 5,
    "maxRequests": 1000,
    "maxDurationMs": 3600000
  },
  "testWindows": [
    {
      "cron": "0 2 * * 1-5",
      "timezone": "Europe/Berlin",
      "durationMs": 7200000
    }
  ],
  "validFrom": "2026-11-01T00:00:00.000Z",
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "requesterId": "0198f0a0-0000-7000-8000-0000000000a2",
  "approverId": null,
  "signature": null,
  "signingKeyId": null,
  "status": "draft",
  "revocationReason": null,
  "version": 1,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN, AUTHZ_SOD_VIOLATION.

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

Example: Separation of duties violated for the standing authorisation.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SOD_VIOLATION",
  "title": "Separation of duties violated for the standing authorisation",
  "status": 403,
  "code": "AUTHZ_SOD_VIOLATION",
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

Problem details; code is one of AUTHZ_ILLEGAL_TRANSITION.

Content type `application/problem+json`: [Problem](#problem).

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of PRECONDITION_FAILED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition failed.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_FAILED",
  "title": "Precondition failed",
  "status": 412,
  "code": "PRECONDITION_FAILED",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

#### Response 503

Problem details; code is one of AUTHZ_SIGNER_UNAVAILABLE.

Content type `application/problem+json`: [Problem](#problem).

Example: Authorisation signer unavailable.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_SIGNER_UNAVAILABLE",
  "title": "Authorisation signer unavailable",
  "status": 503,
  "code": "AUTHZ_SIGNER_UNAVAILABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

## test-plans

Editable test plans: numbered versions per run, and the cases inside a draft version. An approved version is immutable.

### GET /runs/{runId}/test-plans

**List the versions of a run plan**

- Operation ID: `listTestPlanVersions`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In    | Required | Type          | Description |
| --------- | ----- | -------- | ------------- | ----------- |
| `runId`   | path  | yes      | string (uuid) |             |
| `cursor`  | query | no       | string        |             |
| `limit`   | query | no       | integer       |             |

#### Response 200

A page of versions, oldest first.

Content type `application/json`: [TestPlanPage](#testplanpage).

Example: The first page, with a cursor for the next.

```json
{
  "items": [
    {
      "planId": "0198f0a0-0000-7000-8000-0000000000d1",
      "runId": "0198f0a0-0000-7000-8000-0000000000e1",
      "version": 1,
      "status": "approved",
      "createdAt": "2026-10-01T09:00:00.000Z",
      "updatedAt": "2026-10-01T09:30:00.000Z"
    }
  ],
  "nextCursor": "djoxDQ"
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN.

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

#### Response 404

Problem details; code is one of PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of PLAN_VERSION_IMMUTABLE.

Content type `application/problem+json`: [Problem](#problem).

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of ETAG_MISMATCH.

Content type `application/problem+json`: [Problem](#problem).

Example: ETag mismatch.

```json
{
  "type": "https://errors.blackwing.dev/ETAG_MISMATCH",
  "title": "ETag mismatch",
  "status": 412,
  "code": "ETAG_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 413

Problem details; code is one of PLAN_PAYLOAD_TOO_LARGE.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan payload too large.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_PAYLOAD_TOO_LARGE",
  "title": "Test plan payload too large",
  "status": 413,
  "code": "PLAN_PAYLOAD_TOO_LARGE",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### POST /runs/{runId}/test-plans

**Create the next version of a run plan**

Copies the non-removed cases of the newest version into a new draft. Requires Idempotency-Key: a retry returns the original version.

- Operation ID: `createTestPlanVersion`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter         | In     | Required | Type          | Description                                                                   |
| ----------------- | ------ | -------- | ------------- | ----------------------------------------------------------------------------- |
| `runId`           | path   | yes      | string (uuid) |                                                                               |
| `Idempotency-Key` | header | yes      | string        | Makes a retry return the original result instead of a second write (API-008). |

#### Response 201

The new version.

| Header | Description                                                            |
| ------ | ---------------------------------------------------------------------- |
| `ETag` | Strong validator of this state. Send it back in If-Match to change it. |

Content type `application/json`: [TestPlanView](#testplanview).

Example: A draft version with one case.

```json
{
  "planId": "0198f0a0-0000-7000-8000-0000000000d1",
  "runId": "0198f0a0-0000-7000-8000-0000000000e1",
  "version": 2,
  "status": "draft",
  "createdAt": "2026-10-01T10:00:00.000Z",
  "updatedAt": "2026-10-01T10:00:00.000Z",
  "cases": [
    {
      "caseId": "0198f0a0-0000-7000-8000-0000000000c1",
      "planId": "0198f0a0-0000-7000-8000-0000000000d1",
      "class": "passive",
      "title": "Login rate limit is enforced",
      "status": "proposed",
      "statusReason": null,
      "refs": {
        "owasp": ["A07"],
        "wstg": ["WSTG-ATHN-03"],
        "asvs": ["2.2.1"]
      },
      "cweCandidates": ["CWE-307"],
      "targets": ["https://app.example.test/login"],
      "roles": ["anonymous"],
      "budget": {
        "maxRequests": 50,
        "maxRps": 2,
        "maxConcurrency": 1,
        "maxBytes": 1048576
      },
      "oracle": {
        "type": "status_code",
        "params": {
          "expected": 429
        }
      },
      "negativeControl": null,
      "createdAt": "2026-10-01T10:00:00.000Z",
      "updatedAt": "2026-10-01T10:00:00.000Z"
    }
  ]
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN.

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

#### Response 404

Problem details; code is one of PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of PLAN_VERSION_IMMUTABLE.

Content type `application/problem+json`: [Problem](#problem).

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of ETAG_MISMATCH.

Content type `application/problem+json`: [Problem](#problem).

Example: ETag mismatch.

```json
{
  "type": "https://errors.blackwing.dev/ETAG_MISMATCH",
  "title": "ETag mismatch",
  "status": 412,
  "code": "ETAG_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 413

Problem details; code is one of PLAN_PAYLOAD_TOO_LARGE.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan payload too large.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_PAYLOAD_TOO_LARGE",
  "title": "Test plan payload too large",
  "status": 413,
  "code": "PLAN_PAYLOAD_TOO_LARGE",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### GET /runs/{runId}/test-plans/{version}

**Read one plan version with its cases**

- Operation ID: `getTestPlanVersion`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type          | Description |
| --------- | ---- | -------- | ------------- | ----------- |
| `runId`   | path | yes      | string (uuid) |             |
| `version` | path | yes      | integer       |             |

#### Response 200

The version and its cases.

| Header | Description                                                            |
| ------ | ---------------------------------------------------------------------- |
| `ETag` | Strong validator of this state. Send it back in If-Match to change it. |

Content type `application/json`: [TestPlanView](#testplanview).

Example: A draft version with one case.

```json
{
  "planId": "0198f0a0-0000-7000-8000-0000000000d1",
  "runId": "0198f0a0-0000-7000-8000-0000000000e1",
  "version": 2,
  "status": "draft",
  "createdAt": "2026-10-01T10:00:00.000Z",
  "updatedAt": "2026-10-01T10:00:00.000Z",
  "cases": [
    {
      "caseId": "0198f0a0-0000-7000-8000-0000000000c1",
      "planId": "0198f0a0-0000-7000-8000-0000000000d1",
      "class": "passive",
      "title": "Login rate limit is enforced",
      "status": "proposed",
      "statusReason": null,
      "refs": {
        "owasp": ["A07"],
        "wstg": ["WSTG-ATHN-03"],
        "asvs": ["2.2.1"]
      },
      "cweCandidates": ["CWE-307"],
      "targets": ["https://app.example.test/login"],
      "roles": ["anonymous"],
      "budget": {
        "maxRequests": 50,
        "maxRps": 2,
        "maxConcurrency": 1,
        "maxBytes": 1048576
      },
      "oracle": {
        "type": "status_code",
        "params": {
          "expected": 429
        }
      },
      "negativeControl": null,
      "createdAt": "2026-10-01T10:00:00.000Z",
      "updatedAt": "2026-10-01T10:00:00.000Z"
    }
  ]
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN.

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

#### Response 404

Problem details; code is one of PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of PLAN_VERSION_IMMUTABLE.

Content type `application/problem+json`: [Problem](#problem).

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of ETAG_MISMATCH.

Content type `application/problem+json`: [Problem](#problem).

Example: ETag mismatch.

```json
{
  "type": "https://errors.blackwing.dev/ETAG_MISMATCH",
  "title": "ETag mismatch",
  "status": 412,
  "code": "ETAG_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 413

Problem details; code is one of PLAN_PAYLOAD_TOO_LARGE.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan payload too large.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_PAYLOAD_TOO_LARGE",
  "title": "Test plan payload too large",
  "status": 413,
  "code": "PLAN_PAYLOAD_TOO_LARGE",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### POST /test-plans/{planId}/cases

**Add a test case to a draft plan version**

Requires If-Match (the plan ETag) and Idempotency-Key. An approved or superseded version answers 409 PLAN_VERSION_IMMUTABLE.

- Operation ID: `addTestCase`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter         | In     | Required | Type          | Description                                                                              |
| ----------------- | ------ | -------- | ------------- | ---------------------------------------------------------------------------------------- |
| `planId`          | path   | yes      | string (uuid) |                                                                                          |
| `If-Match`        | header | yes      | string        | The ETag from the last read. A stale value answers 412 ETAG_MISMATCH, a missing one 428. |
| `Idempotency-Key` | header | yes      | string        | Makes a retry return the original result instead of a second write (API-008).            |

**Request body** (required)

Content type `application/json`: [TestCaseCreate](#testcasecreate).

Example: A passive check.

```json
{
  "caseId": "0198f0a0-0000-7000-8000-0000000000c1",
  "planId": "0198f0a0-0000-7000-8000-0000000000d1",
  "class": "passive",
  "title": "Login rate limit is enforced",
  "status": "proposed",
  "statusReason": null,
  "refs": {
    "owasp": ["A07"],
    "wstg": ["WSTG-ATHN-03"],
    "asvs": ["2.2.1"]
  },
  "cweCandidates": ["CWE-307"],
  "targets": ["https://app.example.test/login"],
  "roles": ["anonymous"],
  "budget": {
    "maxRequests": 50,
    "maxRps": 2,
    "maxConcurrency": 1,
    "maxBytes": 1048576
  },
  "oracle": {
    "type": "status_code",
    "params": {
      "expected": 429
    }
  },
  "negativeControl": null,
  "createdAt": "2026-10-01T10:00:00.000Z",
  "updatedAt": "2026-10-01T10:00:00.000Z"
}
```

#### Response 201

The new case and its ETag.

| Header | Description                                                            |
| ------ | ---------------------------------------------------------------------- |
| `ETag` | Strong validator of this state. Send it back in If-Match to change it. |

Content type `application/json`: [TestCaseView](#testcaseview).

Example: A proposed case.

```json
{
  "caseId": "0198f0a0-0000-7000-8000-0000000000c1",
  "planId": "0198f0a0-0000-7000-8000-0000000000d1",
  "class": "passive",
  "title": "Login rate limit is enforced",
  "status": "proposed",
  "statusReason": null,
  "refs": {
    "owasp": ["A07"],
    "wstg": ["WSTG-ATHN-03"],
    "asvs": ["2.2.1"]
  },
  "cweCandidates": ["CWE-307"],
  "targets": ["https://app.example.test/login"],
  "roles": ["anonymous"],
  "budget": {
    "maxRequests": 50,
    "maxRps": 2,
    "maxConcurrency": 1,
    "maxBytes": 1048576
  },
  "oracle": {
    "type": "status_code",
    "params": {
      "expected": 429
    }
  },
  "negativeControl": null,
  "createdAt": "2026-10-01T10:00:00.000Z",
  "updatedAt": "2026-10-01T10:00:00.000Z"
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN.

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

#### Response 404

Problem details; code is one of PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of PLAN_VERSION_IMMUTABLE.

Content type `application/problem+json`: [Problem](#problem).

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of ETAG_MISMATCH.

Content type `application/problem+json`: [Problem](#problem).

Example: ETag mismatch.

```json
{
  "type": "https://errors.blackwing.dev/ETAG_MISMATCH",
  "title": "ETag mismatch",
  "status": 412,
  "code": "ETAG_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 413

Problem details; code is one of PLAN_PAYLOAD_TOO_LARGE.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan payload too large.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_PAYLOAD_TOO_LARGE",
  "title": "Test plan payload too large",
  "status": 413,
  "code": "PLAN_PAYLOAD_TOO_LARGE",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### GET /test-plans/{planId}/validation

**Validate a plan version against its standing authorisation**

Checks every case against the run standing authorisation (class ceiling, pre-approved classes, scope, roles, oracle, negative control and budgets), the Cedar plan policy and the run budget. ok is true only when violations is empty. Writes one test_plan.validated audit event.

- Operation ID: `validateTestPlan`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type          | Description |
| --------- | ---- | -------- | ------------- | ----------- |
| `planId`  | path | yes      | string (uuid) |             |

#### Response 200

The validation result, with every violation.

Content type `application/json`: [PlanValidationResult](#planvalidationresult).

Example: A valid plan.

```json
{
  "planId": "0196f5c2-7a1e-7c3a-9b1d-2f4e6a8b0c11",
  "runId": "0196f5c2-7a1e-7c3a-9b1d-2f4e6a8b0c10",
  "version": 1,
  "saId": "0196f5c2-7a1e-7c3a-9b1d-2f4e6a8b0c20",
  "ok": true,
  "gate1Required": true,
  "violations": [],
  "budgetTotals": {
    "totalRequests": 50,
    "totalBytes": 1000000,
    "perClassCounts": {
      "passive": 0,
      "active_safe": 1,
      "state_changing": 0,
      "destructive": 0
    }
  },
  "validatedAt": "2026-10-30T00:00:00.000Z"
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN.

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

#### Response 404

Problem details; code is one of PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of PLAN_VERSION_IMMUTABLE.

Content type `application/problem+json`: [Problem](#problem).

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of ETAG_MISMATCH.

Content type `application/problem+json`: [Problem](#problem).

Example: ETag mismatch.

```json
{
  "type": "https://errors.blackwing.dev/ETAG_MISMATCH",
  "title": "ETag mismatch",
  "status": 412,
  "code": "ETAG_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 413

Problem details; code is one of PLAN_PAYLOAD_TOO_LARGE.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan payload too large.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_PAYLOAD_TOO_LARGE",
  "title": "Test plan payload too large",
  "status": 413,
  "code": "PLAN_PAYLOAD_TOO_LARGE",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### DELETE /test-cases/{caseId}

**Remove a test case from a draft plan version**

Soft-removes the case (status removed). Removing an already removed case answers 200 and writes nothing. Otherwise requires If-Match.

- Operation ID: `removeTestCase`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type          | Description                                                                              |
| ---------- | ------ | -------- | ------------- | ---------------------------------------------------------------------------------------- |
| `caseId`   | path   | yes      | string (uuid) |                                                                                          |
| `If-Match` | header | no       | string        | The ETag from the last read. A stale value answers 412 ETAG_MISMATCH, a missing one 428. |

#### Response 200

The removed case.

| Header | Description                                                            |
| ------ | ---------------------------------------------------------------------- |
| `ETag` | Strong validator of this state. Send it back in If-Match to change it. |

Content type `application/json`: [TestCaseView](#testcaseview).

Example: A proposed case.

```json
{
  "caseId": "0198f0a0-0000-7000-8000-0000000000c1",
  "planId": "0198f0a0-0000-7000-8000-0000000000d1",
  "class": "passive",
  "title": "Login rate limit is enforced",
  "status": "proposed",
  "statusReason": null,
  "refs": {
    "owasp": ["A07"],
    "wstg": ["WSTG-ATHN-03"],
    "asvs": ["2.2.1"]
  },
  "cweCandidates": ["CWE-307"],
  "targets": ["https://app.example.test/login"],
  "roles": ["anonymous"],
  "budget": {
    "maxRequests": 50,
    "maxRps": 2,
    "maxConcurrency": 1,
    "maxBytes": 1048576
  },
  "oracle": {
    "type": "status_code",
    "params": {
      "expected": 429
    }
  },
  "negativeControl": null,
  "createdAt": "2026-10-01T10:00:00.000Z",
  "updatedAt": "2026-10-01T10:00:00.000Z"
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN.

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

#### Response 404

Problem details; code is one of PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of PLAN_VERSION_IMMUTABLE.

Content type `application/problem+json`: [Problem](#problem).

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of ETAG_MISMATCH.

Content type `application/problem+json`: [Problem](#problem).

Example: ETag mismatch.

```json
{
  "type": "https://errors.blackwing.dev/ETAG_MISMATCH",
  "title": "ETag mismatch",
  "status": 412,
  "code": "ETAG_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 413

Problem details; code is one of PLAN_PAYLOAD_TOO_LARGE.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan payload too large.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_PAYLOAD_TOO_LARGE",
  "title": "Test plan payload too large",
  "status": 413,
  "code": "PLAN_PAYLOAD_TOO_LARGE",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### PATCH /test-cases/{caseId}

**Edit a test case of a draft plan version**

Requires If-Match (the case ETag). Only the sent fields change.

- Operation ID: `updateTestCase`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type          | Description                                                                              |
| ---------- | ------ | -------- | ------------- | ---------------------------------------------------------------------------------------- |
| `caseId`   | path   | yes      | string (uuid) |                                                                                          |
| `If-Match` | header | yes      | string        | The ETag from the last read. A stale value answers 412 ETAG_MISMATCH, a missing one 428. |

**Request body** (required)

Content type `application/json`: [TestCasePatch](#testcasepatch).

Example: Retitle.

```json
{
  "title": "Login rate limit is enforced"
}
```

#### Response 200

The case after the change.

| Header | Description                                                            |
| ------ | ---------------------------------------------------------------------- |
| `ETag` | Strong validator of this state. Send it back in If-Match to change it. |

Content type `application/json`: [TestCaseView](#testcaseview).

Example: A proposed case.

```json
{
  "caseId": "0198f0a0-0000-7000-8000-0000000000c1",
  "planId": "0198f0a0-0000-7000-8000-0000000000d1",
  "class": "passive",
  "title": "Login rate limit is enforced",
  "status": "proposed",
  "statusReason": null,
  "refs": {
    "owasp": ["A07"],
    "wstg": ["WSTG-ATHN-03"],
    "asvs": ["2.2.1"]
  },
  "cweCandidates": ["CWE-307"],
  "targets": ["https://app.example.test/login"],
  "roles": ["anonymous"],
  "budget": {
    "maxRequests": 50,
    "maxRps": 2,
    "maxConcurrency": 1,
    "maxBytes": 1048576
  },
  "oracle": {
    "type": "status_code",
    "params": {
      "expected": 429
    }
  },
  "negativeControl": null,
  "createdAt": "2026-10-01T10:00:00.000Z",
  "updatedAt": "2026-10-01T10:00:00.000Z"
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

Problem details; code is one of UNAUTHENTICATED, AUTH_NO_CREDENTIALS, AUTH_INVALID_TOKEN, AUTH_EXPIRED, AUTHZ_STEPUP_REQUIRED, SBX_UNAUTHENTICATED, SERVICE_AUTH_FAILED.

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

Example: Step up authentication required.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_STEPUP_REQUIRED",
  "title": "Step up authentication required",
  "status": 401,
  "code": "AUTHZ_STEPUP_REQUIRED",
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

Problem details; code is one of FORBIDDEN.

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

#### Response 404

Problem details; code is one of PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of PLAN_VERSION_IMMUTABLE.

Content type `application/problem+json`: [Problem](#problem).

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 412

Problem details; code is one of ETAG_MISMATCH.

Content type `application/problem+json`: [Problem](#problem).

Example: ETag mismatch.

```json
{
  "type": "https://errors.blackwing.dev/ETAG_MISMATCH",
  "title": "ETag mismatch",
  "status": 412,
  "code": "ETAG_MISMATCH",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 413

Problem details; code is one of PLAN_PAYLOAD_TOO_LARGE.

Content type `application/problem+json`: [Problem](#problem).

Example: Test plan payload too large.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_PAYLOAD_TOO_LARGE",
  "title": "Test plan payload too large",
  "status": 413,
  "code": "PLAN_PAYLOAD_TOO_LARGE",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

## findings

Findings: list and detail, tenant-scoped and read-only. Suspected findings are visible to analysts only (F17).

### GET /findings

**List the findings of the tenant, newest first**

Needs finding:read. Filters combine with AND. An unknown filter, a CWE or OWASP id outside the pinned lists, or a malformed limit is 400. Suspected findings are excluded unless the caller is an analyst. The page size is clamped to 200.

- Operation ID: `listFindings`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter        | In    | Required | Type                                                        | Description |
| ---------------- | ----- | -------- | ----------------------------------------------------------- | ----------- |
| `assetId`        | query | no       | string (uuid)                                               |             |
| `status`         | query | no       | string                                                      |             |
| `severity`       | query | no       | enum: `"none"`, `"low"`, `"medium"`, `"high"`, `"critical"` |             |
| `cwe`            | query | no       | string                                                      |             |
| `owasp`          | query | no       | string                                                      |             |
| `baselineStatus` | query | no       | string                                                      |             |
| `cursor`         | query | no       | string                                                      |             |
| `limit`          | query | no       | integer                                                     |             |

#### Response 200

A page of findings.

Content type `application/json`: [FindingList](#findinglist).

Example: One finding.

```json
{
  "items": [
    {
      "id": "fnd_01m64cavacexhrddgjb6xd80xv",
      "title": "Missing authorisation on /admin",
      "class": "broken_access_control",
      "status": "confirmed",
      "baselineStatus": "new",
      "severity": null,
      "cweId": "CWE-285",
      "owaspCategory": "A01",
      "unmapped": false,
      "confidence": 0.9,
      "assetId": "0198f0a0-0000-7000-8000-0000000000e1",
      "location": {
        "method": "GET",
        "urlTemplate": "/admin",
        "parameter": null,
        "file": null,
        "line": null
      },
      "firstSeenRunId": "0198f0a0-0000-7000-8000-0000000000c1",
      "lastSeenRunId": "0198f0a0-0000-7000-8000-0000000000c1",
      "stateVersion": 1,
      "createdAt": "2026-10-29T10:00:00.000Z",
      "updatedAt": "2026-10-29T10:05:00.000Z"
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

#### Response 400

A malformed cursor (invalid_cursor), limit (bad_request) or filter (invalid_filter).

Content type `application/problem+json`: [Problem](#problem).

#### Response 401

No valid credential.

Content type `application/problem+json`: [Problem](#problem).

#### Response 403

The caller has no finding:read permission in this tenant.

Content type `application/problem+json`: [Problem](#problem).

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
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

### GET /findings/{id}

**Get one finding with its occurrences, mapping and evidence refs**

Needs finding:read. Occurrences and evidence refs are each capped at 50 and carry total and truncated. Evidence is referenced by its chain head and resolved by the evidence API. A finding the caller may not see is 404.

- Operation ID: `getFinding`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type   | Description                           |
| --------- | ---- | -------- | ------ | ------------------------------------- |
| `id`      | path | yes      | string | The `fnd_…` public id of the finding. |

#### Response 200

The finding detail.

Content type `application/json`: [Finding](#finding).

Example: A confirmed finding with one occurrence.

```json
{
  "id": "fnd_01m64cavacexhrddgjb6xd80xv",
  "title": "Missing authorisation on /admin",
  "class": "broken_access_control",
  "status": "confirmed",
  "baselineStatus": "new",
  "severity": null,
  "cweId": "CWE-285",
  "owaspCategory": "A01",
  "unmapped": false,
  "confidence": 0.9,
  "assetId": "0198f0a0-0000-7000-8000-0000000000e1",
  "location": {
    "method": "GET",
    "urlTemplate": "/admin",
    "parameter": null,
    "file": null,
    "line": null
  },
  "firstSeenRunId": "0198f0a0-0000-7000-8000-0000000000c1",
  "lastSeenRunId": "0198f0a0-0000-7000-8000-0000000000c1",
  "stateVersion": 1,
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:05:00.000Z",
  "mappingVersion": "1.0.0",
  "classification": {
    "cweCandidates": ["CWE-285"],
    "apiTop10": "API1",
    "wstg": ["WSTG-ATHZ-02"]
  },
  "acceptedRisk": null,
  "releasedBy": null,
  "releasedAt": null,
  "occurrences": {
    "items": [
      {
        "id": "0198f0a0-0000-7000-8000-0000000000c2",
        "runId": "0198f0a0-0000-7000-8000-0000000000c1",
        "occurrenceStatus": "observed",
        "evidenceChainHead": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "detectedAt": "2026-10-29T10:00:00.000Z"
      }
    ],
    "total": 1,
    "truncated": false
  },
  "evidence": {
    "items": [
      {
        "evidenceId": "0198f0a0-0000-7000-8000-0000000000c3",
        "objectKey": "evidence/run-c1/request-0001.bin",
        "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "chain": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "occurrenceId": "0198f0a0-0000-7000-8000-0000000000c2",
        "runId": "0198f0a0-0000-7000-8000-0000000000c1"
      }
    ],
    "total": 1,
    "truncated": false
  }
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

No valid credential.

Content type `application/problem+json`: [Problem](#problem).

#### Response 403

The caller has no finding:read permission in this tenant.

Content type `application/problem+json`: [Problem](#problem).

#### Response 404

Unknown, foreign or hidden finding.

Content type `application/problem+json`: [Problem](#problem).

#### Response 409

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
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

## oncall

Gate 2 on-call rosters: who is paged for a runtime exception, and in what order.

### GET /oncall/rosters

**List the tenant on-call rosters**

Requires settings:read (Org Admin).

- Operation ID: `listOncallRosters`
- Authentication: `bearerAuth` or `sessionCookie`

#### Response 200

The tenant rosters, oldest first.

Content type `application/json`: object.

Example: one.

```json
{
  "items": [
    {
      "id": "01890a5d-ac96-774b-bcce-b302099a8057",
      "tenantId": "01890a5d-ac96-774b-bcce-b302099a8058",
      "name": "Primary rotation",
      "timezone": "Europe/Berlin",
      "active": true,
      "stateVersion": 0,
      "members": [
        {
          "id": "01890a5d-ac96-774b-bcce-b302099a8057",
          "userId": "01890a5d-ac96-774b-bcce-b302099a8059",
          "level": 0,
          "orderIndex": 0,
          "channelRefs": ["01890a5d-ac96-774b-bcce-b302099a805b"]
        },
        {
          "id": "01890a5d-ac96-774b-bcce-b302099a8058",
          "userId": "01890a5d-ac96-774b-bcce-b302099a805a",
          "level": 2,
          "orderIndex": 0,
          "channelRefs": ["01890a5d-ac96-774b-bcce-b302099a805b"]
        }
      ],
      "schedules": [
        {
          "id": "01890a5d-ac96-774b-bcce-b302099a8059",
          "userId": "01890a5d-ac96-774b-bcce-b302099a8059",
          "startsAt": "2026-10-19T07:00:00.000Z",
          "endsAt": "2026-10-26T07:00:00.000Z"
        }
      ],
      "createdAt": "2026-10-20T10:00:00.000Z",
      "updatedAt": "2026-10-20T10:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of FORBIDDEN.

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

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
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

### POST /oncall/rosters

**Create an on-call roster**

Requires settings:write (Org Admin). A tenant has at most one active roster. Schedule boundaries without a Z or offset are read in the roster timezone. Audited as oncall.roster.updated.

- Operation ID: `createOncallRoster`
- Authentication: `bearerAuth` or `sessionCookie`

**Request body** (required)

Content type `application/json`: [OncallRosterCreate](#oncallrostercreate).

Example: Primary on a weekly rotation, manager as the last resort.

```json
{
  "name": "Primary rotation",
  "timezone": "Europe/Berlin",
  "members": [
    {
      "userId": "01890a5d-ac96-774b-bcce-b302099a8059",
      "level": 0,
      "orderIndex": 0,
      "channelRefs": ["01890a5d-ac96-774b-bcce-b302099a805b"]
    },
    {
      "userId": "01890a5d-ac96-774b-bcce-b302099a805a",
      "level": 2,
      "orderIndex": 0,
      "channelRefs": ["01890a5d-ac96-774b-bcce-b302099a805b"]
    }
  ],
  "schedules": [
    {
      "userId": "01890a5d-ac96-774b-bcce-b302099a8059",
      "startsAt": "2026-10-19T09:00",
      "endsAt": "2026-10-26T09:00"
    }
  ]
}
```

#### Response 201

The roster, with its ETag and Location.

| Header     | Description                                      |
| ---------- | ------------------------------------------------ |
| `ETag`     | Version of the roster, to send back in If-Match. |
| `Location` |                                                  |

Content type `application/json`: [OncallRoster](#oncallroster).

Example: created.

```json
{
  "id": "01890a5d-ac96-774b-bcce-b302099a8057",
  "tenantId": "01890a5d-ac96-774b-bcce-b302099a8058",
  "name": "Primary rotation",
  "timezone": "Europe/Berlin",
  "active": true,
  "stateVersion": 0,
  "members": [
    {
      "id": "01890a5d-ac96-774b-bcce-b302099a8057",
      "userId": "01890a5d-ac96-774b-bcce-b302099a8059",
      "level": 0,
      "orderIndex": 0,
      "channelRefs": ["01890a5d-ac96-774b-bcce-b302099a805b"]
    },
    {
      "id": "01890a5d-ac96-774b-bcce-b302099a8058",
      "userId": "01890a5d-ac96-774b-bcce-b302099a805a",
      "level": 2,
      "orderIndex": 0,
      "channelRefs": ["01890a5d-ac96-774b-bcce-b302099a805b"]
    }
  ],
  "schedules": [
    {
      "id": "01890a5d-ac96-774b-bcce-b302099a8059",
      "userId": "01890a5d-ac96-774b-bcce-b302099a8059",
      "startsAt": "2026-10-19T07:00:00.000Z",
      "endsAt": "2026-10-26T07:00:00.000Z"
    }
  ],
  "createdAt": "2026-10-20T10:00:00.000Z",
  "updatedAt": "2026-10-20T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of FORBIDDEN.

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

#### Response 404

Problem details; code is one of NOT_FOUND, PERSONA_NOT_DEFINED, PROMPT_NO_RELEASED_VERSION, RUN_NOT_FOUND, SECRET_NOT_FOUND, KEYCLOAK_NOT_FOUND, PLAN_NOT_FOUND, TEST_CASE_NOT_FOUND.

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

Example: Run not found.

```json
{
  "type": "https://errors.blackwing.dev/RUN_NOT_FOUND",
  "title": "Run not found",
  "status": 404,
  "code": "RUN_NOT_FOUND",
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

Example: Test plan not found.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_NOT_FOUND",
  "title": "Test plan not found",
  "status": 404,
  "code": "PLAN_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test case not found.

```json
{
  "type": "https://errors.blackwing.dev/TEST_CASE_NOT_FOUND",
  "title": "Test case not found",
  "status": 404,
  "code": "TEST_CASE_NOT_FOUND",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 409

Problem details; code is one of CONFLICT.

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

### GET /oncall/rosters/{id}

**An on-call roster with its members and schedule**

Requires settings:read (Org Admin).

- Operation ID: `getOncallRoster`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter | In   | Required | Type          | Description |
| --------- | ---- | -------- | ------------- | ----------- |
| `id`      | path | yes      | string (uuid) |             |

#### Response 200

The roster and its ETag.

| Header | Description                                      |
| ------ | ------------------------------------------------ |
| `ETag` | Version of the roster, to send back in If-Match. |

Content type `application/json`: [OncallRoster](#oncallroster).

Example: roster.

```json
{
  "id": "01890a5d-ac96-774b-bcce-b302099a8057",
  "tenantId": "01890a5d-ac96-774b-bcce-b302099a8058",
  "name": "Primary rotation",
  "timezone": "Europe/Berlin",
  "active": true,
  "stateVersion": 0,
  "members": [
    {
      "id": "01890a5d-ac96-774b-bcce-b302099a8057",
      "userId": "01890a5d-ac96-774b-bcce-b302099a8059",
      "level": 0,
      "orderIndex": 0,
      "channelRefs": ["01890a5d-ac96-774b-bcce-b302099a805b"]
    },
    {
      "id": "01890a5d-ac96-774b-bcce-b302099a8058",
      "userId": "01890a5d-ac96-774b-bcce-b302099a805a",
      "level": 2,
      "orderIndex": 0,
      "channelRefs": ["01890a5d-ac96-774b-bcce-b302099a805b"]
    }
  ],
  "schedules": [
    {
      "id": "01890a5d-ac96-774b-bcce-b302099a8059",
      "userId": "01890a5d-ac96-774b-bcce-b302099a8059",
      "startsAt": "2026-10-19T07:00:00.000Z",
      "endsAt": "2026-10-26T07:00:00.000Z"
    }
  ],
  "createdAt": "2026-10-20T10:00:00.000Z",
  "updatedAt": "2026-10-20T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of FORBIDDEN.

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

Problem details; code is one of CONFLICT, ILLEGAL_RUN_TRANSITION, GATE1_NOT_PENDING, GATE1_PLAN_STALE, GATE1_EXPIRED, AUTHZ_ILLEGAL_TRANSITION, AUTHZ_NOT_DRAFT, KEK_DISABLED, DB_SERIALIZATION_CONFLICT, KILL_ALREADY_IN_PROGRESS, GATE2_NO_ELIGIBLE_APPROVER, RUN_NOT_ACTIVE, SECRET_DISABLED, ASSET_STALE_WRITE, ASSET_IN_USE, KEYCLOAK_CONFLICT, PLAN_VERSION_IMMUTABLE.

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

Example: Approval gate is no longer pending.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_NOT_PENDING",
  "title": "Approval gate is no longer pending",
  "status": 409,
  "code": "GATE1_NOT_PENDING",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Test plan changed since it was loaded.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_PLAN_STALE",
  "title": "Test plan changed since it was loaded",
  "status": 409,
  "code": "GATE1_PLAN_STALE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Approval window expired.

```json
{
  "type": "https://errors.blackwing.dev/GATE1_EXPIRED",
  "title": "Approval window expired",
  "status": 409,
  "code": "GATE1_EXPIRED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Illegal standing authorisation transition.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ILLEGAL_TRANSITION",
  "title": "Illegal standing authorisation transition",
  "status": 409,
  "code": "AUTHZ_ILLEGAL_TRANSITION",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Standing authorisation is not a draft.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_NOT_DRAFT",
  "title": "Standing authorisation is not a draft",
  "status": 409,
  "code": "AUTHZ_NOT_DRAFT",
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

Example: No eligible approver.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ELIGIBLE_APPROVER",
  "title": "No eligible approver",
  "status": 409,
  "code": "GATE2_NO_ELIGIBLE_APPROVER",
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

Example: Stale asset write.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_STALE_WRITE",
  "title": "Stale asset write",
  "status": 409,
  "code": "ASSET_STALE_WRITE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset in use.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_IN_USE",
  "title": "Asset in use",
  "status": 409,
  "code": "ASSET_IN_USE",
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

Example: Approved test plan version is immutable.

```json
{
  "type": "https://errors.blackwing.dev/PLAN_VERSION_IMMUTABLE",
  "title": "Approved test plan version is immutable",
  "status": 409,
  "code": "PLAN_VERSION_IMMUTABLE",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

#### Response 422

Problem details; code is one of VALIDATION_FAILED, EVIDENCE_INTEGRITY_FAILED, SCOPE_INVALID_CLASS, SCOPE_INVALID_BUDGET, SCOPE_INVALID_RULE, AUTHZ_INVALID_WINDOW, AUTHZ_ASSET_UNVERIFIED, PERSONA_UNKNOWN, PERSONA_FORBIDDEN_TOOL, PERSONA_INVALID, ENVELOPE_INVALID, PROMPT_INVALID, PROMPT_PLACEHOLDER_MISSING, INVALID_SECRET_REF, SBX_IMAGE_MISSING, KILL_SCOPE_INVALID, KILL_REF_REQUIRED, IDEMPOTENCY_KEY_MISMATCH, GATE2_NO_ONCALL_CONFIGURED, AUDIT_EVENT_INVALID, ASSET_INVALID_IDENTIFIER, CVSS_VECTOR_SCORE_MISMATCH.

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

Example: Evidence integrity check failed.

```json
{
  "type": "https://errors.blackwing.dev/EVIDENCE_INTEGRITY_FAILED",
  "title": "Evidence integrity check failed",
  "status": 422,
  "code": "EVIDENCE_INTEGRITY_FAILED",
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

Example: Invalid standing authorisation window.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_INVALID_WINDOW",
  "title": "Invalid standing authorisation window",
  "status": 422,
  "code": "AUTHZ_INVALID_WINDOW",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: Asset is not verified for this tenant.

```json
{
  "type": "https://errors.blackwing.dev/AUTHZ_ASSET_UNVERIFIED",
  "title": "Asset is not verified for this tenant",
  "status": 422,
  "code": "AUTHZ_ASSET_UNVERIFIED",
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

Example: No on call configured.

```json
{
  "type": "https://errors.blackwing.dev/GATE2_NO_ONCALL_CONFIGURED",
  "title": "No on call configured",
  "status": 422,
  "code": "GATE2_NO_ONCALL_CONFIGURED",
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

Example: Invalid asset identifier.

```json
{
  "type": "https://errors.blackwing.dev/ASSET_INVALID_IDENTIFIER",
  "title": "Invalid asset identifier",
  "status": 422,
  "code": "ASSET_INVALID_IDENTIFIER",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Example: CVSS score does not match its vector.

```json
{
  "type": "https://errors.blackwing.dev/CVSS_VECTOR_SCORE_MISMATCH",
  "title": "CVSS score does not match its vector",
  "status": 422,
  "code": "CVSS_VECTOR_SCORE_MISMATCH",
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

### PATCH /oncall/rosters/{id}

**Change an on-call roster**

Requires settings:write (Org Admin) and the current ETag in If-Match. A members or schedules list replaces the stored list. Audited as oncall.roster.updated.

- Operation ID: `updateOncallRoster`
- Authentication: `bearerAuth` or `sessionCookie`

| Parameter  | In     | Required | Type          | Description |
| ---------- | ------ | -------- | ------------- | ----------- |
| `id`       | path   | yes      | string (uuid) |             |
| `If-Match` | header | yes      | string        |             |

**Request body** (required)

Content type `application/json`: [OncallRosterPatch](#oncallrosterpatch).

Example: rename.

```json
{
  "name": "Night rotation"
}
```

#### Response 200

The updated roster and its new ETag.

| Header | Description                                      |
| ------ | ------------------------------------------------ |
| `ETag` | Version of the roster, to send back in If-Match. |

Content type `application/json`: [OncallRoster](#oncallroster).

Example: updated.

```json
{
  "id": "01890a5d-ac96-774b-bcce-b302099a8057",
  "tenantId": "01890a5d-ac96-774b-bcce-b302099a8058",
  "name": "Primary rotation",
  "timezone": "Europe/Berlin",
  "active": true,
  "stateVersion": 1,
  "members": [
    {
      "id": "01890a5d-ac96-774b-bcce-b302099a8057",
      "userId": "01890a5d-ac96-774b-bcce-b302099a8059",
      "level": 0,
      "orderIndex": 0,
      "channelRefs": ["01890a5d-ac96-774b-bcce-b302099a805b"]
    },
    {
      "id": "01890a5d-ac96-774b-bcce-b302099a8058",
      "userId": "01890a5d-ac96-774b-bcce-b302099a805a",
      "level": 2,
      "orderIndex": 0,
      "channelRefs": ["01890a5d-ac96-774b-bcce-b302099a805b"]
    }
  ],
  "schedules": [
    {
      "id": "01890a5d-ac96-774b-bcce-b302099a8059",
      "userId": "01890a5d-ac96-774b-bcce-b302099a8059",
      "startsAt": "2026-10-19T07:00:00.000Z",
      "endsAt": "2026-10-26T07:00:00.000Z"
    }
  ],
  "createdAt": "2026-10-20T10:00:00.000Z",
  "updatedAt": "2026-10-20T10:00:00.000Z"
}
```

#### Response 400

Problem details; code is one of INVALID_CURSOR, INVALID_QUERY, SBX_BAD_REQUEST, IDEMPOTENCY_KEY_REQUIRED, SIGNUP_TOKEN_INVALID.

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

Example: Invalid query.

```json
{
  "type": "https://errors.blackwing.dev/INVALID_QUERY",
  "title": "Invalid query",
  "status": 400,
  "code": "INVALID_QUERY",
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

Problem details; code is one of FORBIDDEN.

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

Problem details; code is one of CONFLICT.

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

#### Response 412

Problem details; code is one of PRECONDITION_FAILED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition failed.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_FAILED",
  "title": "Precondition failed",
  "status": 412,
  "code": "PRECONDITION_FAILED",
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

#### Response 428

Problem details; code is one of PRECONDITION_REQUIRED.

Content type `application/problem+json`: [Problem](#problem).

Example: Precondition required.

```json
{
  "type": "https://errors.blackwing.dev/PRECONDITION_REQUIRED",
  "title": "Precondition required",
  "status": 428,
  "code": "PRECONDITION_REQUIRED",
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

### AssessmentRequest

| Property           | Type                                                                      | Required | Description |
| ------------------ | ------------------------------------------------------------------------- | -------- | ----------- |
| `id`               | string                                                                    | yes      |             |
| `status`           | enum: `"draft"`, `"submitted"`, `"withdrawn"`, `"promoted"`, `"rejected"` | yes      |             |
| `mode`             | enum: `"black"`, `"grey"`, `"white"`                                      | yes      |             |
| `objective`        | string                                                                    | yes      |             |
| `assetIds`         | array of string (uuid)                                                    | yes      |             |
| `saId`             | string (uuid) or null                                                     | yes      |             |
| `inputManifestId`  | string (uuid) or null                                                     | yes      |             |
| `scopeRules`       | object                                                                    | yes      |             |
| `maxIntrusiveness` | enum: `"passive"`, `"active_safe"`, `"state_changing"`                    | yes      |             |
| `budgets`          | object                                                                    | yes      |             |
| `trigger`          | enum: `"console"`, `"api"`, `"ci"`, `"schedule"`, `"retest"`              | yes      |             |
| `requestedBy`      | string (uuid)                                                             | yes      |             |
| `stateVersion`     | integer                                                                   | yes      |             |
| `createdAt`        | string (date-time)                                                        | yes      |             |
| `updatedAt`        | string (date-time)                                                        | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^areq_[A-Za-z0-9]+$"
    },
    "status": {
      "type": "string",
      "enum": ["draft", "submitted", "withdrawn", "promoted", "rejected"]
    },
    "mode": {
      "type": "string",
      "enum": ["black", "grey", "white"]
    },
    "objective": {
      "type": "string"
    },
    "assetIds": {
      "type": "array",
      "items": {
        "type": "string",
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
      }
    },
    "saId": {
      "anyOf": [
        {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        {
          "type": "null"
        }
      ]
    },
    "inputManifestId": {
      "anyOf": [
        {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        {
          "type": "null"
        }
      ]
    },
    "scopeRules": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    },
    "maxIntrusiveness": {
      "type": "string",
      "enum": ["passive", "active_safe", "state_changing"]
    },
    "budgets": {
      "type": "object",
      "properties": {
        "costCapUsd": {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "maxRequests": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 10000000
        },
        "maxDurationMs": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 2592000000
        }
      },
      "required": ["costCapUsd", "maxRequests", "maxDurationMs"],
      "additionalProperties": false
    },
    "trigger": {
      "type": "string",
      "enum": ["console", "api", "ci", "schedule", "retest"]
    },
    "requestedBy": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "stateVersion": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    }
  },
  "required": [
    "id",
    "status",
    "mode",
    "objective",
    "assetIds",
    "saId",
    "inputManifestId",
    "scopeRules",
    "maxIntrusiveness",
    "budgets",
    "trigger",
    "requestedBy",
    "stateVersion",
    "createdAt",
    "updatedAt"
  ],
  "additionalProperties": false
}
```

### AssessmentRequestCreate

| Property           | Type                                                         | Required | Description |
| ------------------ | ------------------------------------------------------------ | -------- | ----------- |
| `mode`             | enum: `"black"`, `"grey"`, `"white"`                         | yes      |             |
| `objective`        | string                                                       | yes      |             |
| `assetIds`         | array of string (uuid)                                       | yes      |             |
| `scopeRules`       | object                                                       | no       |             |
| `maxIntrusiveness` | enum: `"passive"`, `"active_safe"`, `"state_changing"`       | yes      |             |
| `budgets`          | object                                                       | no       |             |
| `inputManifestId`  | string (uuid)                                                | no       |             |
| `saId`             | string (uuid)                                                | no       |             |
| `trigger`          | enum: `"console"`, `"api"`, `"ci"`, `"schedule"`, `"retest"` | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "mode": {
      "type": "string",
      "enum": ["black", "grey", "white"]
    },
    "objective": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "assetIds": {
      "default": [],
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
      }
    },
    "scopeRules": {
      "type": "object",
      "properties": {
        "rules": {
          "maxItems": 1000,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "effect": {
                "type": "string",
                "enum": ["include", "exclude"]
              },
              "host": {},
              "cidr": {},
              "ports": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {}
              },
              "paths": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {}
              },
              "methods": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT"]
                }
              }
            },
            "required": ["effect"],
            "additionalProperties": false
          }
        }
      },
      "required": ["rules"],
      "additionalProperties": false
    },
    "maxIntrusiveness": {
      "default": "active_safe",
      "type": "string",
      "enum": ["passive", "active_safe", "state_changing"]
    },
    "budgets": {
      "type": "object",
      "properties": {
        "costCapUsd": {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "maxRequests": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 10000000
        },
        "maxDurationMs": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 2592000000
        }
      },
      "additionalProperties": false
    },
    "inputManifestId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "saId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "trigger": {
      "default": "console",
      "type": "string",
      "enum": ["console", "api", "ci", "schedule", "retest"]
    }
  },
  "required": ["mode", "objective", "assetIds", "maxIntrusiveness", "trigger"],
  "additionalProperties": false
}
```

### AssessmentRequestList

| Property | Type            | Required | Description |
| -------- | --------------- | -------- | ----------- |
| `items`  | array of object | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^areq_[A-Za-z0-9]+$"
          },
          "status": {
            "type": "string",
            "enum": ["draft", "submitted", "withdrawn", "promoted", "rejected"]
          },
          "mode": {
            "type": "string",
            "enum": ["black", "grey", "white"]
          },
          "objective": {
            "type": "string"
          },
          "assetIds": {
            "type": "array",
            "items": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            }
          },
          "saId": {
            "anyOf": [
              {
                "type": "string",
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
              },
              {
                "type": "null"
              }
            ]
          },
          "inputManifestId": {
            "anyOf": [
              {
                "type": "string",
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
              },
              {
                "type": "null"
              }
            ]
          },
          "scopeRules": {
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {}
          },
          "maxIntrusiveness": {
            "type": "string",
            "enum": ["passive", "active_safe", "state_changing"]
          },
          "budgets": {
            "type": "object",
            "properties": {
              "costCapUsd": {
                "type": "number",
                "exclusiveMinimum": 0,
                "maximum": 100000
              },
              "maxRequests": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 10000000
              },
              "maxDurationMs": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 2592000000
              }
            },
            "required": ["costCapUsd", "maxRequests", "maxDurationMs"],
            "additionalProperties": false
          },
          "trigger": {
            "type": "string",
            "enum": ["console", "api", "ci", "schedule", "retest"]
          },
          "requestedBy": {
            "type": "string",
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
          },
          "stateVersion": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
          }
        },
        "required": [
          "id",
          "status",
          "mode",
          "objective",
          "assetIds",
          "saId",
          "inputManifestId",
          "scopeRules",
          "maxIntrusiveness",
          "budgets",
          "trigger",
          "requestedBy",
          "stateVersion",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": ["items"],
  "additionalProperties": false
}
```

### AssessmentRequestPatch

| Property           | Type                                                         | Required | Description |
| ------------------ | ------------------------------------------------------------ | -------- | ----------- |
| `mode`             | enum: `"black"`, `"grey"`, `"white"`                         | no       |             |
| `objective`        | string                                                       | no       |             |
| `assetIds`         | array of string (uuid)                                       | no       |             |
| `scopeRules`       | object                                                       | no       |             |
| `maxIntrusiveness` | enum: `"passive"`, `"active_safe"`, `"state_changing"`       | no       |             |
| `budgets`          | object                                                       | no       |             |
| `inputManifestId`  | string (uuid)                                                | no       |             |
| `saId`             | string (uuid)                                                | no       |             |
| `trigger`          | enum: `"console"`, `"api"`, `"ci"`, `"schedule"`, `"retest"` | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "mode": {
      "type": "string",
      "enum": ["black", "grey", "white"]
    },
    "objective": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "assetIds": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
      }
    },
    "scopeRules": {
      "type": "object",
      "properties": {
        "rules": {
          "maxItems": 1000,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "effect": {
                "type": "string",
                "enum": ["include", "exclude"]
              },
              "host": {},
              "cidr": {},
              "ports": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {}
              },
              "paths": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {}
              },
              "methods": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT"]
                }
              }
            },
            "required": ["effect"],
            "additionalProperties": false
          }
        }
      },
      "required": ["rules"],
      "additionalProperties": false
    },
    "maxIntrusiveness": {
      "type": "string",
      "enum": ["passive", "active_safe", "state_changing"]
    },
    "budgets": {
      "type": "object",
      "properties": {
        "costCapUsd": {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "maxRequests": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 10000000
        },
        "maxDurationMs": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 2592000000
        }
      },
      "additionalProperties": false
    },
    "inputManifestId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "saId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "trigger": {
      "type": "string",
      "enum": ["console", "api", "ci", "schedule", "retest"]
    }
  },
  "additionalProperties": false
}
```

### AssetListQuery

| Property             | Type                                                                     | Required | Description |
| -------------------- | ------------------------------------------------------------------------ | -------- | ----------- |
| `verificationStatus` | enum: `"unverified"`, `"pending"`, `"verified"`, `"rejected"`            | no       |             |
| `type`               | enum: `"web_app"`, `"api"`, `"host"`, `"network_range"`, `"source_repo"` | no       |             |
| `environment`        | enum: `"prod"`, `"staging"`, `"dev"`, `"test"`                           | no       |             |
| `cursor`             | string                                                                   | no       |             |
| `limit`              | integer                                                                  | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "verificationStatus": {
      "type": "string",
      "enum": ["unverified", "pending", "verified", "rejected"]
    },
    "type": {
      "type": "string",
      "enum": ["web_app", "api", "host", "network_range", "source_repo"]
    },
    "environment": {
      "type": "string",
      "enum": ["prod", "staging", "dev", "test"]
    },
    "cursor": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    }
  },
  "additionalProperties": false
}
```

### AssetPage

| Property     | Type            | Required | Description |
| ------------ | --------------- | -------- | ----------- |
| `items`      | array of object | yes      |             |
| `nextCursor` | string or null  | no       |             |
| `hasMore`    | boolean         | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
          },
          "name": {
            "type": "string",
            "minLength": 1
          },
          "type": {
            "type": "string",
            "enum": ["web_app", "api", "host", "network_range", "source_repo"]
          },
          "environment": {
            "type": "string",
            "enum": ["prod", "staging", "dev", "test"]
          },
          "verificationStatus": {
            "type": "string",
            "enum": ["unverified", "pending", "verified", "rejected"]
          }
        },
        "required": ["id", "name", "type", "environment", "verificationStatus"],
        "additionalProperties": false
      }
    },
    "nextCursor": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ]
    },
    "hasMore": {
      "type": "boolean"
    }
  },
  "required": ["items"],
  "additionalProperties": false
}
```

### AssetView

| Property             | Type                                                                     | Required | Description |
| -------------------- | ------------------------------------------------------------------------ | -------- | ----------- |
| `id`                 | string                                                                   | yes      |             |
| `publicId`           | string                                                                   | yes      |             |
| `type`               | enum: `"web_app"`, `"api"`, `"host"`, `"network_range"`, `"source_repo"` | yes      |             |
| `name`               | string                                                                   | yes      |             |
| `identifiers`        | array of object                                                          | yes      |             |
| `environment`        | enum: `"prod"`, `"staging"`, `"dev"`, `"test"`                           | yes      |             |
| `ownerUserId`        | string                                                                   | yes      |             |
| `verificationStatus` | enum: `"unverified"`, `"pending"`, `"verified"`, `"rejected"`            | yes      |             |
| `verificationMethod` | enum: `"dns_txt"`, `"http_file"`, `"manual_letter"` or null              | yes      |             |
| `etag`               | string                                                                   | yes      |             |
| `createdAt`          | string (date-time)                                                       | yes      |             |
| `updatedAt`          | string (date-time)                                                       | yes      |             |
| `warnings`           | array of string                                                          | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "publicId": {
      "type": "string",
      "pattern": "^asset_[0-9a-hjkmnp-tv-z]{26}$"
    },
    "type": {
      "type": "string",
      "enum": ["web_app", "api", "host", "network_range", "source_repo"]
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "identifiers": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": ["host", "url", "cidr", "repo"]
          },
          "value": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": ["kind", "value"],
        "additionalProperties": false
      }
    },
    "environment": {
      "type": "string",
      "enum": ["prod", "staging", "dev", "test"]
    },
    "ownerUserId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "verificationStatus": {
      "type": "string",
      "enum": ["unverified", "pending", "verified", "rejected"]
    },
    "verificationMethod": {
      "anyOf": [
        {
          "type": "string",
          "enum": ["dns_txt", "http_file", "manual_letter"]
        },
        {
          "type": "null"
        }
      ]
    },
    "etag": {
      "type": "string",
      "pattern": "^\"v\\d+\"$"
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
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    }
  },
  "required": [
    "id",
    "publicId",
    "type",
    "name",
    "identifiers",
    "environment",
    "ownerUserId",
    "verificationStatus",
    "verificationMethod",
    "etag",
    "createdAt",
    "updatedAt",
    "warnings"
  ],
  "additionalProperties": false
}
```

### AuditEventView

| Property      | Type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Required | Description                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `id`          | string (uuid)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | yes      |                                                                          |
| `seq`         | integer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | yes      |                                                                          |
| `occurredAt`  | string (date-time)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | yes      |                                                                          |
| `action`      | enum: `"auth.login"`, `"auth.logout"`, `"auth.sso_link"`, `"auth.api_token_issued"`, `"auth.api_token_revoked"`, `"authz.denied"`, `"authz.role_changed"`, `"asset.created"`, `"asset.verified"`, `"sa.requested"`, `"sa.approved"`, `"sa.rejected"`, `"sa.revoked"`, `"gate1.decided"`, `"gate2.decided"`, `"gate3.released"`, `"run.created"`, `"run.state_changed"`, `"tool.invoked"`, `"egress.blocked"`, `"kill.fired"`, `"kill.completed"`, `"finding.released"`, `"finding.risk_accepted"`, `"export.generated"`, `"secret.resolved"`, `"config.changed"`, `"connector.configured"`, `"kill.triggered"`, `"kill.forbidden"`, `"kill.egress_blocked"`, `"kill.sandboxes_terminated"`, `"secret.kek_provisioned"`, `"secret.kek_rotated"`, `"secret.kek_disabled"`, `"kill.keys_revoked"`, `"kill.workflows_cancelled"`, `"activity.started"`, `"activity.succeeded"`, `"activity.failed"`, `"workflow.started"`, `"workflow.completed"`, `"workflow.failed"`, `"workflow.cancelled"`, `"workflow.continued_as_new"`, `"soc_kill.link_minted"`, `"soc_kill.triggered"`, `"soc_kill.rejected"`, `"outbox.delivery_failed"`, `"scope.request.created"`, `"scope.request.status_changed"`, `"operator.kill_previewed"`, `"operator.kill_fired"`, `"audit.queried"`, `"secret.rotated"`, `"secret.rewrapped"`, `"persona.override_changed"`, `"auth.sso_config_changed"`, `"tenant.created"`, `"signup.verified"`, `"tenant.settings_updated"`, `"auth.operator_login"`, `"auth.operator_logout"`, `"auth.operator_session_revoked"`, `"authz.sa.created"`, `"authz.sa.state_changed"`, `"authz.sa.signed"`, `"authz.signing_key.rotated"`, `"authz.gate.decision"`, `"authz.sa.updated"`, `"authz.sa.submitted"`, `"run.surface.viewed"`, `"scope.request.updated"`, `"scope.request.submitted"`, `"scope.request.withdrawn"`, `"test_plan.version_created"`, `"test_case.created"`, `"test_case.updated"`, `"test_case.removed"`, `"asset.updated"`, `"asset.deleted"`, `"asset.owner_assigned"`, `"test_plan.validated"`, `"oncall.roster.updated"`, `"oncall.sod_skipped"` | yes      |                                                                          |
| `severity`    | enum: `"info"`, `"notice"`, `"warning"`, `"critical"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | yes      |                                                                          |
| `actor`       | object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | yes      | Who acted. `email` is only returned to auditors.                         |
| `target`      | object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | yes      |                                                                          |
| `outcome`     | enum: `"success"`, `"failure"`, `"denied"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | yes      |                                                                          |
| `reason`      | any                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | yes      |                                                                          |
| `metadata`    | object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | yes      | Empty for callers that are not auditors.                                 |
| `metadataRef` | object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | no       | Only returned to auditors.                                               |
| `traceId`     | any                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | yes      |                                                                          |
| `runId`       | any                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | yes      |                                                                          |
| `hash`        | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | no       | Hex SHA-256 chain hash. Only with includeChain=true.                     |
| `prevHash`    | any                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | no       | Hex previous hash; null on the genesis row. Only with includeChain=true. |

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
        "signup.verified",
        "tenant.settings_updated",
        "auth.operator_login",
        "auth.operator_logout",
        "auth.operator_session_revoked",
        "authz.sa.created",
        "authz.sa.state_changed",
        "authz.sa.signed",
        "authz.signing_key.rotated",
        "authz.gate.decision",
        "authz.sa.updated",
        "authz.sa.submitted",
        "run.surface.viewed",
        "scope.request.updated",
        "scope.request.submitted",
        "scope.request.withdrawn",
        "test_plan.version_created",
        "test_case.created",
        "test_case.updated",
        "test_case.removed",
        "asset.updated",
        "asset.deleted",
        "asset.owner_assigned",
        "test_plan.validated",
        "oncall.roster.updated",
        "oncall.sod_skipped"
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

### CreateAssetBody

| Property      | Type                                                                     | Required | Description |
| ------------- | ------------------------------------------------------------------------ | -------- | ----------- |
| `type`        | enum: `"web_app"`, `"api"`, `"host"`, `"network_range"`, `"source_repo"` | yes      |             |
| `name`        | string                                                                   | yes      |             |
| `identifiers` | array of object                                                          | yes      |             |
| `environment` | enum: `"prod"`, `"staging"`, `"dev"`, `"test"`                           | yes      |             |
| `ownerUserId` | string                                                                   | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "enum": ["web_app", "api", "host", "network_range", "source_repo"]
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "identifiers": {
      "minItems": 1,
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": ["host", "url", "cidr", "repo"]
          },
          "value": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2048
          }
        },
        "required": ["kind", "value"],
        "additionalProperties": false
      }
    },
    "environment": {
      "type": "string",
      "enum": ["prod", "staging", "dev", "test"]
    },
    "ownerUserId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": ["type", "name", "identifiers", "environment", "ownerUserId"],
  "additionalProperties": false
}
```

### CreateStandingAuthorisation

| Property                 | Type                                                   | Required | Description |
| ------------------------ | ------------------------------------------------------ | -------- | ----------- |
| `assetIds`               | array of string                                        | yes      |             |
| `scopeRules`             | object                                                 | yes      |             |
| `maxIntrusiveness`       | enum: `"passive"`, `"active_safe"`, `"state_changing"` | yes      |             |
| `preApprovedTestClasses` | array of string                                        | yes      |             |
| `defaultBudgets`         | object                                                 | yes      |             |
| `testWindows`            | array of object                                        | yes      |             |
| `validFrom`              | string (date-time)                                     | yes      |             |
| `expiresAt`              | string (date-time)                                     | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "assetIds": {
      "minItems": 1,
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
      }
    },
    "scopeRules": {
      "type": "object",
      "properties": {
        "rules": {
          "maxItems": 1000,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "effect": {
                "type": "string",
                "enum": ["include", "exclude"]
              },
              "host": {},
              "cidr": {},
              "ports": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {}
              },
              "paths": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {}
              },
              "methods": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT"]
                }
              }
            },
            "required": ["effect"],
            "additionalProperties": false
          }
        }
      },
      "required": ["rules"],
      "additionalProperties": false
    },
    "maxIntrusiveness": {
      "type": "string",
      "enum": ["passive", "active_safe", "state_changing"]
    },
    "preApprovedTestClasses": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120
      }
    },
    "defaultBudgets": {
      "type": "object",
      "properties": {
        "costCapUsd": {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "maxRequests": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 10000000
        },
        "maxDurationMs": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 2592000000
        }
      },
      "required": ["costCapUsd", "maxRequests", "maxDurationMs"],
      "additionalProperties": false
    },
    "testWindows": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "cron": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "timezone": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "durationMs": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": ["cron", "timezone", "durationMs"],
        "additionalProperties": false
      }
    },
    "validFrom": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    },
    "expiresAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    }
  },
  "required": [
    "assetIds",
    "scopeRules",
    "maxIntrusiveness",
    "preApprovedTestClasses",
    "defaultBudgets",
    "testWindows",
    "validFrom",
    "expiresAt"
  ],
  "additionalProperties": false
}
```

### Finding

| Property         | Type                                                                                                                                                                    | Required | Description |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `id`             | string                                                                                                                                                                  | yes      |             |
| `title`          | string                                                                                                                                                                  | yes      |             |
| `class`          | string                                                                                                                                                                  | yes      |             |
| `status`         | enum: `"candidate"`, `"validating"`, `"confirmed"`, `"suspected"`, `"released"`, `"rejected_false_positive"`, `"duplicate"`, `"accepted_risk"`, `"fixed"`, `"returned"` | yes      |             |
| `baselineStatus` | enum: `"new"`, `"open"`, `"fixed"`, `"returned"`, `"not_retested"` or null                                                                                              | yes      |             |
| `severity`       | object or null                                                                                                                                                          | yes      |             |
| `cweId`          | string or null                                                                                                                                                          | yes      |             |
| `owaspCategory`  | string or null                                                                                                                                                          | yes      |             |
| `unmapped`       | boolean                                                                                                                                                                 | yes      |             |
| `confidence`     | number or null                                                                                                                                                          | yes      |             |
| `assetId`        | string                                                                                                                                                                  | yes      |             |
| `location`       | object                                                                                                                                                                  | yes      |             |
| `firstSeenRunId` | string                                                                                                                                                                  | yes      |             |
| `lastSeenRunId`  | string                                                                                                                                                                  | yes      |             |
| `stateVersion`   | integer                                                                                                                                                                 | yes      |             |
| `createdAt`      | string (date-time)                                                                                                                                                      | yes      |             |
| `updatedAt`      | string (date-time)                                                                                                                                                      | yes      |             |
| `mappingVersion` | string or null                                                                                                                                                          | yes      |             |
| `classification` | object or null                                                                                                                                                          | yes      |             |
| `acceptedRisk`   | object or null                                                                                                                                                          | yes      |             |
| `releasedBy`     | string or null                                                                                                                                                          | yes      |             |
| `releasedAt`     | string (date-time) or null                                                                                                                                              | yes      |             |
| `occurrences`    | object                                                                                                                                                                  | yes      |             |
| `evidence`       | object                                                                                                                                                                  | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^fnd_[A-Za-z0-9]+$"
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "class": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "status": {
      "type": "string",
      "enum": [
        "candidate",
        "validating",
        "confirmed",
        "suspected",
        "released",
        "rejected_false_positive",
        "duplicate",
        "accepted_risk",
        "fixed",
        "returned"
      ]
    },
    "baselineStatus": {
      "anyOf": [
        {
          "type": "string",
          "enum": ["new", "open", "fixed", "returned", "not_retested"]
        },
        {
          "type": "null"
        }
      ]
    },
    "severity": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "cvss4": {
              "type": "object",
              "properties": {
                "vector": {
                  "type": "string",
                  "pattern": "^CVSS:4\\.0\\/\\S+$"
                },
                "score": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                "severity": {
                  "type": "string",
                  "enum": ["none", "low", "medium", "high", "critical"]
                },
                "nomenclature": {
                  "type": "string",
                  "enum": ["CVSS-B", "CVSS-BE", "CVSS-BT", "CVSS-BTE"]
                }
              },
              "required": ["vector", "score", "severity", "nomenclature"],
              "additionalProperties": false
            },
            "cvss31": {
              "type": "object",
              "properties": {
                "vector": {
                  "type": "string",
                  "pattern": "^CVSS:3\\.1\\/\\S+$"
                },
                "score": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                "severity": {
                  "type": "string",
                  "enum": ["none", "low", "medium", "high", "critical"]
                }
              },
              "required": ["vector", "score", "severity"],
              "additionalProperties": false
            }
          },
          "required": ["cvss4"],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "cweId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^CWE-[1-9][0-9]{0,4}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "owaspCategory": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        {
          "type": "null"
        }
      ]
    },
    "unmapped": {
      "type": "boolean"
    },
    "confidence": {
      "anyOf": [
        {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        {
          "type": "null"
        }
      ]
    },
    "assetId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "location": {
      "type": "object",
      "properties": {
        "method": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Z]+$"
            },
            {
              "type": "null"
            }
          ]
        },
        "urlTemplate": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            },
            {
              "type": "null"
            }
          ]
        },
        "parameter": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 512
            },
            {
              "type": "null"
            }
          ]
        },
        "file": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 1024
            },
            {
              "type": "null"
            }
          ]
        },
        "line": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": ["method", "urlTemplate", "parameter", "file", "line"],
      "additionalProperties": false
    },
    "firstSeenRunId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "lastSeenRunId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "stateVersion": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
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
    },
    "mappingVersion": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$"
        },
        {
          "type": "null"
        }
      ]
    },
    "classification": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "cweCandidates": {
              "maxItems": 8,
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^CWE-[1-9][0-9]{0,4}$"
              }
            },
            "apiTop10": {
              "anyOf": [
                {
                  "type": "string",
                  "pattern": "^API([1-9]|10)$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "wstg": {
              "maxItems": 16,
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^WSTG-[A-Z]{4}-[0-9]{2}$"
              }
            }
          },
          "required": ["cweCandidates", "apiTop10", "wstg"],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "acceptedRisk": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "reason": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2000
            },
            "expiresAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
            }
          },
          "required": ["reason", "expiresAt"],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "releasedBy": {
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
    "releasedAt": {
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
    "occurrences": {
      "type": "object",
      "properties": {
        "items": {
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
              },
              "runId": {
                "type": "string",
                "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
              },
              "occurrenceStatus": {
                "type": "string",
                "minLength": 1,
                "maxLength": 120
              },
              "evidenceChainHead": {
                "anyOf": [
                  {
                    "type": "string",
                    "pattern": "^[0-9a-f]{64}$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "detectedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
              }
            },
            "required": ["id", "runId", "occurrenceStatus", "evidenceChainHead", "detectedAt"],
            "additionalProperties": false
          }
        },
        "total": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "truncated": {
          "type": "boolean"
        }
      },
      "required": ["items", "total", "truncated"],
      "additionalProperties": false
    },
    "evidence": {
      "type": "object",
      "properties": {
        "items": {
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "evidenceId": {
                "type": "string",
                "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
              },
              "objectKey": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$"
              },
              "sha256": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$"
              },
              "chain": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$"
              },
              "occurrenceId": {
                "type": "string",
                "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
              },
              "runId": {
                "type": "string",
                "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
              }
            },
            "required": ["evidenceId", "objectKey", "sha256", "chain", "occurrenceId", "runId"],
            "additionalProperties": false
          }
        },
        "total": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "truncated": {
          "type": "boolean"
        }
      },
      "required": ["items", "total", "truncated"],
      "additionalProperties": false
    }
  },
  "required": [
    "id",
    "title",
    "class",
    "status",
    "baselineStatus",
    "severity",
    "cweId",
    "owaspCategory",
    "unmapped",
    "confidence",
    "assetId",
    "location",
    "firstSeenRunId",
    "lastSeenRunId",
    "stateVersion",
    "createdAt",
    "updatedAt",
    "mappingVersion",
    "classification",
    "acceptedRisk",
    "releasedBy",
    "releasedAt",
    "occurrences",
    "evidence"
  ],
  "additionalProperties": false
}
```

### FindingList

| Property     | Type            | Required | Description |
| ------------ | --------------- | -------- | ----------- |
| `items`      | array of object | yes      |             |
| `nextCursor` | any             | yes      |             |
| `hasMore`    | boolean         | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^fnd_[A-Za-z0-9]+$"
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "class": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "status": {
            "type": "string",
            "enum": [
              "candidate",
              "validating",
              "confirmed",
              "suspected",
              "released",
              "rejected_false_positive",
              "duplicate",
              "accepted_risk",
              "fixed",
              "returned"
            ]
          },
          "baselineStatus": {
            "anyOf": [
              {
                "type": "string",
                "enum": ["new", "open", "fixed", "returned", "not_retested"]
              },
              {
                "type": "null"
              }
            ]
          },
          "severity": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "cvss4": {
                    "type": "object",
                    "properties": {
                      "vector": {
                        "type": "string",
                        "pattern": "^CVSS:4\\.0\\/\\S+$"
                      },
                      "score": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 10
                      },
                      "severity": {
                        "type": "string",
                        "enum": ["none", "low", "medium", "high", "critical"]
                      },
                      "nomenclature": {
                        "type": "string",
                        "enum": ["CVSS-B", "CVSS-BE", "CVSS-BT", "CVSS-BTE"]
                      }
                    },
                    "required": ["vector", "score", "severity", "nomenclature"],
                    "additionalProperties": false
                  },
                  "cvss31": {
                    "type": "object",
                    "properties": {
                      "vector": {
                        "type": "string",
                        "pattern": "^CVSS:3\\.1\\/\\S+$"
                      },
                      "score": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 10
                      },
                      "severity": {
                        "type": "string",
                        "enum": ["none", "low", "medium", "high", "critical"]
                      }
                    },
                    "required": ["vector", "score", "severity"],
                    "additionalProperties": false
                  }
                },
                "required": ["cvss4"],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "cweId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^CWE-[1-9][0-9]{0,4}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "owaspCategory": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1,
                "maxLength": 120
              },
              {
                "type": "null"
              }
            ]
          },
          "unmapped": {
            "type": "boolean"
          },
          "confidence": {
            "anyOf": [
              {
                "type": "number",
                "minimum": 0,
                "maximum": 1
              },
              {
                "type": "null"
              }
            ]
          },
          "assetId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "location": {
            "type": "object",
            "properties": {
              "method": {
                "anyOf": [
                  {
                    "type": "string",
                    "pattern": "^[A-Z]+$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "urlTemplate": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "parameter": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "file": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1024
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "line": {
                "anyOf": [
                  {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": ["method", "urlTemplate", "parameter", "file", "line"],
            "additionalProperties": false
          },
          "firstSeenRunId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "lastSeenRunId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "stateVersion": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
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
          "id",
          "title",
          "class",
          "status",
          "baselineStatus",
          "severity",
          "cweId",
          "owaspCategory",
          "unmapped",
          "confidence",
          "assetId",
          "location",
          "firstSeenRunId",
          "lastSeenRunId",
          "stateVersion",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    },
    "nextCursor": {
      "type": ["string", "null"]
    },
    "hasMore": {
      "type": "boolean"
    }
  },
  "required": ["items", "nextCursor", "hasMore"],
  "additionalProperties": false
}
```

### FindingSummary

| Property         | Type                                                                                                                                                                    | Required | Description |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `id`             | string                                                                                                                                                                  | yes      |             |
| `title`          | string                                                                                                                                                                  | yes      |             |
| `class`          | string                                                                                                                                                                  | yes      |             |
| `status`         | enum: `"candidate"`, `"validating"`, `"confirmed"`, `"suspected"`, `"released"`, `"rejected_false_positive"`, `"duplicate"`, `"accepted_risk"`, `"fixed"`, `"returned"` | yes      |             |
| `baselineStatus` | enum: `"new"`, `"open"`, `"fixed"`, `"returned"`, `"not_retested"` or null                                                                                              | yes      |             |
| `severity`       | object or null                                                                                                                                                          | yes      |             |
| `cweId`          | string or null                                                                                                                                                          | yes      |             |
| `owaspCategory`  | string or null                                                                                                                                                          | yes      |             |
| `unmapped`       | boolean                                                                                                                                                                 | yes      |             |
| `confidence`     | number or null                                                                                                                                                          | yes      |             |
| `assetId`        | string                                                                                                                                                                  | yes      |             |
| `location`       | object                                                                                                                                                                  | yes      |             |
| `firstSeenRunId` | string                                                                                                                                                                  | yes      |             |
| `lastSeenRunId`  | string                                                                                                                                                                  | yes      |             |
| `stateVersion`   | integer                                                                                                                                                                 | yes      |             |
| `createdAt`      | string (date-time)                                                                                                                                                      | yes      |             |
| `updatedAt`      | string (date-time)                                                                                                                                                      | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^fnd_[A-Za-z0-9]+$"
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "class": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "status": {
      "type": "string",
      "enum": [
        "candidate",
        "validating",
        "confirmed",
        "suspected",
        "released",
        "rejected_false_positive",
        "duplicate",
        "accepted_risk",
        "fixed",
        "returned"
      ]
    },
    "baselineStatus": {
      "anyOf": [
        {
          "type": "string",
          "enum": ["new", "open", "fixed", "returned", "not_retested"]
        },
        {
          "type": "null"
        }
      ]
    },
    "severity": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "cvss4": {
              "type": "object",
              "properties": {
                "vector": {
                  "type": "string",
                  "pattern": "^CVSS:4\\.0\\/\\S+$"
                },
                "score": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                "severity": {
                  "type": "string",
                  "enum": ["none", "low", "medium", "high", "critical"]
                },
                "nomenclature": {
                  "type": "string",
                  "enum": ["CVSS-B", "CVSS-BE", "CVSS-BT", "CVSS-BTE"]
                }
              },
              "required": ["vector", "score", "severity", "nomenclature"],
              "additionalProperties": false
            },
            "cvss31": {
              "type": "object",
              "properties": {
                "vector": {
                  "type": "string",
                  "pattern": "^CVSS:3\\.1\\/\\S+$"
                },
                "score": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10
                },
                "severity": {
                  "type": "string",
                  "enum": ["none", "low", "medium", "high", "critical"]
                }
              },
              "required": ["vector", "score", "severity"],
              "additionalProperties": false
            }
          },
          "required": ["cvss4"],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "cweId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^CWE-[1-9][0-9]{0,4}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "owaspCategory": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        {
          "type": "null"
        }
      ]
    },
    "unmapped": {
      "type": "boolean"
    },
    "confidence": {
      "anyOf": [
        {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        {
          "type": "null"
        }
      ]
    },
    "assetId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "location": {
      "type": "object",
      "properties": {
        "method": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Z]+$"
            },
            {
              "type": "null"
            }
          ]
        },
        "urlTemplate": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            },
            {
              "type": "null"
            }
          ]
        },
        "parameter": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 512
            },
            {
              "type": "null"
            }
          ]
        },
        "file": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 1024
            },
            {
              "type": "null"
            }
          ]
        },
        "line": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": ["method", "urlTemplate", "parameter", "file", "line"],
      "additionalProperties": false
    },
    "firstSeenRunId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "lastSeenRunId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "stateVersion": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
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
    "id",
    "title",
    "class",
    "status",
    "baselineStatus",
    "severity",
    "cweId",
    "owaspCategory",
    "unmapped",
    "confidence",
    "assetId",
    "location",
    "firstSeenRunId",
    "lastSeenRunId",
    "stateVersion",
    "createdAt",
    "updatedAt"
  ],
  "additionalProperties": false
}
```

### Gate1DecisionRequest

| Property      | Type                                               | Required | Description |
| ------------- | -------------------------------------------------- | -------- | ----------- |
| `decision`    | enum: `"approve"`, `"request_changes"`, `"reject"` | yes      |             |
| `planVersion` | integer                                            | yes      |             |
| `reason`      | string                                             | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "decision": {
      "type": "string",
      "enum": ["approve", "request_changes", "reject"]
    },
    "planVersion": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "reason": {
      "type": "string",
      "maxLength": 2000
    }
  },
  "required": ["decision", "planVersion"],
  "additionalProperties": false
}
```

### Gate1DecisionResponse

| Property      | Type                                                                                                                                                                                                                                                     | Required | Description |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `runId`       | string                                                                                                                                                                                                                                                   | yes      |             |
| `decision`    | enum: `"approve"`, `"request_changes"`, `"reject"`                                                                                                                                                                                                       | yes      |             |
| `planVersion` | integer                                                                                                                                                                                                                                                  | yes      |             |
| `runState`    | enum: `"draft"`, `"preflight"`, `"recon"`, `"planning"`, `"awaiting_gate1"`, `"approved"`, `"executing"`, `"paused"`, `"validating"`, `"awaiting_gate3"`, `"released"`, `"reporting"`, `"completed"`, `"cancelled"`, `"killed"`, `"failed"`, `"expired"` | yes      |             |
| `decidedAt`   | string (date-time)                                                                                                                                                                                                                                       | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^run_[0-9A-Za-z]{4,64}$"
    },
    "decision": {
      "type": "string",
      "enum": ["approve", "request_changes", "reject"]
    },
    "planVersion": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "runState": {
      "type": "string",
      "enum": [
        "draft",
        "preflight",
        "recon",
        "planning",
        "awaiting_gate1",
        "approved",
        "executing",
        "paused",
        "validating",
        "awaiting_gate3",
        "released",
        "reporting",
        "completed",
        "cancelled",
        "killed",
        "failed",
        "expired"
      ]
    },
    "decidedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    }
  },
  "required": ["runId", "decision", "planVersion", "runState", "decidedAt"],
  "additionalProperties": false
}
```

### Gate1PlanView

| Property       | Type                                                                                                                                                                                                                                                     | Required | Description |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `runId`        | string                                                                                                                                                                                                                                                   | yes      |             |
| `runState`     | enum: `"draft"`, `"preflight"`, `"recon"`, `"planning"`, `"awaiting_gate1"`, `"approved"`, `"executing"`, `"paused"`, `"validating"`, `"awaiting_gate3"`, `"released"`, `"reporting"`, `"completed"`, `"cancelled"`, `"killed"`, `"failed"`, `"expired"` | yes      |             |
| `planVersion`  | integer                                                                                                                                                                                                                                                  | yes      |             |
| `requesterId`  | string or null                                                                                                                                                                                                                                           | yes      |             |
| `requestedAt`  | string (date-time)                                                                                                                                                                                                                                       | yes      |             |
| `expiresAt`    | string (date-time) or null                                                                                                                                                                                                                               | yes      |             |
| `testCases`    | array of object                                                                                                                                                                                                                                          | yes      |             |
| `budgetTotals` | object                                                                                                                                                                                                                                                   | yes      |             |
| `changes`      | object or null                                                                                                                                                                                                                                           | yes      |             |
| `viewer`       | object                                                                                                                                                                                                                                                   | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^run_[0-9A-Za-z]{4,64}$"
    },
    "runState": {
      "type": "string",
      "enum": [
        "draft",
        "preflight",
        "recon",
        "planning",
        "awaiting_gate1",
        "approved",
        "executing",
        "paused",
        "validating",
        "awaiting_gate3",
        "released",
        "reporting",
        "completed",
        "cancelled",
        "killed",
        "failed",
        "expired"
      ]
    },
    "planVersion": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "requesterId": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        {
          "type": "null"
        }
      ]
    },
    "requestedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    },
    "expiresAt": {
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
    "testCases": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "class": {
            "type": "string",
            "enum": ["passive", "active_safe", "state_changing", "destructive"]
          },
          "targets": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            }
          },
          "budget": {
            "type": "object",
            "properties": {
              "maxRequests": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 10000000
              },
              "maxRps": {
                "type": "number",
                "exclusiveMinimum": 0,
                "maximum": 1000
              },
              "maxConcurrency": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 256
              },
              "maxBytes": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 1099511627776
              }
            },
            "required": ["maxRequests", "maxRps", "maxConcurrency", "maxBytes"],
            "additionalProperties": false
          }
        },
        "required": ["id", "title", "class", "targets", "budget"],
        "additionalProperties": false
      }
    },
    "budgetTotals": {
      "type": "object",
      "properties": {
        "maxRequests": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "maxBytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": ["maxRequests", "maxBytes"],
      "additionalProperties": false
    },
    "changes": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "fromVersion": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "added": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "removed": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "changed": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": ["fromVersion", "added", "removed", "changed"],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "viewer": {
      "type": "object",
      "properties": {
        "canDecide": {
          "type": "boolean"
        },
        "isRequester": {
          "type": "boolean"
        }
      },
      "required": ["canDecide", "isRequester"],
      "additionalProperties": false
    }
  },
  "required": [
    "runId",
    "runState",
    "planVersion",
    "requesterId",
    "requestedAt",
    "expiresAt",
    "testCases",
    "budgetTotals",
    "changes",
    "viewer"
  ],
  "additionalProperties": false
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

### KillEventList

| Property | Type            | Required | Description |
| -------- | --------------- | -------- | ----------- |
| `items`  | array of object | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
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
          },
          "killEventId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          }
        },
        "required": [
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
          "updatedAt",
          "killEventId"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": ["items"],
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

### OncallRoster

| Property       | Type               | Required | Description |
| -------------- | ------------------ | -------- | ----------- |
| `id`           | string             | yes      |             |
| `tenantId`     | string             | yes      |             |
| `name`         | string             | yes      |             |
| `timezone`     | string             | yes      |             |
| `active`       | boolean            | yes      |             |
| `stateVersion` | integer            | yes      |             |
| `members`      | array of object    | yes      |             |
| `schedules`    | array of object    | yes      |             |
| `createdAt`    | string (date-time) | yes      |             |
| `updatedAt`    | string (date-time) | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "tenantId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "timezone": {
      "type": "string",
      "maxLength": 64,
      "pattern": "^[A-Za-z][A-Za-z0-9_+-]*(?:\\/[A-Za-z0-9_+-]+)*$"
    },
    "active": {
      "type": "boolean"
    },
    "stateVersion": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "members": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "userId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "level": {
            "anyOf": [
              {
                "type": "number",
                "const": 0
              },
              {
                "type": "number",
                "const": 1
              },
              {
                "type": "number",
                "const": 2
              }
            ]
          },
          "orderIndex": {
            "type": "integer",
            "minimum": 0,
            "maximum": 1000
          },
          "channelRefs": {
            "maxItems": 10,
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            }
          }
        },
        "required": ["id", "userId", "level", "orderIndex", "channelRefs"],
        "additionalProperties": false
      }
    },
    "schedules": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "userId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "startsAt": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
          },
          "endsAt": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
          }
        },
        "required": ["id", "userId", "startsAt", "endsAt"],
        "additionalProperties": false
      }
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
    "id",
    "tenantId",
    "name",
    "timezone",
    "active",
    "stateVersion",
    "members",
    "schedules",
    "createdAt",
    "updatedAt"
  ],
  "additionalProperties": false
}
```

### OncallRosterCreate

| Property    | Type            | Required | Description |
| ----------- | --------------- | -------- | ----------- |
| `name`      | string          | yes      |             |
| `timezone`  | string          | yes      |             |
| `active`    | boolean         | yes      |             |
| `members`   | array of object | yes      |             |
| `schedules` | array of object | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "timezone": {
      "type": "string",
      "maxLength": 64,
      "pattern": "^[A-Za-z][A-Za-z0-9_+-]*(?:\\/[A-Za-z0-9_+-]+)*$"
    },
    "active": {
      "default": true,
      "type": "boolean"
    },
    "members": {
      "default": [],
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "userId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "level": {
            "anyOf": [
              {
                "type": "number",
                "const": 0
              },
              {
                "type": "number",
                "const": 1
              },
              {
                "type": "number",
                "const": 2
              }
            ]
          },
          "orderIndex": {
            "type": "integer",
            "minimum": 0,
            "maximum": 1000
          },
          "channelRefs": {
            "default": [],
            "maxItems": 10,
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            }
          }
        },
        "required": ["userId", "level", "orderIndex", "channelRefs"],
        "additionalProperties": false
      }
    },
    "schedules": {
      "default": [],
      "maxItems": 500,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "userId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "startsAt": {
            "type": "string",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d))|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
          },
          "endsAt": {
            "type": "string",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d))|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
          }
        },
        "required": ["userId", "startsAt", "endsAt"],
        "additionalProperties": false
      }
    }
  },
  "required": ["name", "timezone", "active", "members", "schedules"],
  "additionalProperties": false
}
```

### OncallRosterPatch

| Property    | Type            | Required | Description |
| ----------- | --------------- | -------- | ----------- |
| `name`      | string          | no       |             |
| `timezone`  | string          | no       |             |
| `active`    | boolean         | no       |             |
| `members`   | array of object | no       |             |
| `schedules` | array of object | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "timezone": {
      "type": "string",
      "maxLength": 64,
      "pattern": "^[A-Za-z][A-Za-z0-9_+-]*(?:\\/[A-Za-z0-9_+-]+)*$"
    },
    "active": {
      "type": "boolean"
    },
    "members": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "userId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "level": {
            "anyOf": [
              {
                "type": "number",
                "const": 0
              },
              {
                "type": "number",
                "const": 1
              },
              {
                "type": "number",
                "const": 2
              }
            ]
          },
          "orderIndex": {
            "type": "integer",
            "minimum": 0,
            "maximum": 1000
          },
          "channelRefs": {
            "default": [],
            "maxItems": 10,
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            }
          }
        },
        "required": ["userId", "level", "orderIndex", "channelRefs"],
        "additionalProperties": false
      }
    },
    "schedules": {
      "maxItems": 500,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "userId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "startsAt": {
            "type": "string",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d))|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
          },
          "endsAt": {
            "type": "string",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d))|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
          }
        },
        "required": ["userId", "startsAt", "endsAt"],
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
```

### PatchStandingAuthorisation

| Property                 | Type                                                   | Required | Description |
| ------------------------ | ------------------------------------------------------ | -------- | ----------- |
| `assetIds`               | array of string                                        | no       |             |
| `scopeRules`             | object                                                 | no       |             |
| `maxIntrusiveness`       | enum: `"passive"`, `"active_safe"`, `"state_changing"` | no       |             |
| `preApprovedTestClasses` | array of string                                        | no       |             |
| `defaultBudgets`         | object                                                 | no       |             |
| `testWindows`            | array of object                                        | no       |             |
| `validFrom`              | string (date-time)                                     | no       |             |
| `expiresAt`              | string (date-time)                                     | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "assetIds": {
      "minItems": 1,
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
      }
    },
    "scopeRules": {
      "type": "object",
      "properties": {
        "rules": {
          "maxItems": 1000,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "effect": {
                "type": "string",
                "enum": ["include", "exclude"]
              },
              "host": {},
              "cidr": {},
              "ports": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {}
              },
              "paths": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {}
              },
              "methods": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT"]
                }
              }
            },
            "required": ["effect"],
            "additionalProperties": false
          }
        }
      },
      "required": ["rules"],
      "additionalProperties": false
    },
    "maxIntrusiveness": {
      "type": "string",
      "enum": ["passive", "active_safe", "state_changing"]
    },
    "preApprovedTestClasses": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120
      }
    },
    "defaultBudgets": {
      "type": "object",
      "properties": {
        "costCapUsd": {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "maxRequests": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 10000000
        },
        "maxDurationMs": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 2592000000
        }
      },
      "required": ["costCapUsd", "maxRequests", "maxDurationMs"],
      "additionalProperties": false
    },
    "testWindows": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "cron": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "timezone": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "durationMs": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": ["cron", "timezone", "durationMs"],
        "additionalProperties": false
      }
    },
    "validFrom": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    },
    "expiresAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    }
  },
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

### PlanValidationResult

| Property        | Type               | Required | Description |
| --------------- | ------------------ | -------- | ----------- |
| `planId`        | string             | yes      |             |
| `runId`         | string             | yes      |             |
| `version`       | integer            | yes      |             |
| `saId`          | string or null     | yes      |             |
| `ok`            | boolean            | yes      |             |
| `gate1Required` | boolean            | yes      |             |
| `violations`    | array of object    | yes      |             |
| `budgetTotals`  | object             | yes      |             |
| `validatedAt`   | string (date-time) | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "planId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "runId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "version": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "saId": {
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
    "ok": {
      "type": "boolean"
    },
    "gate1Required": {
      "type": "boolean"
    },
    "violations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "code": {
            "type": "string",
            "enum": [
              "PLAN_SA_MISSING",
              "PLAN_SA_NOT_ACTIVE",
              "PLAN_CLASS_DESTRUCTIVE_BLOCKED",
              "PLAN_CLASS_EXCEEDS_SA",
              "PLAN_STATE_CHANGING_NOT_AUTHORISED",
              "PLAN_TARGET_OUT_OF_SCOPE",
              "PLAN_ROLE_UNKNOWN",
              "PLAN_ORACLE_MISSING",
              "PLAN_NEGATIVE_CONTROL_MISSING",
              "PLAN_BUDGET_EXCEEDED",
              "PLAN_POLICY_DENIED",
              "PLAN_POLICY_EVAL_FAILED"
            ]
          },
          "caseId": {
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
          "policyId": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              {
                "type": "null"
              }
            ]
          },
          "message": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          }
        },
        "required": ["code", "caseId", "policyId", "message"],
        "additionalProperties": false
      }
    },
    "budgetTotals": {
      "type": "object",
      "properties": {
        "totalRequests": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "totalBytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "perClassCounts": {
          "type": "object",
          "properties": {
            "passive": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "active_safe": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "state_changing": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "destructive": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": ["passive", "active_safe", "state_changing", "destructive"],
          "additionalProperties": false
        }
      },
      "required": ["totalRequests", "totalBytes", "perClassCounts"],
      "additionalProperties": false
    },
    "validatedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    }
  },
  "required": [
    "planId",
    "runId",
    "version",
    "saId",
    "ok",
    "gate1Required",
    "violations",
    "budgetTotals",
    "validatedAt"
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

### RejectStandingAuthorisation

| Property | Type   | Required | Description |
| -------- | ------ | -------- | ----------- |
| `reason` | string | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    }
  },
  "required": ["reason"],
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

### StandingAuthorisation

| Property                 | Type                                                                        | Required | Description |
| ------------------------ | --------------------------------------------------------------------------- | -------- | ----------- |
| `id`                     | string                                                                      | yes      |             |
| `assetIds`               | array of string                                                             | yes      |             |
| `scopeRules`             | object                                                                      | yes      |             |
| `maxIntrusiveness`       | enum: `"passive"`, `"active_safe"`, `"state_changing"`                      | yes      |             |
| `preApprovedTestClasses` | array of string                                                             | yes      |             |
| `defaultBudgets`         | object                                                                      | yes      |             |
| `testWindows`            | array of object                                                             | yes      |             |
| `validFrom`              | string (date-time)                                                          | yes      |             |
| `expiresAt`              | string (date-time)                                                          | yes      |             |
| `requesterId`            | string                                                                      | yes      |             |
| `approverId`             | string or null                                                              | yes      |             |
| `signature`              | string or null                                                              | yes      |             |
| `signingKeyId`           | string or null                                                              | yes      |             |
| `status`                 | enum: `"draft"`, `"pending_approval"`, `"active"`, `"expired"`, `"revoked"` | yes      |             |
| `revocationReason`       | string or null                                                              | yes      |             |
| `version`                | integer                                                                     | yes      |             |
| `createdAt`              | string (date-time)                                                          | yes      |             |
| `updatedAt`              | string (date-time)                                                          | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "assetIds": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
      }
    },
    "scopeRules": {
      "type": "object",
      "properties": {
        "rules": {
          "maxItems": 1000,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "effect": {
                "type": "string",
                "enum": ["include", "exclude"]
              },
              "host": {},
              "cidr": {},
              "ports": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {}
              },
              "paths": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {}
              },
              "methods": {
                "minItems": 1,
                "maxItems": 100,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT"]
                }
              }
            },
            "required": ["effect"],
            "additionalProperties": false
          }
        }
      },
      "required": ["rules"],
      "additionalProperties": false
    },
    "maxIntrusiveness": {
      "type": "string",
      "enum": ["passive", "active_safe", "state_changing"]
    },
    "preApprovedTestClasses": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "defaultBudgets": {
      "type": "object",
      "properties": {
        "costCapUsd": {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 100000
        },
        "maxRequests": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 10000000
        },
        "maxDurationMs": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 2592000000
        }
      },
      "required": ["costCapUsd", "maxRequests", "maxDurationMs"],
      "additionalProperties": false
    },
    "testWindows": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "cron": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "timezone": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "durationMs": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": ["cron", "timezone", "durationMs"],
        "additionalProperties": false
      }
    },
    "validFrom": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    },
    "expiresAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
    },
    "requesterId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "approverId": {
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
    "signature": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ]
    },
    "signingKeyId": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ]
    },
    "status": {
      "type": "string",
      "enum": ["draft", "pending_approval", "active", "expired", "revoked"]
    },
    "revocationReason": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000
        },
        {
          "type": "null"
        }
      ]
    },
    "version": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
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
    "id",
    "assetIds",
    "scopeRules",
    "maxIntrusiveness",
    "preApprovedTestClasses",
    "defaultBudgets",
    "testWindows",
    "validFrom",
    "expiresAt",
    "requesterId",
    "approverId",
    "signature",
    "signingKeyId",
    "status",
    "revocationReason",
    "version",
    "createdAt",
    "updatedAt"
  ],
  "additionalProperties": false
}
```

### SurfaceRunView

| Property      | Type                                                                                                                                                                                                                                                     | Required | Description |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `nodes`       | array of object                                                                                                                                                                                                                                          | yes      |             |
| `edges`       | array of object                                                                                                                                                                                                                                          | yes      |             |
| `totals`      | object                                                                                                                                                                                                                                                   | yes      |             |
| `truncated`   | boolean                                                                                                                                                                                                                                                  | yes      |             |
| `pageInfo`    | object                                                                                                                                                                                                                                                   | yes      |             |
| `clusteredBy` | string                                                                                                                                                                                                                                                   | yes      |             |
| `runState`    | enum: `"draft"`, `"preflight"`, `"recon"`, `"planning"`, `"awaiting_gate1"`, `"approved"`, `"executing"`, `"paused"`, `"validating"`, `"awaiting_gate3"`, `"released"`, `"reporting"`, `"completed"`, `"cancelled"`, `"killed"`, `"failed"`, `"expired"` | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "nodes": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "kind": {
            "type": "string",
            "enum": ["asset", "host", "service", "technology", "endpoint", "parameter", "role"]
          },
          "label": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "inScope": {
            "type": "boolean"
          },
          "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "degree": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "provenance": {
            "type": "object",
            "properties": {
              "runId": {
                "type": "string",
                "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
              },
              "tool": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "firstSeenAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
              },
              "lastSeenAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$"
              }
            },
            "required": ["runId", "firstSeenAt", "lastSeenAt"],
            "additionalProperties": false
          }
        },
        "required": ["id", "kind", "label", "confidence", "degree", "provenance"],
        "additionalProperties": false
      }
    },
    "edges": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": ["RESOLVES_TO", "EXPOSES", "RUNS", "SERVES", "HAS_PARAM", "CAN_ACCESS"]
          },
          "from": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "to": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          }
        },
        "required": ["kind", "from", "to"],
        "additionalProperties": false
      }
    },
    "totals": {
      "type": "object",
      "properties": {
        "nodes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "edges": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": ["nodes", "edges"],
      "additionalProperties": false
    },
    "truncated": {
      "type": "boolean"
    },
    "pageInfo": {
      "type": "object",
      "properties": {
        "endCursor": {
          "type": "string",
          "minLength": 1
        },
        "hasNextPage": {
          "type": "boolean"
        }
      },
      "required": ["hasNextPage"],
      "additionalProperties": false
    },
    "clusteredBy": {
      "type": "string",
      "const": "asset"
    },
    "runState": {
      "type": "string",
      "enum": [
        "draft",
        "preflight",
        "recon",
        "planning",
        "awaiting_gate1",
        "approved",
        "executing",
        "paused",
        "validating",
        "awaiting_gate3",
        "released",
        "reporting",
        "completed",
        "cancelled",
        "killed",
        "failed",
        "expired"
      ]
    }
  },
  "required": ["nodes", "edges", "totals", "truncated", "pageInfo", "clusteredBy", "runState"],
  "additionalProperties": false
}
```

### TenantSettings

| Property                   | Type                                 | Required | Description |
| -------------------------- | ------------------------------------ | -------- | ----------- |
| `displayTimezone`          | string                               | yes      |             |
| `defaultAssessmentMode`    | enum: `"black"`, `"grey"`, `"white"` | yes      |             |
| `defaultNotificationEmail` | string (email)                       | no       |             |
| `weekStartsOn`             | number or number                     | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "displayTimezone": {
      "default": "UTC",
      "type": "string",
      "maxLength": 64
    },
    "defaultAssessmentMode": {
      "default": "grey",
      "type": "string",
      "enum": ["black", "grey", "white"]
    },
    "defaultNotificationEmail": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "weekStartsOn": {
      "anyOf": [
        {
          "type": "number",
          "const": 0
        },
        {
          "type": "number",
          "const": 1
        }
      ]
    }
  },
  "required": ["displayTimezone", "defaultAssessmentMode"],
  "additionalProperties": false
}
```

### TenantSettingsPatch

| Property                   | Type                                 | Required | Description |
| -------------------------- | ------------------------------------ | -------- | ----------- |
| `displayTimezone`          | string                               | no       |             |
| `defaultAssessmentMode`    | enum: `"black"`, `"grey"`, `"white"` | no       |             |
| `defaultNotificationEmail` | string (email) or null               | no       |             |
| `weekStartsOn`             | number or number or null             | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "displayTimezone": {
      "type": "string",
      "maxLength": 64
    },
    "defaultAssessmentMode": {
      "type": "string",
      "enum": ["black", "grey", "white"]
    },
    "defaultNotificationEmail": {
      "anyOf": [
        {
          "type": "string",
          "format": "email",
          "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "weekStartsOn": {
      "anyOf": [
        {
          "anyOf": [
            {
              "type": "number",
              "const": 0
            },
            {
              "type": "number",
              "const": 1
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "additionalProperties": false
}
```

### TenantSettingsResponse

| Property    | Type               | Required | Description |
| ----------- | ------------------ | -------- | ----------- |
| `settings`  | object             | yes      |             |
| `region`    | string             | yes      |             |
| `updatedAt` | string (date-time) | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "settings": {
      "type": "object",
      "properties": {
        "displayTimezone": {
          "default": "UTC",
          "type": "string",
          "maxLength": 64
        },
        "defaultAssessmentMode": {
          "default": "grey",
          "type": "string",
          "enum": ["black", "grey", "white"]
        },
        "defaultNotificationEmail": {
          "type": "string",
          "format": "email",
          "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
        },
        "weekStartsOn": {
          "anyOf": [
            {
              "type": "number",
              "const": 0
            },
            {
              "type": "number",
              "const": 1
            }
          ]
        }
      },
      "required": ["displayTimezone", "defaultAssessmentMode"],
      "additionalProperties": false
    },
    "region": {
      "type": "string"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    }
  },
  "required": ["settings", "region", "updatedAt"],
  "additionalProperties": false
}
```

### TestCaseCreate

| Property          | Type                                                                    | Required | Description |
| ----------------- | ----------------------------------------------------------------------- | -------- | ----------- |
| `class`           | enum: `"passive"`, `"active_safe"`, `"state_changing"`, `"destructive"` | yes      |             |
| `title`           | string                                                                  | yes      |             |
| `refs`            | object                                                                  | yes      |             |
| `cweCandidates`   | array of string                                                         | yes      |             |
| `targets`         | array of string                                                         | yes      |             |
| `roles`           | array of string                                                         | yes      |             |
| `budget`          | object                                                                  | yes      |             |
| `oracle`          | object                                                                  | yes      |             |
| `negativeControl` | object or null                                                          | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "class": {
      "type": "string",
      "enum": ["passive", "active_safe", "state_changing", "destructive"]
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "refs": {
      "type": "object",
      "properties": {
        "owasp": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "wstg": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "asvs": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "required": ["owasp", "wstg", "asvs"],
      "additionalProperties": false
    },
    "cweCandidates": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^CWE-[1-9][0-9]{0,4}$"
      }
    },
    "targets": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      }
    },
    "roles": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120
      }
    },
    "budget": {
      "type": "object",
      "properties": {
        "maxRequests": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 10000000
        },
        "maxRps": {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 1000
        },
        "maxConcurrency": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 256
        },
        "maxBytes": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 1099511627776
        }
      },
      "required": ["maxRequests", "maxRps", "maxConcurrency", "maxBytes"],
      "additionalProperties": false
    },
    "oracle": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "minLength": 1
        },
        "params": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {}
        }
      },
      "required": ["type", "params"],
      "additionalProperties": {}
    },
    "negativeControl": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "minLength": 1
            },
            "params": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {}
            }
          },
          "required": ["type", "params"],
          "additionalProperties": {}
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "class",
    "title",
    "refs",
    "cweCandidates",
    "targets",
    "roles",
    "budget",
    "oracle",
    "negativeControl"
  ],
  "additionalProperties": false
}
```

### TestCasePatch

| Property          | Type                                                                    | Required | Description |
| ----------------- | ----------------------------------------------------------------------- | -------- | ----------- |
| `class`           | enum: `"passive"`, `"active_safe"`, `"state_changing"`, `"destructive"` | no       |             |
| `title`           | string                                                                  | no       |             |
| `refs`            | object                                                                  | no       |             |
| `cweCandidates`   | array of string                                                         | no       |             |
| `targets`         | array of string                                                         | no       |             |
| `roles`           | array of string                                                         | no       |             |
| `budget`          | object                                                                  | no       |             |
| `oracle`          | object                                                                  | no       |             |
| `negativeControl` | object or null                                                          | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "class": {
      "type": "string",
      "enum": ["passive", "active_safe", "state_changing", "destructive"]
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "refs": {
      "type": "object",
      "properties": {
        "owasp": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "wstg": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "asvs": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "required": ["owasp", "wstg", "asvs"],
      "additionalProperties": false
    },
    "cweCandidates": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^CWE-[1-9][0-9]{0,4}$"
      }
    },
    "targets": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      }
    },
    "roles": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120
      }
    },
    "budget": {
      "type": "object",
      "properties": {
        "maxRequests": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 10000000
        },
        "maxRps": {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 1000
        },
        "maxConcurrency": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 256
        },
        "maxBytes": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 1099511627776
        }
      },
      "required": ["maxRequests", "maxRps", "maxConcurrency", "maxBytes"],
      "additionalProperties": false
    },
    "oracle": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "minLength": 1
        },
        "params": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {}
        }
      },
      "required": ["type", "params"],
      "additionalProperties": {}
    },
    "negativeControl": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "minLength": 1
            },
            "params": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {}
            }
          },
          "required": ["type", "params"],
          "additionalProperties": {}
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "additionalProperties": false
}
```

### TestCaseView

| Property          | Type                                                                                                                                                     | Required | Description |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `caseId`          | string                                                                                                                                                   | yes      |             |
| `planId`          | string                                                                                                                                                   | yes      |             |
| `class`           | enum: `"passive"`, `"active_safe"`, `"state_changing"`, `"destructive"`                                                                                  | yes      |             |
| `title`           | string                                                                                                                                                   | yes      |             |
| `status`          | enum: `"proposed"`, `"approved"`, `"removed"`, `"executing"`, `"executed"`, `"skipped"`, `"blocked"`, `"failed"`, `"model_declined"`, `"not_applicable"` | yes      |             |
| `statusReason`    | any                                                                                                                                                      | yes      |             |
| `refs`            | object                                                                                                                                                   | yes      |             |
| `cweCandidates`   | array of string                                                                                                                                          | yes      |             |
| `targets`         | array of string                                                                                                                                          | yes      |             |
| `roles`           | array of string                                                                                                                                          | yes      |             |
| `budget`          | object                                                                                                                                                   | yes      |             |
| `oracle`          | object or null                                                                                                                                           | yes      |             |
| `negativeControl` | object or null                                                                                                                                           | yes      |             |
| `createdAt`       | string (date-time)                                                                                                                                       | yes      |             |
| `updatedAt`       | string (date-time)                                                                                                                                       | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "caseId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "planId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "class": {
      "type": "string",
      "enum": ["passive", "active_safe", "state_changing", "destructive"]
    },
    "title": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "proposed",
        "approved",
        "removed",
        "executing",
        "executed",
        "skipped",
        "blocked",
        "failed",
        "model_declined",
        "not_applicable"
      ]
    },
    "statusReason": {
      "type": ["string", "null"]
    },
    "refs": {
      "type": "object",
      "properties": {
        "owasp": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "wstg": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "asvs": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "required": ["owasp", "wstg", "asvs"],
      "additionalProperties": false
    },
    "cweCandidates": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "targets": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "roles": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "budget": {
      "type": "object",
      "properties": {
        "maxRequests": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 10000000
        },
        "maxRps": {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 1000
        },
        "maxConcurrency": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 256
        },
        "maxBytes": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 1099511627776
        }
      },
      "required": ["maxRequests", "maxRps", "maxConcurrency", "maxBytes"],
      "additionalProperties": false
    },
    "oracle": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "minLength": 1
            },
            "params": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {}
            }
          },
          "required": ["type", "params"],
          "additionalProperties": {}
        },
        {
          "type": "null"
        }
      ]
    },
    "negativeControl": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "minLength": 1
            },
            "params": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {}
            }
          },
          "required": ["type", "params"],
          "additionalProperties": {}
        },
        {
          "type": "null"
        }
      ]
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    }
  },
  "required": [
    "caseId",
    "planId",
    "class",
    "title",
    "status",
    "statusReason",
    "refs",
    "cweCandidates",
    "targets",
    "roles",
    "budget",
    "oracle",
    "negativeControl",
    "createdAt",
    "updatedAt"
  ],
  "additionalProperties": false
}
```

### TestPlanPage

| Property     | Type            | Required | Description |
| ------------ | --------------- | -------- | ----------- |
| `items`      | array of object | yes      |             |
| `nextCursor` | any             | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "planId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "runId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "version": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "status": {
            "type": "string",
            "enum": ["draft", "proposed", "approved", "superseded"]
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
          }
        },
        "required": ["planId", "runId", "version", "status", "createdAt", "updatedAt"],
        "additionalProperties": false
      }
    },
    "nextCursor": {
      "type": ["string", "null"]
    }
  },
  "required": ["items", "nextCursor"],
  "additionalProperties": false
}
```

### TestPlanView

| Property    | Type                                                        | Required | Description |
| ----------- | ----------------------------------------------------------- | -------- | ----------- |
| `planId`    | string                                                      | yes      |             |
| `runId`     | string                                                      | yes      |             |
| `version`   | integer                                                     | yes      |             |
| `status`    | enum: `"draft"`, `"proposed"`, `"approved"`, `"superseded"` | yes      |             |
| `createdAt` | string (date-time)                                          | yes      |             |
| `updatedAt` | string (date-time)                                          | yes      |             |
| `cases`     | array of object                                             | yes      |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "planId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "runId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "version": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "status": {
      "type": "string",
      "enum": ["draft", "proposed", "approved", "superseded"]
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    },
    "cases": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "caseId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "planId": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "class": {
            "type": "string",
            "enum": ["passive", "active_safe", "state_changing", "destructive"]
          },
          "title": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "proposed",
              "approved",
              "removed",
              "executing",
              "executed",
              "skipped",
              "blocked",
              "failed",
              "model_declined",
              "not_applicable"
            ]
          },
          "statusReason": {
            "type": ["string", "null"]
          },
          "refs": {
            "type": "object",
            "properties": {
              "owasp": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "wstg": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "asvs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              }
            },
            "required": ["owasp", "wstg", "asvs"],
            "additionalProperties": false
          },
          "cweCandidates": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "targets": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "roles": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "budget": {
            "type": "object",
            "properties": {
              "maxRequests": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 10000000
              },
              "maxRps": {
                "type": "number",
                "exclusiveMinimum": 0,
                "maximum": 1000
              },
              "maxConcurrency": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 256
              },
              "maxBytes": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 1099511627776
              }
            },
            "required": ["maxRequests", "maxRps", "maxConcurrency", "maxBytes"],
            "additionalProperties": false
          },
          "oracle": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "minLength": 1
                  },
                  "params": {
                    "type": "object",
                    "propertyNames": {
                      "type": "string"
                    },
                    "additionalProperties": {}
                  }
                },
                "required": ["type", "params"],
                "additionalProperties": {}
              },
              {
                "type": "null"
              }
            ]
          },
          "negativeControl": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "minLength": 1
                  },
                  "params": {
                    "type": "object",
                    "propertyNames": {
                      "type": "string"
                    },
                    "additionalProperties": {}
                  }
                },
                "required": ["type", "params"],
                "additionalProperties": {}
              },
              {
                "type": "null"
              }
            ]
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
          }
        },
        "required": [
          "caseId",
          "planId",
          "class",
          "title",
          "status",
          "statusReason",
          "refs",
          "cweCandidates",
          "targets",
          "roles",
          "budget",
          "oracle",
          "negativeControl",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": ["planId", "runId", "version", "status", "createdAt", "updatedAt", "cases"],
  "additionalProperties": false
}
```

### UpdateAssetBody

| Property      | Type                                           | Required | Description |
| ------------- | ---------------------------------------------- | -------- | ----------- |
| `name`        | string                                         | no       |             |
| `identifiers` | array of object                                | no       |             |
| `environment` | enum: `"prod"`, `"staging"`, `"dev"`, `"test"` | no       |             |
| `ownerUserId` | string                                         | no       |             |

Full schema:

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "identifiers": {
      "minItems": 1,
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": ["host", "url", "cidr", "repo"]
          },
          "value": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2048
          }
        },
        "required": ["kind", "value"],
        "additionalProperties": false
      }
    },
    "environment": {
      "type": "string",
      "enum": ["prod", "staging", "dev", "test"]
    },
    "ownerUserId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "additionalProperties": false
}
```
