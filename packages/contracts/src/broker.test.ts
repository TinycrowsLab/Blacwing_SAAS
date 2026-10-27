import { describe, expect, it } from 'vitest';

import {
  BROKER_SCOPES,
  BROKER_TOKEN_PREFIX,
  brokerCandidateRequestSchema,
  brokerJournalRequestSchema,
  brokerTokenClaimsSchema,
  brokerToolAuditRequestSchema,
} from './index.js';

const ID = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('broker contracts', () => {
  it('uses the bwrun_ prefix and five scopes', () => {
    expect(BROKER_TOKEN_PREFIX).toBe('bwrun_');
    expect(BROKER_SCOPES).toHaveLength(5);
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
});
