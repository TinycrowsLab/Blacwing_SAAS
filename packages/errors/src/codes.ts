/**
 * The error-code registry: the single source of truth for every stable `code`, its HTTP status,
 * its English (v1) problem title and whether the failure is worth retrying unchanged.
 *
 * The `ErrorCode` union, the status mapper and the problem+json `type` URI are all derived from this
 * one object, so a code cannot exist without a status and a title. Codes are public API: they appear
 * in problem+json bodies, audit events and client code. Never rename or reuse one; add a new code
 * instead. Each epic adds its domain-specific `AppError` subclasses on top of these codes.
 */

/** What the registry records for one code. */
export interface ErrorCodeSpec {
  /** HTTP status the API answers with. */
  readonly status: number;
  /** Short, human-readable summary of the problem type (RFC 9457 `title`). English in v1. */
  readonly title: string;
  /** Default for `AppError.retryable`: may the same request succeed if repeated unchanged later? */
  readonly retryable: boolean;
}

const DEFINITIONS = {
  VALIDATION_FAILED: { status: 422, title: 'Validation failed', retryable: false },
  // A cursor that is malformed, forged, or issued for other filters (audit query API, #86). Never retried as is.
  INVALID_CURSOR: { status: 400, title: 'Invalid cursor', retryable: false },
  // A list or graph query whose parameters fail validation (unknown filter value, limit over the cap). Never retried as is.
  INVALID_QUERY: { status: 400, title: 'Invalid query', retryable: false },
  UNAUTHENTICATED: { status: 401, title: 'Authentication required', retryable: false },
  // Authentication of an API request (the global auth guard, #335): no credential presented, a credential
  // that does not verify (signature, issuer, audience, algorithm, claims, or an unknown session), and a
  // credential or session that has expired. Never reuse these codes for another meaning.
  AUTH_NO_CREDENTIALS: { status: 401, title: 'No credentials presented', retryable: false },
  AUTH_INVALID_TOKEN: { status: 401, title: 'Invalid credentials', retryable: false },
  AUTH_EXPIRED: { status: 401, title: 'Credentials expired', retryable: false },
  FORBIDDEN: { status: 403, title: 'Forbidden', retryable: false },
  NOT_FOUND: { status: 404, title: 'Resource not found', retryable: false },
  CONFLICT: { status: 409, title: 'Conflict', retryable: false },
  PRECONDITION_FAILED: { status: 412, title: 'Precondition failed', retryable: false },
  PRECONDITION_REQUIRED: { status: 428, title: 'Precondition required', retryable: false },
  RATE_LIMITED: { status: 429, title: 'Too many requests', retryable: true },
  ILLEGAL_RUN_TRANSITION: { status: 409, title: 'Illegal run state transition', retryable: false },
  // Evidence binding (EVIDENCE, #724): a missing, altered or out-of-chain evidence item. The finding is Suspected.
  EVIDENCE_INTEGRITY_FAILED: {
    status: 422,
    title: 'Evidence integrity check failed',
    retryable: false,
  },
  // Gate 1 (test plan approval, #877) refusals. The requester's refusal reuses SOD_VIOLATION (F31, below).
  // Gate 1 decision refused because the run is no longer waiting at Gate 1 (already decided or moved on).
  GATE1_NOT_PENDING: { status: 409, title: 'Approval gate is no longer pending', retryable: false },
  // The decision named a plan version other than the current one: the plan changed after it was loaded.
  GATE1_PLAN_STALE: {
    status: 409,
    title: 'Test plan changed since it was loaded',
    retryable: false,
  },
  // The Gate 1 approval window closed before the decision; a late approval is never recorded.
  GATE1_EXPIRED: { status: 409, title: 'Approval window expired', retryable: false },
  // A request that reaches a tenant-scoped path without a resolvable tenant context is refused outright
  // (§7/§8.6 fail closed, TENANT-003): 403, never retried, never served without isolation. A caller with no
  // principal at all is `UNAUTHENTICATED` (401) before this can happen.
  TENANT_CONTEXT_MISSING: { status: 403, title: 'Tenant context missing', retryable: false },
  // A resource whose tenant differs from the context tenant (TENANT-003, §8.6): denied and audited.
  CROSS_TENANT_DENIED: { status: 403, title: 'Cross tenant access denied', retryable: false },
  // withTenant/withSystem (DB-004). Nesting a different tenant context is a programming defect (500,
  // never retried: no silent re-scoping). A transaction that keeps hitting serialization failures or
  // deadlocks is a transient overload (503, retryable).
  TENANT_CONTEXT_CONFLICT: { status: 500, title: 'Tenant context conflict', retryable: false },
  TX_RETRY_EXHAUSTED: { status: 503, title: 'Transaction retries exhausted', retryable: true },
  // db:seed refuses to run outside development and test (DEVENV-011, #75). A dev-only CLI refusal.
  SEED_FORBIDDEN_IN_PROD: {
    status: 403,
    title: 'Seeding forbidden in this environment',
    retryable: false,
  },
  // Durable-execution tenant context (#25, §8.6). A workflow, activity or client call without a
  // valid tenant header is a server defect and is refused outright (500, fail closed); a signal, query or
  // update that names another tenant than the running workflow is a cross-tenant attempt (403).
  MISSING_TENANT_CONTEXT: { status: 500, title: 'Missing tenant context', retryable: false },
  INVALID_TENANT_CONTEXT: { status: 500, title: 'Invalid tenant context', retryable: false },
  TENANT_CONTEXT_MISMATCH: { status: 403, title: 'Tenant context mismatch', retryable: false },
  KILL_SWITCH_ACTIVE: { status: 423, title: 'Kill switch active', retryable: false },
  SCOPE_VIOLATION: { status: 403, title: 'Out of authorised scope', retryable: false },
  // Intrusiveness-class validation (SCOPE-003, §3.5/§8.3). Exceeding a ceiling or naming
  // `destructive` as a ceiling is a refusal of an authorised-scope boundary (403); an unknown class
  // string is malformed input (422).
  SCOPE_INTRUSIVENESS_EXCEEDS_CEILING: {
    status: 403,
    title: 'Intrusiveness exceeds the authorised ceiling',
    retryable: false,
  },
  SCOPE_DESTRUCTIVE_FORBIDDEN: {
    status: 403,
    title: 'Destructive intrusiveness is forbidden',
    retryable: false,
  },
  SCOPE_INVALID_CLASS: { status: 422, title: 'Invalid intrusiveness class', retryable: false },
  // Request-budget validation (SCOPE-004, F5). A malformed or absurd budget is invalid input (422);
  // a budget above the standing authorisation's defaults is an authorised-scope refusal (403).
  SCOPE_INVALID_BUDGET: { status: 422, title: 'Invalid request budget', retryable: false },
  // Malformed scope rule (SCOPE-002, #566): invalid input, rejected at parse time.
  SCOPE_INVALID_RULE: { status: 422, title: 'Invalid scope rule', retryable: false },
  SCOPE_BUDGET_EXCEEDS_SA: {
    status: 403,
    title: 'Budget exceeds the standing authorisation',
    retryable: false,
  },
  // Standing-authorisation state machine (AUTHZ-001, §8.1). A transition the SA lifecycle does not allow
  // is a conflict with the current state (409); a window that does not end after it starts is invalid input (422).
  AUTHZ_ILLEGAL_TRANSITION: {
    status: 409,
    title: 'Illegal standing authorisation transition',
    retryable: false,
  },
  AUTHZ_INVALID_WINDOW: {
    status: 422,
    title: 'Invalid standing authorisation window',
    retryable: false,
  },
  // Standing-authorisation API (AUTHZ-002): only a draft can be edited, and a submitted SA needs verified assets.
  AUTHZ_NOT_DRAFT: {
    status: 409,
    title: 'Standing authorisation is not a draft',
    retryable: false,
  },
  AUTHZ_ASSET_UNVERIFIED: {
    status: 422,
    title: 'Asset is not verified for this tenant',
    retryable: false,
  },
  // Standing-authorisation approval (AUTHZ-008, #380): the approver is the requester, or lacks the approver role
  // (separation of duties, §8.4). A refusal of an authorisation boundary (403), never retried unchanged.
  AUTHZ_SOD_VIOLATION: {
    status: 403,
    title: 'Separation of duties violated for the standing authorisation',
    retryable: false,
  },
  // Step-up (AUTHZ-008, #380): approval needs a fresh strong authentication. The client re-authenticates and retries.
  AUTHZ_STEPUP_REQUIRED: {
    status: 401,
    title: 'Step up authentication required',
    retryable: false,
  },
  // Persona-definition validation (REGISTRY-001, §4.5/§8.11). Malformed or forbidden definitions are
  // rejected at load/CI time: invalid input (422); a persona that is not registered yet is 404.
  PERSONA_UNKNOWN: { status: 422, title: 'Unknown persona', retryable: false },
  PERSONA_NOT_DEFINED: { status: 404, title: 'Persona not defined', retryable: false },
  PERSONA_FORBIDDEN_TOOL: { status: 422, title: 'Forbidden tool in persona', retryable: false },
  PERSONA_INVALID: { status: 422, title: 'Invalid persona definition', retryable: false },
  // Persona override whitelist (REGISTRY-010, §8.11): a tenant may set only the whitelisted fields. A field
  // outside the whitelist (tools, intrusiveness ceiling, model map) is a refusal of a safety boundary (403).
  OVERRIDE_FIELD_FORBIDDEN: {
    status: 403,
    title: 'Persona override field not permitted',
    retryable: false,
  },
  // Model-tier resolution (REGISTRY-003, §8.9): a provider/model outside the gateway allowlist is refused.
  MODEL_NOT_ALLOWED: { status: 403, title: 'Model not allowed', retryable: false },
  // `@blackwing/config` (FOUND-007) refuses to start on an invalid environment: a server fault.
  // Envelope encryption (SECRETS-002, §8.6/§8.7). Every failure fails closed: a tenant/purpose mismatch
  // is a refusal (403); a shredded KEK version is permanent (409).
  AAD_MISMATCH: { status: 403, title: 'Secret context mismatch', retryable: false },
  SECRET_TOO_LARGE: { status: 413, title: 'Secret too large', retryable: false },
  KEK_DISABLED: { status: 409, title: 'Key version disabled', retryable: false },
  ENVELOPE_INVALID: { status: 422, title: 'Invalid secret envelope', retryable: false },
  SECRET_DECRYPT_FAILED: { status: 500, title: 'Secret decryption failed', retryable: false },
  // Prompt registry (REGISTRY-002, §8.9): a prompt that fails its pinned hash is never served.
  PROMPT_INVALID: { status: 422, title: 'Invalid prompt file', retryable: false },
  PROMPT_HASH_MISMATCH: { status: 500, title: 'Prompt hash mismatch', retryable: false },
  PROMPT_NO_RELEASED_VERSION: {
    status: 404,
    title: 'No released prompt version',
    retryable: false,
  },
  PROMPT_DRAFT_FORBIDDEN: {
    status: 403,
    title: 'Draft prompt forbidden in production',
    retryable: false,
  },
  // Prompt composition (REGISTRY-004, §4.5/§8.9): an incomplete or oversized prompt never starts a session.
  PROMPT_PLACEHOLDER_MISSING: {
    status: 422,
    title: 'Prompt placeholder unfilled',
    retryable: false,
  },
  PROMPT_TOO_LARGE: { status: 413, title: 'Composed prompt too large', retryable: false },
  // Agent session descriptor (RUNTIME-001, #463): a brief over 256 KiB is refused before any model call.
  AGENT_BRIEF_TOO_LARGE: { status: 413, title: 'Agent brief too large', retryable: false },
  // Agent session options (RUNTIME-002, #464): every refusal fails closed before a session starts.
  AGENT_UNKNOWN_PERSONA: { status: 422, title: 'Unknown agent persona', retryable: false },
  AGENT_FORBIDDEN_PERMISSION_MODE: {
    status: 500,
    title: 'Forbidden agent permission mode',
    retryable: false,
  },
  AGENT_NO_VIRTUAL_KEY: { status: 503, title: 'Agent virtual key unavailable', retryable: false },
  AGENT_MCP_SERVER_MISSING: {
    status: 500,
    title: 'Agent MCP server not provided',
    retryable: false,
  },
  AGENT_BUDGET_EXHAUSTED: {
    status: 402,
    title: 'Agent session budget exhausted',
    retryable: false,
  },
  // `secret_ref` URI grammar (SECRETS-003, §8.7): a malformed reference is invalid input, rejected at parse time.
  INVALID_SECRET_REF: { status: 422, title: 'Invalid secret reference', retryable: false },
  CONFIG_INVALID: { status: 500, title: 'Invalid configuration', retryable: false },
  // Temporal connection (WORKFLOW-001). Misconfiguration is a server fault (500, never retried);
  // an unreachable server is a dependency outage (503, retryable).
  TEMPORAL_CONFIG_INVALID: {
    status: 500,
    title: 'Invalid Temporal configuration',
    retryable: false,
  },
  TEMPORAL_TLS_MISCONFIGURED: {
    status: 500,
    title: 'Temporal TLS misconfigured',
    retryable: false,
  },
  TEMPORAL_NAMESPACE_NOT_FOUND: {
    status: 500,
    title: 'Temporal namespace not found',
    retryable: false,
  },
  TEMPORAL_UNAVAILABLE: { status: 503, title: 'Temporal unavailable', retryable: true },
  // PostgreSQL connection (DB-001): no pooled connection within the acquire timeout, or the server is
  // unreachable. A dependency outage (503, retryable); query errors keep their own codes.
  DB_UNAVAILABLE: { status: 503, title: 'Database unavailable', retryable: true },
  // Query guardrails (DB-007): a statement past DB_STATEMENT_TIMEOUT_MS is cancelled by Postgres (504; the
  // same statement on the same data times out again, so not retryable). A serialization failure or deadlock
  // (40001/40P01) is a conflict with a concurrent transaction: 409, retryable (withTenant re-runs it, DB-006).
  DB_QUERY_TIMEOUT: { status: 504, title: 'Database query timed out', retryable: false },
  DB_SERIALIZATION_CONFLICT: {
    status: 409,
    title: 'Database serialization conflict',
    retryable: true,
  },
  // Worker bootstrap (WORKFLOW-002): a misconfigured process refuses to start rather than polling a guess.
  WORKER_QUEUE_UNKNOWN: { status: 500, title: 'Unknown worker task queue', retryable: false },
  // Temporal search attributes (WORKFLOW-003). A registered attribute of another type is never dropped or
  // retyped: the namespace is misconfigured, a server fault (500, never retried until an operator fixes it).
  SEARCH_ATTR_TYPE_CONFLICT: {
    status: 500,
    title: 'Search attribute type conflict',
    retryable: false,
  },
  // Sandbox controller (SANDBOX-001, #448). Its internal API refuses callers without a valid
  // run-scoped token (401, fail closed); a bad body is refused before any processing (400); a bad
  // environment stops the process (500); an unreachable driver or Valkey is an outage (503).
  SBX_UNAUTHENTICATED: { status: 401, title: 'Run token required', retryable: false },
  SBX_BAD_REQUEST: { status: 400, title: 'Malformed request', retryable: false },
  SBX_CONFIG_INVALID: {
    status: 500,
    title: 'Invalid sandbox controller configuration',
    retryable: false,
  },
  SBX_DRIVER_UNAVAILABLE: { status: 503, title: 'Sandbox driver unavailable', retryable: true },
  // DockerDriver (SANDBOX-004): no registered runsc runtime (never fall back to runc); pinned image absent.
  SBX_RUNTIME_MISSING: { status: 500, title: 'Sandbox runtime missing', retryable: false },
  SBX_IMAGE_MISSING: { status: 422, title: 'Sandbox image missing', retryable: false },
  // Kill trigger API (KILL-003, F33/§8.5). Malformed scope input is 422; refusing the caller is 403;
  // `global` is an operator-only path (KILL-013), so the tenant endpoint refuses it with its own code.
  KILL_SCOPE_INVALID: { status: 422, title: 'Invalid kill scope', retryable: false },
  KILL_REF_REQUIRED: { status: 422, title: 'Kill scope reference required', retryable: false },
  KILL_FORBIDDEN: { status: 403, title: 'Kill not permitted', retryable: false },
  KILL_GLOBAL_NOT_ALLOWED_HERE: {
    status: 403,
    title: 'Global kill is not allowed on this endpoint',
    retryable: false,
  },
  // Operator global/tenant kill (KILL-013 / OPSUI kill control, F33/§1.2/§8.5). A caller who is not the
  // platform operator is refused (403). A kill for a scope that already has an open one answers 409 and
  // never starts a second. A kill that ended with some component still running is 424: surfaced, never
  // reported as a success.
  NOT_OPERATOR: { status: 403, title: 'Platform operator required', retryable: false },
  // The platform-operator session has not completed the operator second factor (acr operator_strong, #838).
  OPERATOR_MFA_REQUIRED: { status: 403, title: 'Operator MFA required', retryable: false },
  KILL_ALREADY_IN_PROGRESS: { status: 409, title: 'Kill already in progress', retryable: false },
  KILL_PARTIAL: { status: 424, title: 'Kill only partly completed', retryable: false },
  // Idempotency-Key handling (§9): a missing key on a creating POST is a malformed request (400);
  // reusing a key with a different body is refused (422) instead of replaying the wrong result.
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, title: 'Idempotency key required', retryable: false },
  IDEMPOTENCY_KEY_MISMATCH: {
    status: 422,
    title: 'Idempotency key reused with a different request',
    retryable: false,
  },
  // Self-service signup (TENANT-004): an unknown, expired, already used or cancelled verification token.
  // One code and one status for all four, so the response cannot tell a guesser which one it was.
  SIGNUP_TOKEN_INVALID: { status: 400, title: 'Signup token invalid or expired', retryable: false },
  // On-call roster (GATE2-003, F13/F31, §8.4). No roster, or nobody on call at the instant, is a run
  // configuration error (422) surfaced at preflight; a roster whose every reachable member is
  // separation-of-duties ineligible is a conflict (409) that GATE2-004 turns into an operator pause and,
  // on timeout, a deny. Neither is ever read as "allow".
  GATE2_NO_ONCALL_CONFIGURED: { status: 422, title: 'No on call configured', retryable: false },
  GATE2_NO_ELIGIBLE_APPROVER: { status: 409, title: 'No eligible approver', retryable: false },
  // Run Broker API (API-014, #66). A stub endpoint owned by a later epic answers 501; a broker write for
  // a run that is no longer active is refused with 409 (the run is terminal, §3.3).
  NOT_IMPLEMENTED: { status: 501, title: 'Not implemented', retryable: false },
  RUN_NOT_ACTIVE: { status: 409, title: 'Run is not active', retryable: false },
  // An engagement status change the test-case state machine does not allow (MCP-012, #677). Never retried.
  INVALID_TRANSITION: { status: 409, title: 'Invalid status transition', retryable: false },
  // A run that does not exist in the caller's tenant. Uniform for missing and foreign runs (no existence oracle, §8.6).
  RUN_NOT_FOUND: { status: 404, title: 'Run not found', retryable: false },
  // Audit emission (AUDIT-003, #82): an event that fails AuditEventSchema is refused at the helper's
  // boundary. The producer is at fault, so it is never retried unchanged.
  AUDIT_EVENT_INVALID: { status: 422, title: 'Invalid audit event', retryable: false },
  // Per-tenant KEK (SECRETS-001): OpenBao sealed, unreachable or the AppRole login failed. Fail closed:
  // no shared-key fallback; the caller retries later.
  KEK_UNAVAILABLE: { status: 503, title: 'Tenant key unavailable', retryable: true },
  // Internal secret resolve API (SECRETS-006, §8.6/§8.7/§8.8). Every refusal fails closed and names only the
  // coarse reason: an unknown or revoked service identity (401), a tenant that does not match the run or
  // the reference (403), a service asking for a purpose outside its matrix (403), a secret that is gone or
  // switched off (404/410/409), a killed or inactive run (423/409) and an unreachable customer-owned store (503).
  SERVICE_AUTH_FAILED: { status: 401, title: 'Service authentication failed', retryable: false },
  TENANT_MISMATCH: { status: 403, title: 'Tenant mismatch', retryable: false },
  SECRET_PURPOSE_DENIED: { status: 403, title: 'Secret purpose not permitted', retryable: false },
  SECRET_NOT_FOUND: { status: 404, title: 'Secret not found', retryable: false },
  SECRET_DISABLED: { status: 409, title: 'Secret disabled', retryable: false },
  SECRET_SHREDDED: { status: 410, title: 'Secret shredded', retryable: false },
  // A pinned `?v=` version whose rotation grace period ended (SECRETS-012). Pinned consumers must move to
  // the current version (drop `?v=`) or re-pin to the version that is current now.
  SECRET_VERSION_RETIRED: { status: 410, title: 'Secret version retired', retryable: false },
  RUN_KILLED: { status: 423, title: 'Run killed', retryable: false },
  // Asset API (ASSET-002, #355). A PATCH whose If-Match ETag is stale, or a delete of an asset that an active
  // standing authorisation still covers.
  ASSET_STALE_WRITE: { status: 409, title: 'Stale asset write', retryable: false },
  ASSET_IN_USE: { status: 409, title: 'Asset in use', retryable: false },
  ASSET_INVALID_IDENTIFIER: { status: 422, title: 'Invalid asset identifier', retryable: false },
  EXTERNAL_BACKEND_UNAVAILABLE: {
    status: 503,
    title: 'External secret backend unavailable',
    retryable: true,
  },
  // Neo4j driver (GRAPH-001, §5/§8.6). Missing or invalid graph config is a deployment defect, caught at boot
  // (fail fast, 500). A saturated connection pool past its acquire timeout is a transient overload (503, retryable).
  GRAPH_CONFIG_MISSING: { status: 500, title: 'Graph configuration missing', retryable: false },
  GRAPH_POOL_TIMEOUT: { status: 503, title: 'Graph connection pool timed out', retryable: true },
  // Surface-graph migrations (GRAPH-002). A ledger that disagrees with the files is a deployment defect (500, never
  // retried). Another run holding the migration lock is transient (503, retryable). A malformed migration file is a
  // build defect (500).
  GRAPH_MIGRATION_DRIFT: { status: 500, title: 'Graph migration drift detected', retryable: false },
  GRAPH_MIGRATION_LOCKED: {
    status: 503,
    title: 'Graph migration already running',
    retryable: true,
  },
  GRAPH_MIGRATION_INVALID: { status: 500, title: 'Graph migration file invalid', retryable: false },
  // Surface-graph repository (GRAPH-004, §8.6). A graph access without a tenant context, or with a tenant id that
  // differs from it, fails closed (403, never retried). A Cypher template that does not bind $tenantId is a code
  // defect (500). A failing query is a permanent server fault (500); a transient one that the driver gave up on
  // after its retries is an outage (503, retryable).
  GRAPH_NO_TENANT_CONTEXT: { status: 403, title: 'Graph tenant context missing', retryable: false },
  GRAPH_TENANT_MISMATCH: { status: 403, title: 'Graph tenant mismatch', retryable: false },
  GRAPH_UNSCOPED_QUERY: {
    status: 500,
    title: 'Graph query is not tenant scoped',
    retryable: false,
  },
  GRAPH_QUERY_FAILED: { status: 500, title: 'Graph query failed', retryable: false },
  GRAPH_QUERY_UNAVAILABLE: { status: 503, title: 'Graph query unavailable', retryable: true },
  // Keycloak Admin API (IAM-002). An unreachable or overloaded Keycloak is an outage (503, retryable). A refused
  // credential or permission, a request Keycloak rejects and an unexpected response are server faults (500, never
  // retried unchanged). A missing resource (404) and a duplicate (409) keep their meaning.
  KEYCLOAK_UNAVAILABLE: { status: 503, title: 'Identity provider unavailable', retryable: true },
  KEYCLOAK_REJECTED: {
    status: 500,
    title: 'Identity provider rejected the admin request',
    retryable: false,
  },
  KEYCLOAK_NOT_FOUND: {
    status: 404,
    title: 'Identity provider resource not found',
    retryable: false,
  },
  KEYCLOAK_CONFLICT: { status: 409, title: 'Identity provider conflict', retryable: false },
  // Separation of duties (F31, CONTEXT_PACK §8.4, #352). A requester approving their own request, too few distinct
  // approvers, an approver outside the eligible roles, or a missing actor (fail closed). A refusal of an authorisation
  // boundary (403), never retried unchanged. The error class lives in @blackwing/domain/sod.
  SOD_VIOLATION: { status: 403, title: 'Separation of duties violated', retryable: false },
  // CVSS scoring (FINDING-005, #743): a stored score, severity or nomenclature that does not follow from its vector.
  // The write is refused (fail closed); the vector and score are never silently recomputed and stored.
  CVSS_VECTOR_SCORE_MISMATCH: {
    status: 422,
    title: 'CVSS score does not match its vector',
    retryable: false,
  },
  // Standing-authorisation signing (AUTHZ-004, #376): OpenBao Transit unreachable or unusable. Fail closed:
  // the SA stays pending and nothing is signed or persisted, so the caller retries later.
  AUTHZ_SIGNER_UNAVAILABLE: {
    status: 503,
    title: 'Authorisation signer unavailable',
    retryable: true,
  },
  // Test plans (PLAN-005, #395, §9). An id outside the caller's tenant is indistinguishable from a missing
  // one (404). Editing an approved version is refused (409) and the client forks a new version. An If-Match
  // that no longer names the current state is 412 with its own code; a payload over the 8 KiB ceiling is 413.
  PLAN_NOT_FOUND: { status: 404, title: 'Test plan not found', retryable: false },
  TEST_CASE_NOT_FOUND: { status: 404, title: 'Test case not found', retryable: false },
  PLAN_VERSION_IMMUTABLE: {
    status: 409,
    title: 'Approved test plan version is immutable',
    retryable: false,
  },
  ETAG_MISMATCH: { status: 412, title: 'ETag mismatch', retryable: false },
  PLAN_PAYLOAD_TOO_LARGE: { status: 413, title: 'Test plan payload too large', retryable: false },
  INTERNAL: { status: 500, title: 'Internal server error', retryable: false },
} as const satisfies Record<string, ErrorCodeSpec>;

/** Every stable machine-readable error code. */
export type ErrorCode = keyof typeof DEFINITIONS;

/** HTTP status for a given code, as a literal type (`HttpStatusOf<"NOT_FOUND">` is `404`). */
export type HttpStatusOf<C extends ErrorCode> = (typeof DEFINITIONS)[C]['status'];

function freezeRegistry<T extends Record<string, ErrorCodeSpec>>(registry: T): Readonly<T> {
  for (const spec of Object.values(registry)) Object.freeze(spec);
  return Object.freeze(registry);
}

/** The frozen registry: `ERROR_CODES.NOT_FOUND.status === 404`. */
export const ERROR_CODES: Readonly<typeof DEFINITIONS> = freezeRegistry(DEFINITIONS);

/** Every code, in registry order. */
export const ERROR_CODE_LIST: readonly ErrorCode[] = Object.freeze(
  Object.keys(ERROR_CODES) as ErrorCode[],
);

/** Base of every problem `type` URI. The code is appended verbatim. */
export const PROBLEM_TYPE_BASE = 'https://errors.blackwing.dev/';

/** Type guard: is `value` a registered code? Uses own properties only (never the prototype chain). */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);
}

/** The HTTP status mapped to `code`. */
export function httpStatusFor<C extends ErrorCode>(code: C): HttpStatusOf<C> {
  return ERROR_CODES[code].status;
}

/** The problem+json `type` URI for `code`: `https://errors.blackwing.dev/<code>`. */
export function problemTypeFor(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}${code}`;
}
