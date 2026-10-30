import { describe, expect, it } from 'vitest';

import {
  ACCESS_BODY_WINDOW,
  ACCESS_MATRIX_REASONS,
  ACCESS_MATRIX_VERDICTS,
  type AccessMatrixEvaluationInput,
  classifyAccessResponse,
  evaluateAccessMatrixCell,
} from './classify.js';

/**
 * Recorded responses, as the gateway captures them. Bodies are response fixtures (JSON, HTML and refusal text),
 * never request payloads.
 */
const JSON_LIST = '{"data":[{"id":1,"email":"a@example.test"}]}';
const LOGIN_PAGE = '<html><body>Please log in to continue</body></html>';

describe('classifyAccessResponse', () => {
  it.each([
    ['a 403 refusal', { status: 403, body: 'nope' }, 'deny'],
    ['a 401 without a session', { status: 401 }, 'deny'],
    ['a 302 to /login', { status: 302, location: '/login?next=/api/Users' }, 'deny'],
    [
      'a 303 to an absolute login URL',
      { status: 303, location: 'https://target.example/signin' },
      'deny',
    ],
    ['a 307 to /auth/sso', { status: 307, location: '/auth/sso' }, 'deny'],
    ['a 200 with a data body', { status: 200, body: JSON_LIST }, 'allow'],
    ['a 201 created', { status: 201, body: '{"id":9}' }, 'allow'],
    ['a 302 to an ordinary page', { status: 302, location: '/dashboard' }, 'ambiguous'],
    [
      'a 302 to a path that only starts like login',
      { status: 302, location: '/authorize' },
      'ambiguous',
    ],
    ['a 302 with no location', { status: 302 }, 'ambiguous'],
    [
      'a 404 (not proof of access control)',
      { status: 404, body: '{"error":"not found"}' },
      'ambiguous',
    ],
    ['a 405 method not allowed', { status: 405, body: '' }, 'ambiguous'],
    ['a 500 server error', { status: 500, body: 'boom' }, 'ambiguous'],
    ['a 204 with no body', { status: 204 }, 'ambiguous'],
    ['a 200 with an empty body (soft deny)', { status: 200, body: '' }, 'ambiguous'],
    ['a 200 with a blank body', { status: 200, body: '   \n\t ' }, 'ambiguous'],
    [
      'a 200 that says access denied',
      { status: 200, body: '{"error":"Access denied"}' },
      'ambiguous',
    ],
    ['a 200 that says forbidden', { status: 200, body: 'Forbidden for this role' }, 'ambiguous'],
    [
      'a 200 that says not authorised',
      { status: 200, body: 'You are not authorized' },
      'ambiguous',
    ],
    ['a 200 login page', { status: 200, body: LOGIN_PAGE }, 'ambiguous'],
    ['a 200 with no body field', { status: 200 }, 'ambiguous'],
  ])('classifies %s', (_label, response, outcome) => {
    expect(classifyAccessResponse(response)).toBe(outcome);
  });

  it('inspects only the leading body window, so a long page is classified on its start', () => {
    const padding = 'x'.repeat(ACCESS_BODY_WINDOW);
    expect(classifyAccessResponse({ status: 200, body: `${padding} access denied` })).toBe('allow');
    expect(classifyAccessResponse({ status: 200, body: `access denied ${padding}` })).toBe(
      'ambiguous',
    );
  });

  it('fails closed: a malformed recorded response is ambiguous, never allow', () => {
    expect(classifyAccessResponse(undefined)).toBe('ambiguous');
    expect(classifyAccessResponse(null)).toBe('ambiguous');
    expect(classifyAccessResponse({ status: 99, body: JSON_LIST })).toBe('ambiguous');
    expect(classifyAccessResponse({ status: 600, body: JSON_LIST })).toBe('ambiguous');
    expect(classifyAccessResponse({ status: '200', body: JSON_LIST })).toBe('ambiguous');
    expect(classifyAccessResponse({ status: 200, body: JSON_LIST, headers: { cookie: 'x' } })).toBe(
      'ambiguous',
    );
  });

  it('gives the same outcome for the same recorded input (deterministic, replayable)', () => {
    const response = { status: 200, body: JSON_LIST };
    expect([1, 2, 3].map(() => classifyAccessResponse(response))).toEqual([
      'allow',
      'allow',
      'allow',
    ]);
  });
});

describe('evaluateAccessMatrixCell', () => {
  const base = { sessionStatus: 'live', expected: 'deny', actual: 'deny' } as const;

  it('blocks a comparison whose acting role has no live session', () => {
    for (const sessionStatus of ['expired', 'unavailable'] as const) {
      expect(
        evaluateAccessMatrixCell({ ...base, sessionStatus, actual: 'allow', control: 'allow' }),
      ).toEqual({
        verdict: 'blocked',
        reason: ACCESS_MATRIX_REASONS.sessionNotLive,
      });
    }
  });

  it('reports an undeclared cell as unknown and asserts nothing', () => {
    expect(
      evaluateAccessMatrixCell({ ...base, expected: 'unknown', actual: 'allow', control: 'allow' }),
    ).toEqual({
      verdict: 'unknown',
      reason: ACCESS_MATRIX_REASONS.cellNotDeclared,
    });
  });

  it('makes an ambiguous response Suspected, never a finding', () => {
    expect(evaluateAccessMatrixCell({ ...base, actual: 'ambiguous', control: 'allow' })).toEqual({
      verdict: 'suspected',
      reason: ACCESS_MATRIX_REASONS.ambiguousResponse,
    });
  });

  it('passes when the observed access matches the expectation', () => {
    expect(evaluateAccessMatrixCell({ ...base, expected: 'deny', actual: 'deny' }).verdict).toBe(
      'pass',
    );
    expect(evaluateAccessMatrixCell({ ...base, expected: 'allow', actual: 'allow' }).verdict).toBe(
      'pass',
    );
  });

  it('reports an allowed role that the matrix denies as a violation only with a control that is allowed', () => {
    expect(evaluateAccessMatrixCell({ ...base, actual: 'allow', control: 'allow' })).toEqual({
      verdict: 'violation',
      reason: ACCESS_MATRIX_REASONS.allowedWhereDenied,
    });
  });

  it('never makes a single-role allow a violation: no control, or a control that is also denied, is suspected', () => {
    expect(evaluateAccessMatrixCell({ ...base, actual: 'allow' })).toEqual({
      verdict: 'suspected',
      reason: ACCESS_MATRIX_REASONS.controlMissingOrFailed,
    });
    expect(evaluateAccessMatrixCell({ ...base, actual: 'allow', control: 'deny' }).verdict).toBe(
      'suspected',
    );
    expect(
      evaluateAccessMatrixCell({ ...base, actual: 'allow', control: 'ambiguous' }).verdict,
    ).toBe('suspected');
  });

  it('reports a denied role that the matrix allows as a mismatch, not a security finding', () => {
    expect(
      evaluateAccessMatrixCell({ ...base, expected: 'allow', actual: 'deny', control: 'allow' }),
    ).toEqual({
      verdict: 'mismatch',
      reason: ACCESS_MATRIX_REASONS.deniedWhereAllowed,
    });
  });

  it('gives a verdict from the declared set for every combination', () => {
    const sessions = ['live', 'expired', 'unavailable'] as const;
    const expectations = ['allow', 'deny', 'unknown'] as const;
    const outcomes = ['allow', 'deny', 'ambiguous'] as const;
    const controls = [undefined, 'allow', 'deny', 'ambiguous'] as const;
    for (const sessionStatus of sessions)
      for (const expected of expectations)
        for (const actual of outcomes)
          for (const control of controls) {
            const input: AccessMatrixEvaluationInput = { sessionStatus, expected, actual, control };
            const { verdict } = evaluateAccessMatrixCell(input);
            expect(ACCESS_MATRIX_VERDICTS).toContain(verdict);
          }
  });
});

describe('end-to-end differential on recorded responses', () => {
  it('confirms an IDOR-style differential: the other role reads an object the matrix denies, the owner reads its own', () => {
    const attacker = classifyAccessResponse({ status: 200, body: JSON_LIST });
    const control = classifyAccessResponse({ status: 200, body: JSON_LIST });
    expect(
      evaluateAccessMatrixCell({
        sessionStatus: 'live',
        expected: 'deny',
        actual: attacker,
        control,
      }).verdict,
    ).toBe('violation');
  });

  it('does not confirm a single-role 200 when the control is refused (for example, the endpoint is public)', () => {
    const attacker = classifyAccessResponse({ status: 200, body: JSON_LIST });
    const control = classifyAccessResponse({ status: 403, body: 'nope' });
    expect(
      evaluateAccessMatrixCell({
        sessionStatus: 'live',
        expected: 'deny',
        actual: attacker,
        control,
      }).verdict,
    ).toBe('suspected');
  });

  it('does not confirm a soft deny: a 200 empty body is ambiguous even when the control is allowed', () => {
    const attacker = classifyAccessResponse({ status: 200, body: '' });
    const control = classifyAccessResponse({ status: 200, body: JSON_LIST });
    expect(
      evaluateAccessMatrixCell({
        sessionStatus: 'live',
        expected: 'deny',
        actual: attacker,
        control,
      }).verdict,
    ).toBe('suspected');
  });
});
