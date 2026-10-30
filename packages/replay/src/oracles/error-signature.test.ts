import { describe, expect, it } from 'vitest';

import { evaluateErrorSignatureBinding } from './error-signature.js';
import { exchange, header, observation } from './fixtures.js';

const PARAMS = { signature: 'SQLSTATE[42000]' };

describe('evaluateErrorSignatureBinding', () => {
  it('fires and names the signature when a declared error appears in the body', () => {
    expect(
      evaluateErrorSignatureBinding(
        observation([exchange({ status: 500, body: 'Error: SQLSTATE[42000] syntax' })]),
        PARAMS,
      ),
    ).toEqual({ matched: true, signature: 'SQLSTATE[42000]', reason: 'error_signature_present' });
  });

  it('is case-sensitive, so a differently cased signature does not fire', () => {
    expect(
      evaluateErrorSignatureBinding(observation([exchange({ body: 'sqlstate[42000]' })]), PARAMS),
    ).toEqual({ matched: false, reason: 'error_signature_absent' });
  });

  it('checks header values when the scope is header', () => {
    const params = { signature: 'PHP/8.1', scope: 'header' } as const;
    expect(
      evaluateErrorSignatureBinding(
        observation([exchange({ headers: [header('x-powered-by', 'PHP/8.1')] })]),
        params,
      ).matched,
    ).toBe(true);
    expect(
      evaluateErrorSignatureBinding(observation([exchange({ body: 'PHP/8.1' })]), params).matched,
    ).toBe(false);
  });

  it('returns no_observation when nothing was observed or headers were not captured', () => {
    expect(evaluateErrorSignatureBinding(observation([]), PARAMS)).toEqual({
      matched: false,
      reason: 'no_observation',
    });
    expect(
      evaluateErrorSignatureBinding(observation([exchange({ status: null })]), PARAMS),
    ).toEqual({ matched: false, reason: 'no_observation' });
    expect(
      evaluateErrorSignatureBinding(observation([exchange()]), { signature: 'x', scope: 'header' }),
    ).toEqual({ matched: false, reason: 'no_observation' });
  });

  it('refuses malformed params without firing', () => {
    expect(
      evaluateErrorSignatureBinding(observation([exchange({ body: 'SQLSTATE' })]), {
        signature: 'SQLSTATE',
        matchIn: 'body',
      }),
    ).toEqual({ matched: false, reason: 'invalid_params' });
  });
});
