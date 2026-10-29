import { describe, expect, it, vi } from 'vitest';

import {
  attemptFor,
  decisionBody,
  decisionNeedsReason,
  failureOf,
  reasonError,
  sodBannerText,
} from './gate1-model';
import { ApiError, CLIENT_ERROR_CODES } from '../../../../../../lib/api-error';

const GATE1_REASON_LIMIT = 2000;

describe('decisionBody', () => {
  it('sends no reason for an approval without one, and a trimmed reason when given', () => {
    expect(decisionBody('approve', 4, '   ')).toEqual({ decision: 'approve', planVersion: 4 });
    expect(decisionBody('approve', 4, '  looks fine  ')).toEqual({
      decision: 'approve',
      planVersion: 4,
      reason: 'looks fine',
    });
  });
});

describe('reasonError', () => {
  it.each(['request_changes', 'reject'] as const)('requires a reason for %s', (decision) => {
    expect(decisionNeedsReason(decision)).toBe(true);
    expect(reasonError(decision, '')).toBe('Add a reason for this decision.');
    expect(reasonError(decision, '  \n ')).toBe('Add a reason for this decision.');
    expect(reasonError(decision, 'Drop the admin panel.')).toBeNull();
  });

  it('does not require a reason for an approval', () => {
    expect(decisionNeedsReason('approve')).toBe(false);
    expect(reasonError('approve', '')).toBeNull();
  });

  it('refuses a reason over the server limit', () => {
    expect(reasonError('approve', 'x'.repeat(GATE1_REASON_LIMIT + 1))).toMatch(/longer than 2000/);
    expect(reasonError('reject', 'x'.repeat(GATE1_REASON_LIMIT))).toBeNull();
  });
});

describe('attemptFor (idempotent submit)', () => {
  const body = { decision: 'approve' as const, planVersion: 2 };

  it('reuses the key for the same body, so a double submit or a retry is one decision', () => {
    const newKey = vi.fn(() => 'key-1');
    const first = attemptFor(null, body, newKey);
    const again = attemptFor(first, { ...body }, newKey);
    expect(again.key).toBe('key-1');
    expect(newKey).toHaveBeenCalledTimes(1);
  });

  it('issues a new key when the decision itself changes', () => {
    const keys = ['key-1', 'key-2'];
    const newKey = vi.fn(() => keys.shift() ?? 'key-x');
    const first = attemptFor(null, body, newKey);
    const changed = attemptFor(
      first,
      { decision: 'reject', planVersion: 2, reason: 'No.' },
      newKey,
    );
    expect(changed.key).toBe('key-2');
  });
});

describe('sodBannerText', () => {
  it('names the requester and the approver', () => {
    expect(sodBannerText('user-requester', 'user-approver')).toBe(
      'Requester: user-requester, Approver: user-approver',
    );
  });

  it('shows unknown rather than hiding an identity', () => {
    expect(sodBannerText(null, 'user-approver')).toBe(
      'Requester: unknown, Approver: user-approver',
    );
  });
});

describe('failureOf', () => {
  const apiError = (code: string, status: number, traceId?: string) =>
    new ApiError({ status, code, title: 'Title', detail: 'Server detail', traceId });

  it('renders a server SoD refusal and does not offer a retry', () => {
    const failure = failureOf(apiError('SOD_VIOLATION', 403, 'trace-1'));
    expect(failure.message).toMatch(/Separation of duties/);
    expect(failure.retryable).toBe(false);
    expect(failure.refresh).toBe(false);
    expect(failure.traceId).toBe('trace-1');
  });

  it('asks for a reload on a stale plan, a closed run or an expired window', () => {
    for (const code of ['GATE1_PLAN_STALE', 'GATE1_NOT_PENDING', 'GATE1_EXPIRED']) {
      expect(failureOf(apiError(code, 409)).refresh).toBe(true);
    }
  });

  it('keeps a network failure retryable so the retry reuses the same attempt', () => {
    const failure = failureOf(apiError(CLIENT_ERROR_CODES.network, 0));
    expect(failure.retryable).toBe(true);
    expect(failure.message).toMatch(/has not been recorded/);
  });

  it('falls back to the server detail for a code the review does not name', () => {
    expect(failureOf(apiError('SOMETHING_NEW', 500)).message).toBe('Server detail');
  });

  it('treats an unknown error as a refresh, never as a success', () => {
    const failure = failureOf(new Error('boom'));
    expect(failure.code).toBe('UNKNOWN');
    expect(failure.refresh).toBe(true);
    expect(failure.retryable).toBe(false);
  });
});
