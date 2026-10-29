import { describe, expect, it } from 'vitest';

import { AppError, isAppError, ERROR_CODES } from '@blackwing/errors';

import {
  SOD_VIOLATION_LOG_MESSAGE,
  SOD_VIOLATION_METRIC,
  SOD_VIOLATION_METRIC_LABELS,
  SOD_VIOLATION_REASONS,
  SodViolationError,
} from './index.js';

describe('SodViolationError', () => {
  it('is the typed AppError with the single stable SOD_VIOLATION code and HTTP 403', () => {
    const err = new SodViolationError('requester_equals_approver', 'sa.approve');
    expect(err).toBeInstanceOf(AppError);
    expect(isAppError(err)).toBe(true);
    expect(err.code).toBe('SOD_VIOLATION');
    expect(err.httpStatus).toBe(403);
    expect(err.httpStatus).toBe(ERROR_CODES.SOD_VIOLATION.status);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('SodViolationError');
  });

  it('carries the reason discriminator and the context', () => {
    const err = new SodViolationError('insufficient_approvers', 'gate2.decide');
    expect(err.reason).toBe('insufficient_approvers');
    expect(err.context).toBe('gate2.decide');
  });

  it('exposes exactly the four reasons from the contract', () => {
    expect([...SOD_VIOLATION_REASONS].sort()).toEqual(
      [
        'ineligible_approver',
        'insufficient_approvers',
        'null_actor',
        'requester_equals_approver',
      ].sort(),
    );
  });

  it('keeps user ids out of the client-facing detail and the wire form', () => {
    const err = new SodViolationError('requester_equals_approver', 'sa.approve');
    expect(err.detail).not.toMatch(/usr_|0190/);
    expect(JSON.stringify(err)).not.toMatch(/usr_|0190/);
    expect(err.toJSON()).toEqual({
      name: 'SodViolationError',
      code: 'SOD_VIOLATION',
      httpStatus: 403,
      retryable: false,
    });
  });

  it('exports the log message and metric names the consumers rely on', () => {
    expect(SOD_VIOLATION_LOG_MESSAGE).toBe('sod.violation');
    expect(SOD_VIOLATION_METRIC).toBe('sod_violations_total');
    expect(SOD_VIOLATION_METRIC_LABELS).toEqual(['context', 'reason']);
  });
});
