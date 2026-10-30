import { describe, expect, it } from 'vitest';

import {
  BROKER_SCOPES,
  BROKER_TOKEN_PREFIX,
  brokerCandidateRequestSchema,
  brokerJournalRequestSchema,
  brokerPdpDecisionSchema,
  brokerPdpEvaluateRequestSchema,
  brokerTokenClaimsSchema,
  brokerToolAuditRequestSchema,
  PDP_TARGETS_MAX,
} from './index.js';

const ID = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('broker contracts', () => {
  it('uses the bwrun_ prefix and eight scopes, including the engagement pair and pdp:evaluate', () => {
    expect(BROKER_TOKEN_PREFIX).toBe('bwrun_');
    expect(BROKER_SCOPES).toHaveLength(8);
    expect(BROKER_SCOPES).toEqual(expect.arrayContaining(['engagement:read', 'engagement:write']));
  });

  it('rejects unknown fields and applies defaults', () => {
    const extra = { title: 't', vulnClass: 'xss', x: 1 };
    expect(brokerCandidateRequestSchema.safeParse(extra).success).toBe(false);
    expect(
      brokerCandidateRequestSchema.parse({ title: 't', vulnClass: 'xss' }).evidenceIds,
    ).toEqual([]);
  });

  it('rejects a journal entry with an unknown intrusiveness class', () => {
    const entry = { phase: 'planned', action: 'a', reversal: 'r', targetRef: 't' };
    const bad = { ...entry, intrusiveness: 'bogus' };
    expect(brokerJournalRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('requires an audience-bound, scoped claim set', () => {
    const claims = {
      v: 1,
      aud: 'run-broker',
      jti: ID,
      tid: ID,
      rid: ID,
      sid: ID,
      scp: ['state:read'],
      iat: 1,
      exp: 2,
    };
    expect(brokerTokenClaimsSchema.safeParse(claims).success).toBe(true);
    expect(
      brokerTokenClaimsSchema.safeParse({ ...claims, aud: 'sandbox-controller' }).success,
    ).toBe(false);
    expect(brokerTokenClaimsSchema.safeParse({ ...claims, scp: [] }).success).toBe(false);
  });

  describe('tool audit request', () => {
    const audit = {
      toolName: 'mcp__target__http_request',
      subtaskId: ID,
      testCaseId: null,
      roleId: 'recon',
      durationMs: 5,
      outputBytes: 10,
      outcome: 'success',
      code: null,
      inputSummary: '{}',
    };

    it('accepts a well-formed event and rejects unknown fields, bad names and long summaries', () => {
      expect(brokerToolAuditRequestSchema.safeParse(audit).success).toBe(true);
      expect(brokerToolAuditRequestSchema.safeParse({ ...audit, extra: 1 }).success).toBe(false);
      expect(
        brokerToolAuditRequestSchema.safeParse({ ...audit, toolName: 'http_request' }).success,
      ).toBe(false);
      expect(
        brokerToolAuditRequestSchema.safeParse({ ...audit, inputSummary: 'x'.repeat(1025) })
          .success,
      ).toBe(false);
    });
  });

  describe('PDP evaluate (RUNTIME-005)', () => {
    const pdpRequest = {
      toolName: 'Bash',
      toolUseId: 'toolu_1',
      targets: ['https://lab.example.test/login'],
      subtaskId: null,
      testCaseId: null,
      roleId: null,
    };

    it('accepts a call with ids and targets', () => {
      expect(brokerPdpEvaluateRequestSchema.safeParse(pdpRequest).success).toBe(true);
    });

    it('rejects unknown fields, so the call input can never ride along', () => {
      const withInput = { ...pdpRequest, input: { command: 'id' } };
      expect(brokerPdpEvaluateRequestSchema.safeParse(withInput).success).toBe(false);
    });

    it('bounds the target list', () => {
      const tooMany = Array.from({ length: PDP_TARGETS_MAX + 1 }, () => 'a.test');
      expect(
        brokerPdpEvaluateRequestSchema.safeParse({ ...pdpRequest, targets: tooMany }).success,
      ).toBe(false);
      expect(
        brokerPdpEvaluateRequestSchema.safeParse({
          ...pdpRequest,
          targets: tooMany.slice(0, PDP_TARGETS_MAX),
        }).success,
      ).toBe(true);
    });

    it('rejects an empty tool name and a non-uuid subtask', () => {
      expect(
        brokerPdpEvaluateRequestSchema.safeParse({ ...pdpRequest, toolName: '' }).success,
      ).toBe(false);
      expect(
        brokerPdpEvaluateRequestSchema.safeParse({ ...pdpRequest, subtaskId: 'x' }).success,
      ).toBe(false);
    });

    it('accepts only allow or deny, with a stable reason', () => {
      expect(brokerPdpDecisionSchema.parse({ decision: 'allow', reason: 'in_envelope' })).toEqual({
        decision: 'allow',
        reason: 'in_envelope',
      });
      expect(
        brokerPdpDecisionSchema.safeParse({ decision: 'defer', reason: 'in_envelope' }).success,
      ).toBe(false);
      expect(
        brokerPdpDecisionSchema.safeParse({ decision: 'deny', reason: 'free text' }).success,
      ).toBe(false);
    });
  });
});
