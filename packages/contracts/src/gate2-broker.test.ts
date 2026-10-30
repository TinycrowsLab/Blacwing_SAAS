import { describe, expect, it } from 'vitest';

import { BROKER_SCOPES } from './broker.js';
import {
  brokerGate2ExceptionRequestSchema,
  brokerGate2ExceptionResponseSchema,
  GATE2_ACTION_SUMMARY_INPUT_MAX,
  GATE2_ACTION_SUMMARY_MAX,
  GATE2_EXCEPTION_RAISED_SIGNAL,
} from './gate2.js';

const SESSION_ID = '01890000-0000-7000-8000-000000000001';

const VALID = {
  sessionId: SESSION_ID,
  toolName: 'nmap.scan',
  proposedActionSummary: '{"target":"10.0.0.9"}',
  envelopeReason: 'target outside the approved envelope',
  intrusiveness: 'active_safe',
};

describe('brokerGate2ExceptionRequestSchema', () => {
  it('accepts the deferred call and defaults batch to false', () => {
    const parsed = brokerGate2ExceptionRequestSchema.parse(VALID);
    expect(parsed.batch).toBe(false);
    expect(parsed.subtaskId).toBeUndefined();
  });

  it('accepts a batch flag and the optional subtask and test case', () => {
    const parsed = brokerGate2ExceptionRequestSchema.parse({
      ...VALID,
      batch: true,
      subtaskId: '01890000-0000-7000-8000-0000000000aa',
      testCaseId: null,
    });
    expect(parsed.batch).toBe(true);
    expect(parsed.testCaseId).toBeNull();
  });

  it.each([
    ['an unknown field', { ...VALID, tenantId: SESSION_ID }],
    ['a run id in the body', { ...VALID, runId: SESSION_ID }],
    ['an unknown intrusiveness class', { ...VALID, intrusiveness: 'yolo' }],
    ['an empty tool name', { ...VALID, toolName: '' }],
    ['an empty session id', { ...VALID, sessionId: '' }],
    ['a non-uuid subtask id', { ...VALID, subtaskId: 'not-a-uuid' }],
    ['a missing envelope reason', { ...VALID, envelopeReason: undefined }],
    ['a non-boolean batch', { ...VALID, batch: 'yes' }],
  ])('refuses %s', (_name, input) => {
    expect(brokerGate2ExceptionRequestSchema.safeParse(input).success).toBe(false);
  });

  it('accepts a summary up to the input limit and refuses one above it', () => {
    expect(
      brokerGate2ExceptionRequestSchema.safeParse({
        ...VALID,
        proposedActionSummary: 'x'.repeat(GATE2_ACTION_SUMMARY_INPUT_MAX),
      }).success,
    ).toBe(true);
    expect(
      brokerGate2ExceptionRequestSchema.safeParse({
        ...VALID,
        proposedActionSummary: 'x'.repeat(GATE2_ACTION_SUMMARY_INPUT_MAX + 1),
      }).success,
    ).toBe(false);
  });
});

describe('brokerGate2ExceptionResponseSchema', () => {
  it('answers the exception id and its state', () => {
    expect(
      brokerGate2ExceptionResponseSchema.parse({ exceptionId: SESSION_ID, state: 'pending' }),
    ).toEqual({ exceptionId: SESSION_ID, state: 'pending' });
  });

  it('refuses an unknown state and extra fields', () => {
    expect(
      brokerGate2ExceptionResponseSchema.safeParse({ exceptionId: SESSION_ID, state: 'allowed' })
        .success,
    ).toBe(false);
    expect(
      brokerGate2ExceptionResponseSchema.safeParse({
        exceptionId: SESSION_ID,
        state: 'pending',
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('Gate 2 broker constants', () => {
  it('pins the summary cap at 4 KiB and the signal name the workflow handles', () => {
    expect(GATE2_ACTION_SUMMARY_MAX).toBe(4096);
    expect(GATE2_EXCEPTION_RAISED_SIGNAL).toBe('gate2ExceptionRaised');
  });

  it('grants the gate2 scope to broker tokens', () => {
    expect(BROKER_SCOPES).toContain('gate2:write');
  });
});
