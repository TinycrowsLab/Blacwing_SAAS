import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ERROR_CODE_LIST,
  ERROR_CODES,
  type ErrorCode,
  httpStatusFor,
  type HttpStatusOf,
  isErrorCode,
  PROBLEM_TYPE_BASE,
  problemTypeFor,
} from './codes.js';

/**
 * The registry as FOUND-009 (detailed requirement 2) specifies it. This table is written out by hand
 * on purpose: it is the contract, and the registry must match it exactly.
 */
const EXPECTED_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 422,
  INVALID_CURSOR: 400,
  INVALID_QUERY: 400,
  UNAUTHENTICATED: 401,
  AUTH_NO_CREDENTIALS: 401,
  AUTH_INVALID_TOKEN: 401,
  AUTH_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PRECONDITION_REQUIRED: 428,
  RATE_LIMITED: 429,
  ILLEGAL_RUN_TRANSITION: 409,
  EVIDENCE_INTEGRITY_FAILED: 422,
  GATE1_NOT_PENDING: 409,
  GATE1_PLAN_STALE: 409,
  GATE1_EXPIRED: 409,
  TENANT_CONTEXT_MISSING: 403,
  CROSS_TENANT_DENIED: 403,
  TENANT_CONTEXT_CONFLICT: 500,
  TX_RETRY_EXHAUSTED: 503,
  MISSING_TENANT_CONTEXT: 500,
  INVALID_TENANT_CONTEXT: 500,
  TENANT_CONTEXT_MISMATCH: 403,
  KILL_SWITCH_ACTIVE: 423,
  SCOPE_VIOLATION: 403,
  SCOPE_INTRUSIVENESS_EXCEEDS_CEILING: 403,
  SCOPE_DESTRUCTIVE_FORBIDDEN: 403,
  SCOPE_INVALID_CLASS: 422,
  SCOPE_INVALID_BUDGET: 422,
  PLAN_NOT_FOUND: 404,
  TEST_CASE_NOT_FOUND: 404,
  PLAN_VERSION_IMMUTABLE: 409,
  ETAG_MISMATCH: 412,
  PLAN_PAYLOAD_TOO_LARGE: 413,
  SCOPE_INVALID_RULE: 422,
  INVALID_SECRET_REF: 422,
  SCOPE_BUDGET_EXCEEDS_SA: 403,
  AUTHZ_ILLEGAL_TRANSITION: 409,
  AUTHZ_INVALID_WINDOW: 422,
  AUTHZ_NOT_DRAFT: 409,
  AUTHZ_ASSET_UNVERIFIED: 422,
  AUTHZ_SOD_VIOLATION: 403,
  AUTHZ_STEPUP_REQUIRED: 401,
  ASSET_STALE_WRITE: 409,
  ASSET_IN_USE: 409,
  ASSET_INVALID_IDENTIFIER: 422,
  PERSONA_UNKNOWN: 422,
  PERSONA_NOT_DEFINED: 404,
  PERSONA_FORBIDDEN_TOOL: 422,
  PERSONA_INVALID: 422,
  OVERRIDE_FIELD_FORBIDDEN: 403,
  MODEL_NOT_ALLOWED: 403,
  PROMPT_INVALID: 422,
  PROMPT_HASH_MISMATCH: 500,
  AAD_MISMATCH: 403,
  SECRET_TOO_LARGE: 413,
  KEK_DISABLED: 409,
  ENVELOPE_INVALID: 422,
  SECRET_DECRYPT_FAILED: 500,
  PROMPT_NO_RELEASED_VERSION: 404,
  PROMPT_DRAFT_FORBIDDEN: 403,
  PROMPT_PLACEHOLDER_MISSING: 422,
  PROMPT_TOO_LARGE: 413,
  AGENT_BRIEF_TOO_LARGE: 413,
  AGENT_UNKNOWN_PERSONA: 422,
  AGENT_FORBIDDEN_PERMISSION_MODE: 500,
  AGENT_NO_VIRTUAL_KEY: 503,
  AGENT_MCP_SERVER_MISSING: 500,
  AGENT_BUDGET_EXHAUSTED: 402,
  CONFIG_INVALID: 500,
  TEMPORAL_CONFIG_INVALID: 500,
  TEMPORAL_TLS_MISCONFIGURED: 500,
  TEMPORAL_NAMESPACE_NOT_FOUND: 500,
  TEMPORAL_UNAVAILABLE: 503,
  DB_UNAVAILABLE: 503,
  DB_QUERY_TIMEOUT: 504,
  DB_SERIALIZATION_CONFLICT: 409,
  WORKER_QUEUE_UNKNOWN: 500,
  SEARCH_ATTR_TYPE_CONFLICT: 500,
  SBX_UNAUTHENTICATED: 401,
  SBX_BAD_REQUEST: 400,
  SBX_CONFIG_INVALID: 500,
  SBX_DRIVER_UNAVAILABLE: 503,
  SBX_RUNTIME_MISSING: 500,
  SBX_IMAGE_MISSING: 422,
  KILL_SCOPE_INVALID: 422,
  KILL_REF_REQUIRED: 422,
  KILL_FORBIDDEN: 403,
  SEED_FORBIDDEN_IN_PROD: 403,
  KILL_GLOBAL_NOT_ALLOWED_HERE: 403,
  NOT_OPERATOR: 403,
  OPERATOR_MFA_REQUIRED: 403,
  KILL_ALREADY_IN_PROGRESS: 409,
  KILL_PARTIAL: 424,
  GATE2_NO_ONCALL_CONFIGURED: 422,
  GATE2_NO_ELIGIBLE_APPROVER: 409,
  NOT_IMPLEMENTED: 501,
  RUN_NOT_ACTIVE: 409,
  INVALID_TRANSITION: 409,
  RUN_NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_MISMATCH: 422,
  SIGNUP_TOKEN_INVALID: 400,
  AUDIT_EVENT_INVALID: 422,
  KEK_UNAVAILABLE: 503,
  SERVICE_AUTH_FAILED: 401,
  TENANT_MISMATCH: 403,
  SECRET_PURPOSE_DENIED: 403,
  SECRET_NOT_FOUND: 404,
  SECRET_DISABLED: 409,
  SECRET_SHREDDED: 410,
  SECRET_VERSION_RETIRED: 410,
  RUN_KILLED: 423,
  EXTERNAL_BACKEND_UNAVAILABLE: 503,
  AUTHZ_SIGNER_UNAVAILABLE: 503,
  GRAPH_CONFIG_MISSING: 500,
  GRAPH_POOL_TIMEOUT: 503,
  GRAPH_MIGRATION_DRIFT: 500,
  GRAPH_MIGRATION_LOCKED: 503,
  GRAPH_MIGRATION_INVALID: 500,
  GRAPH_NO_TENANT_CONTEXT: 403,
  GRAPH_TENANT_MISMATCH: 403,
  GRAPH_UNSCOPED_QUERY: 500,
  GRAPH_QUERY_FAILED: 500,
  GRAPH_QUERY_UNAVAILABLE: 503,
  KEYCLOAK_UNAVAILABLE: 503,
  KEYCLOAK_REJECTED: 500,
  KEYCLOAK_NOT_FOUND: 404,
  KEYCLOAK_CONFLICT: 409,
  SOD_VIOLATION: 403,
  CVSS_VECTOR_SCORE_MISMATCH: 422,
  INTERNAL: 500,
};

describe('error-code registry', () => {
  it.each(Object.entries(EXPECTED_STATUS))('maps %s to HTTP %i', (code, status) => {
    expect(isErrorCode(code)).toBe(true);
    if (!isErrorCode(code)) return;
    expect(ERROR_CODES[code].status).toBe(status);
    expect(httpStatusFor(code)).toBe(status);
  });

  it('is exhaustive: every registered code is in the table and every table entry is registered', () => {
    expect([...ERROR_CODE_LIST].sort()).toEqual(Object.keys(EXPECTED_STATUS).sort());
    expect(ERROR_CODE_LIST).toHaveLength(134);
  });

  it('has unique codes, unique problem type URIs and stable SCREAMING_SNAKE_CASE keys', () => {
    expect(new Set(ERROR_CODE_LIST).size).toBe(ERROR_CODE_LIST.length);
    expect(new Set(ERROR_CODE_LIST.map((code) => problemTypeFor(code))).size).toBe(
      ERROR_CODE_LIST.length,
    );
    for (const code of ERROR_CODE_LIST) expect(code).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
  });

  it('gives every code an error status, a non-empty English title and a retry default', () => {
    for (const code of ERROR_CODE_LIST) {
      const spec = ERROR_CODES[code];
      expect(Number.isInteger(spec.status)).toBe(true);
      expect(spec.status).toBeGreaterThanOrEqual(400);
      expect(spec.status).toBeLessThanOrEqual(599);
      expect(spec.title).toMatch(/^[A-Z][A-Za-z ]+$/);
      expect(typeof spec.retryable).toBe('boolean');
    }
    expect(new Set(ERROR_CODE_LIST.map((code) => ERROR_CODES[code].title)).size).toBe(
      ERROR_CODE_LIST.length,
    );
  });

  it('marks only RATE_LIMITED, TX_RETRY_EXHAUSTED, TEMPORAL_UNAVAILABLE, DB_UNAVAILABLE, DB_SERIALIZATION_CONFLICT, SBX_DRIVER_UNAVAILABLE, KEK_UNAVAILABLE, EXTERNAL_BACKEND_UNAVAILABLE, GRAPH_POOL_TIMEOUT, GRAPH_MIGRATION_LOCKED, GRAPH_QUERY_UNAVAILABLE, KEYCLOAK_UNAVAILABLE and AUTHZ_SIGNER_UNAVAILABLE as retryable', () => {
    expect(ERROR_CODE_LIST.filter((code) => ERROR_CODES[code].retryable)).toEqual([
      'RATE_LIMITED',
      'TX_RETRY_EXHAUSTED',
      'TEMPORAL_UNAVAILABLE',
      'DB_UNAVAILABLE',
      'DB_SERIALIZATION_CONFLICT',
      'SBX_DRIVER_UNAVAILABLE',
      'KEK_UNAVAILABLE',
      'EXTERNAL_BACKEND_UNAVAILABLE',
      'GRAPH_POOL_TIMEOUT',
      'GRAPH_MIGRATION_LOCKED',
      'GRAPH_QUERY_UNAVAILABLE',
      'KEYCLOAK_UNAVAILABLE',
      'AUTHZ_SIGNER_UNAVAILABLE',
    ]);
  });

  it('fails closed on a missing tenant context: 403 and not retryable', () => {
    expect(ERROR_CODES.TENANT_CONTEXT_MISSING).toEqual({
      status: 403,
      title: 'Tenant context missing',
      retryable: false,
    });
  });

  it('is frozen at every level', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(ERROR_CODE_LIST)).toBe(true);
    for (const code of ERROR_CODE_LIST) expect(Object.isFrozen(ERROR_CODES[code])).toBe(true);
    // ES modules run in strict mode, so writes to frozen objects throw instead of failing silently.
    expect(() => {
      (ERROR_CODES as unknown as Record<string, unknown>).NEW_CODE = {
        status: 200,
        title: 'OK',
        retryable: false,
      };
    }).toThrow(TypeError);
    expect(() => {
      (ERROR_CODES.NOT_FOUND as { status: number }).status = 200;
    }).toThrow(TypeError);
    expect(() => {
      (ERROR_CODE_LIST as ErrorCode[]).push('INTERNAL');
    }).toThrow(TypeError);
    expect(ERROR_CODES.NOT_FOUND.status).toBe(404);
  });

  it('builds problem type URIs as https://errors.blackwing.dev/<code>', () => {
    expect(PROBLEM_TYPE_BASE).toBe('https://errors.blackwing.dev/');
    expect(problemTypeFor('NOT_FOUND')).toBe('https://errors.blackwing.dev/NOT_FOUND');
    for (const code of ERROR_CODE_LIST)
      expect(new URL(problemTypeFor(code)).protocol).toBe('https:');
  });

  it('recognises registered codes only, never prototype members or non-strings', () => {
    for (const value of [
      'toString',
      'constructor',
      '__proto__',
      'hasOwnProperty',
      'not_found',
      '',
      ' NOT_FOUND',
    ]) {
      expect(isErrorCode(value)).toBe(false);
    }
    for (const value of [undefined, null, 404, {}, [], Symbol('NOT_FOUND')])
      expect(isErrorCode(value)).toBe(false);
  });

  it('derives the union type and literal statuses from the one registry object', () => {
    expectTypeOf<ErrorCode>().toEqualTypeOf<
      | 'VALIDATION_FAILED'
      | 'INVALID_CURSOR'
      | 'INVALID_QUERY'
      | 'UNAUTHENTICATED'
      | 'AUTH_NO_CREDENTIALS'
      | 'AUTH_INVALID_TOKEN'
      | 'AUTH_EXPIRED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'PRECONDITION_FAILED'
      | 'PRECONDITION_REQUIRED'
      | 'RATE_LIMITED'
      | 'ILLEGAL_RUN_TRANSITION'
      | 'EVIDENCE_INTEGRITY_FAILED'
      | 'GATE1_NOT_PENDING'
      | 'GATE1_PLAN_STALE'
      | 'GATE1_EXPIRED'
      | 'TENANT_CONTEXT_MISSING'
      | 'CROSS_TENANT_DENIED'
      | 'TENANT_CONTEXT_CONFLICT'
      | 'TX_RETRY_EXHAUSTED'
      | 'MISSING_TENANT_CONTEXT'
      | 'INVALID_TENANT_CONTEXT'
      | 'TENANT_CONTEXT_MISMATCH'
      | 'KILL_SWITCH_ACTIVE'
      | 'SCOPE_VIOLATION'
      | 'SCOPE_INTRUSIVENESS_EXCEEDS_CEILING'
      | 'SCOPE_DESTRUCTIVE_FORBIDDEN'
      | 'SCOPE_INVALID_CLASS'
      | 'SCOPE_INVALID_BUDGET'
      | 'SCOPE_INVALID_RULE'
      | 'INVALID_SECRET_REF'
      | 'PLAN_NOT_FOUND'
      | 'TEST_CASE_NOT_FOUND'
      | 'PLAN_VERSION_IMMUTABLE'
      | 'ETAG_MISMATCH'
      | 'PLAN_PAYLOAD_TOO_LARGE'
      | 'SCOPE_BUDGET_EXCEEDS_SA'
      | 'AUTHZ_ILLEGAL_TRANSITION'
      | 'AUTHZ_INVALID_WINDOW'
      | 'AUTHZ_NOT_DRAFT'
      | 'AUTHZ_ASSET_UNVERIFIED'
      | 'AUTHZ_SOD_VIOLATION'
      | 'AUTHZ_STEPUP_REQUIRED'
      | 'ASSET_STALE_WRITE'
      | 'ASSET_IN_USE'
      | 'ASSET_INVALID_IDENTIFIER'
      | 'PERSONA_UNKNOWN'
      | 'PERSONA_NOT_DEFINED'
      | 'PERSONA_FORBIDDEN_TOOL'
      | 'PERSONA_INVALID'
      | 'OVERRIDE_FIELD_FORBIDDEN'
      | 'MODEL_NOT_ALLOWED'
      | 'PROMPT_INVALID'
      | 'PROMPT_HASH_MISMATCH'
      | 'AAD_MISMATCH'
      | 'SECRET_TOO_LARGE'
      | 'KEK_DISABLED'
      | 'ENVELOPE_INVALID'
      | 'SECRET_DECRYPT_FAILED'
      | 'SECRET_VERSION_RETIRED'
      | 'PROMPT_NO_RELEASED_VERSION'
      | 'PROMPT_DRAFT_FORBIDDEN'
      | 'PROMPT_PLACEHOLDER_MISSING'
      | 'PROMPT_TOO_LARGE'
      | 'AGENT_BRIEF_TOO_LARGE'
      | 'AGENT_UNKNOWN_PERSONA'
      | 'AGENT_FORBIDDEN_PERMISSION_MODE'
      | 'AGENT_NO_VIRTUAL_KEY'
      | 'AGENT_MCP_SERVER_MISSING'
      | 'AGENT_BUDGET_EXHAUSTED'
      | 'CONFIG_INVALID'
      | 'TEMPORAL_CONFIG_INVALID'
      | 'TEMPORAL_TLS_MISCONFIGURED'
      | 'TEMPORAL_NAMESPACE_NOT_FOUND'
      | 'TEMPORAL_UNAVAILABLE'
      | 'DB_UNAVAILABLE'
      | 'DB_QUERY_TIMEOUT'
      | 'DB_SERIALIZATION_CONFLICT'
      | 'WORKER_QUEUE_UNKNOWN'
      | 'SEARCH_ATTR_TYPE_CONFLICT'
      | 'SBX_UNAUTHENTICATED'
      | 'SBX_BAD_REQUEST'
      | 'SBX_CONFIG_INVALID'
      | 'SBX_DRIVER_UNAVAILABLE'
      | 'SBX_RUNTIME_MISSING'
      | 'SBX_IMAGE_MISSING'
      | 'KILL_SCOPE_INVALID'
      | 'KILL_REF_REQUIRED'
      | 'KILL_FORBIDDEN'
      | 'SEED_FORBIDDEN_IN_PROD'
      | 'KILL_GLOBAL_NOT_ALLOWED_HERE'
      | 'NOT_OPERATOR'
      | 'OPERATOR_MFA_REQUIRED'
      | 'KILL_ALREADY_IN_PROGRESS'
      | 'KILL_PARTIAL'
      | 'IDEMPOTENCY_KEY_REQUIRED'
      | 'IDEMPOTENCY_KEY_MISMATCH'
      | 'SIGNUP_TOKEN_INVALID'
      | 'GATE2_NO_ONCALL_CONFIGURED'
      | 'GATE2_NO_ELIGIBLE_APPROVER'
      | 'NOT_IMPLEMENTED'
      | 'RUN_NOT_ACTIVE'
      | 'INVALID_TRANSITION'
      | 'RUN_NOT_FOUND'
      | 'AUDIT_EVENT_INVALID'
      | 'KEK_UNAVAILABLE'
      | 'SERVICE_AUTH_FAILED'
      | 'TENANT_MISMATCH'
      | 'SECRET_PURPOSE_DENIED'
      | 'SECRET_NOT_FOUND'
      | 'SECRET_DISABLED'
      | 'SECRET_SHREDDED'
      | 'RUN_KILLED'
      | 'EXTERNAL_BACKEND_UNAVAILABLE'
      | 'GRAPH_CONFIG_MISSING'
      | 'GRAPH_POOL_TIMEOUT'
      | 'GRAPH_MIGRATION_DRIFT'
      | 'GRAPH_MIGRATION_LOCKED'
      | 'GRAPH_MIGRATION_INVALID'
      | 'GRAPH_NO_TENANT_CONTEXT'
      | 'GRAPH_TENANT_MISMATCH'
      | 'GRAPH_UNSCOPED_QUERY'
      | 'GRAPH_QUERY_FAILED'
      | 'GRAPH_QUERY_UNAVAILABLE'
      | 'KEYCLOAK_UNAVAILABLE'
      | 'KEYCLOAK_REJECTED'
      | 'KEYCLOAK_NOT_FOUND'
      | 'KEYCLOAK_CONFLICT'
      | 'SOD_VIOLATION'
      | 'CVSS_VECTOR_SCORE_MISMATCH'
      | 'AUTHZ_SIGNER_UNAVAILABLE'
      | 'INTERNAL'
    >();
    expectTypeOf<HttpStatusOf<'NOT_FOUND'>>().toEqualTypeOf<404>();
    expectTypeOf<HttpStatusOf<'KILL_SWITCH_ACTIVE'>>().toEqualTypeOf<423>();
    expectTypeOf(httpStatusFor('RATE_LIMITED')).toEqualTypeOf<429>();
  });
});
