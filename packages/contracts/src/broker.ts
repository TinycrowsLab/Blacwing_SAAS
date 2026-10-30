import { z } from 'zod';

import { findingLocationSchema } from './entities/finding.js';
import { runStateSchema } from './entities/run.js';
import { oracleSchema } from './entities/test-case.js';
import { intrusivenessClassSchema } from './intrusiveness.js';
import { LIMITS } from './limits.js';
import { cweIdSchema, isoDateTimeSchema, sha256HexSchema, uuidV7Schema } from './primitives.js';
import { EVIDENCE_OBJECT_BYTES_MAX } from './validation/evidence.js';

/**
 * Contracts of the internal Run Broker API (API-014, #66; CONTEXT_PACK §4.1/§9). The broker is reachable
 * only from the sandbox run network and authenticated with short-lived run-scoped tokens. It is not part
 * of the public OpenAPI document.
 */

/** Mount point of the broker; physically separate from `/v1`. */
export const BROKER_BASE_PATH = '/internal/broker';

/** Wire prefix of a run-scoped broker token: `Authorization: Bearer bwrun_<payload>.<signature>`. */
export const BROKER_TOKEN_PREFIX = 'bwrun_';

/** `aud` claim: binds a token to the Run Broker so it cannot drive another internal service. */
export const BROKER_TOKEN_AUDIENCE = 'run-broker';

/** Longest lifetime (exp - iat) the broker accepts: tokens are short-lived by contract. */
export const BROKER_TOKEN_MAX_TTL_SECONDS = 3600;

const URL_MAX = 2048;
const TEXT_MAX = 8192;
const ACTION_MAX = 2048;
const REVERSAL_MAX = 4096;
const CONTENT_TYPE_MAX = 255;
const EVIDENCE_IDS_MAX = 50;
/** Longest redacted tool-input summary a `tool.invoked` event carries. */
export const TOOL_AUDIT_SUMMARY_MAX = 1024;

/** What a token may do. Each stub endpoint requires exactly one scope. */
export const BROKER_SCOPES = [
  'audit:write',
  'candidates:write',
  'engagement:read',
  'engagement:write',
  'evidence:write',
  'gate2:write',
  'journal:write',
  'pdp:evaluate',
  'state:read',
] as const;
export const brokerScopeSchema = z.enum(BROKER_SCOPES);
export type BrokerScope = z.infer<typeof brokerScopeSchema>;

/** Claims of the signed token payload (compact names, like the other run tokens). */
export const brokerTokenClaimsSchema = z.strictObject({
  v: z.literal(1),
  aud: z.literal(BROKER_TOKEN_AUDIENCE),
  /** Token id; the revocation key. */
  jti: uuidV7Schema,
  tid: uuidV7Schema,
  rid: uuidV7Schema,
  sid: uuidV7Schema,
  scp: z.array(brokerScopeSchema).min(1).max(BROKER_SCOPES.length),
  iat: z.int().nonnegative(),
  exp: z.int().positive(),
});
export type BrokerTokenClaims = z.infer<typeof brokerTokenClaimsSchema>;

/** The authenticated caller of a broker request. Never carries the token itself (§8.7). */
export const brokerPrincipalSchema = z.strictObject({
  tokenId: uuidV7Schema,
  tenantId: uuidV7Schema,
  runId: uuidV7Schema,
  sessionId: uuidV7Schema,
  scopes: z.array(brokerScopeSchema).readonly(),
  /** Unix seconds. */
  expiresAt: z.int().positive(),
});
export type BrokerPrincipal = z.infer<typeof brokerPrincipalSchema>;

/**
 * Ids a body may repeat. They are never trusted: a value that differs from the token's is refused with
 * `403` (cross-run / cross-tenant), and never reveals whether the other run exists.
 */
const boundIdsShape = {
  runId: uuidV7Schema.optional(),
  tenantId: uuidV7Schema.optional(),
} as const;

/** `POST /internal/broker/runs/{runId}/candidates` (FINDING/VALIDATE implements). */
export const brokerCandidateRequestSchema = z.strictObject({
  ...boundIdsShape,
  title: z.string().min(1).max(LIMITS.labelMax),
  vulnClass: z.string().min(1).max(LIMITS.labelMax),
  assetRef: z.string().min(1).max(URL_MAX).optional(),
  summary: z.string().max(TEXT_MAX).optional(),
  evidenceIds: z.array(uuidV7Schema).max(EVIDENCE_IDS_MAX).default([]),
  /**
   * Set by `mcp__findings__submit_candidate` (MCP-009): the candidate is bound to the test case's
   * pre-declared oracle and negative control. There is deliberately no status field: a broker candidate is
   * always created as `candidate` (§8.11).
   */
  testCaseId: uuidV7Schema.optional(),
  cweId: cweIdSchema.optional(),
  owaspCategory: z.string().min(1).max(LIMITS.shortTextMax).optional(),
  location: findingLocationSchema.optional(),
  oracleBinding: oracleSchema.optional(),
  negativeControlRef: z.string().min(1).max(LIMITS.keyMax).optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** sha256 over `(testCaseId, location, oracleBinding)`; a repeat submission returns the same finding. */
  idempotencyKey: sha256HexSchema.optional(),
});
export type BrokerCandidateRequest = z.infer<typeof brokerCandidateRequestSchema>;

/** Answer of `POST .../candidates`: the finding id; the status can only be `candidate`. */
export const brokerCandidateResponseSchema = z.strictObject({
  findingId: uuidV7Schema,
  status: z.literal('candidate'),
});
export type BrokerCandidateResponse = z.infer<typeof brokerCandidateResponseSchema>;

/** `POST /internal/broker/runs/{runId}/evidence`: metadata only, never the evidence bytes (EVIDENCE implements). */
export const brokerEvidenceRequestSchema = z.strictObject({
  ...boundIdsShape,
  kind: z.enum(['http_exchange', 'screenshot', 'log', 'file', 'other']),
  sha256: sha256HexSchema,
  sizeBytes: z.int().nonnegative().max(EVIDENCE_OBJECT_BYTES_MAX),
  contentType: z.string().min(1).max(CONTENT_TYPE_MAX),
  description: z.string().max(ACTION_MAX).optional(),
});
export type BrokerEvidenceRequest = z.infer<typeof brokerEvidenceRequestSchema>;

/** `POST /internal/broker/runs/{runId}/journal`: a reversal-journal entry (REVERSAL implements). */
export const brokerJournalRequestSchema = z.strictObject({
  ...boundIdsShape,
  phase: z.enum(['planned', 'applied', 'reversed']),
  intrusiveness: intrusivenessClassSchema,
  action: z.string().min(1).max(ACTION_MAX),
  reversal: z.string().min(1).max(REVERSAL_MAX),
  targetRef: z.string().min(1).max(URL_MAX),
});
export type BrokerJournalRequest = z.infer<typeof brokerJournalRequestSchema>;

/**
 * `POST /internal/broker/runs/{runId}/tool-audit`: one `tool.invoked` event per MCP tool call (MCP-001, #666;
 * §8.8). The input summary is already redacted by the caller; the tenant, run and session come from the
 * token, never from the body. `subtaskId` / `testCaseId` are null for calls outside a test case.
 */
export const brokerToolAuditRequestSchema = z.strictObject({
  ...boundIdsShape,
  /** Surfaced name, `mcp__<server>__<tool>`. */
  toolName: z
    .string()
    .regex(/^mcp__[a-z][a-z0-9_]*__[a-z][a-z0-9_]*$/)
    .max(LIMITS.keyMax * 2),
  subtaskId: uuidV7Schema.nullable(),
  testCaseId: uuidV7Schema.nullable(),
  roleId: z.string().min(1).max(LIMITS.keyMax),
  durationMs: z.int().nonnegative(),
  outputBytes: z.int().nonnegative(),
  outcome: z.enum(['success', 'error']),
  /** Stable tool error code when `outcome` is `error`. */
  code: z.string().min(1).max(LIMITS.keyMax).nullable(),
  /** Redacted, bounded rendering of the call input. */
  inputSummary: z.string().max(TOOL_AUDIT_SUMMARY_MAX),
});
export type BrokerToolAuditRequest = z.infer<typeof brokerToolAuditRequestSchema>;

/** Most targets one PDP call carries. A call with more is refused, so the decision stays small and bounded. */
export const PDP_TARGETS_MAX = 16;
const PDP_NAME_MAX = 256;

/**
 * Decisions the PreToolUse PDP returns. `exception` is an out-of-envelope call a human may still approve through
 * Gate 2 (RUNTIME-006, #468). The hook turns it into `defer` for a single call, or `deny` for a batch.
 */
const PDP_DECISIONS = ['allow', 'deny', 'exception'] as const;
export type PdpDecisionValue = (typeof PDP_DECISIONS)[number];

/**
 * Why the PDP decided. Stable codes that metrics and audit use as labels. The hook adds the fail-closed codes
 * (`invalid_input`, `target_unresolved`, `pdp_unavailable`, `pdp_timeout`) when it denies without an answer.
 */
const PDP_REASONS = [
  'in_envelope',
  'no_envelope',
  'envelope_not_yet_valid',
  'envelope_expired',
  'envelope_revoked',
  'out_of_scope',
  'intrusiveness_exceeds_envelope',
  'destructive_class',
  'state_change_without_journal',
  'invalid_input',
  'target_unresolved',
  'pdp_unavailable',
  'pdp_timeout',
  'batch_out_of_envelope_paused',
  'gate2_exception_unavailable',
  'gate2_denied',
  'gate2_resume_required',
  'gate2_approved_once',
] as const;
export type PdpReason = (typeof PDP_REASONS)[number];

/**
 * `POST /internal/broker/runs/{runId}/pdp/evaluate` (RUNTIME-005, #467): one PreToolUse decision. The request
 * carries ids and the targets the call names, never the call's input. The envelope, scope and journal facts
 * come from the broker, not from the caller, so the model's claim about scope is never trusted.
 */
export const brokerPdpEvaluateRequestSchema = z.strictObject({
  ...boundIdsShape,
  toolName: z.string().min(1).max(PDP_NAME_MAX),
  toolUseId: z.string().min(1).max(PDP_NAME_MAX),
  targets: z.array(z.string().min(1).max(URL_MAX)).max(PDP_TARGETS_MAX),
  subtaskId: uuidV7Schema.nullable(),
  testCaseId: uuidV7Schema.nullable(),
  roleId: z.string().min(1).max(LIMITS.keyMax).nullable(),
});
export type BrokerPdpEvaluateRequest = z.infer<typeof brokerPdpEvaluateRequestSchema>;

export const brokerPdpDecisionSchema = z.strictObject({
  decision: z.enum(PDP_DECISIONS),
  reason: z.enum(PDP_REASONS),
  /**
   * The intrusiveness class of the exception call. Set on `exception` only: Gate 2 records it, and the request
   * needs it. Absent on `allow` and `deny`.
   */
  intrusiveness: intrusivenessClassSchema.optional(),
});
export type BrokerPdpDecision = z.infer<typeof brokerPdpDecisionSchema>;

/** `GET /internal/broker/runs/{runId}/state` (ORCH implements the full view). */
export const brokerStateResponseSchema = z.strictObject({
  runId: uuidV7Schema,
  state: runStateSchema,
  active: z.boolean(),
  observedAt: isoDateTimeSchema,
});
export type BrokerStateResponse = z.infer<typeof brokerStateResponseSchema>;
